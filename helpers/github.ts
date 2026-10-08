import { Octokit } from "@octokit/rest";

// Publishing N files as one commit used to go through
// octokit-commit-multiple-files, which POSTs one git blob per file. That is
// invisible at 2-3 files (the crank's size) and fatal at ~600: the validator
// metrics publisher tripped GitHub's SECONDARY rate limit — a write-throughput
// ceiling, separate from the 5,000/hour core allowance, which was still at
// 4,820 when the run died — after ~180 blob POSTs. The git trees API takes the
// file contents inline instead, so a whole batch costs one POST.
//
// Trees entries also have a documented 100k limit, but request bodies are the
// practical ceiling, so a batch is capped by BYTES as well as count: a
// multi-megabyte tree POST is the kind of thing that starts failing for
// reasons no error message explains.
const MAX_FILES_PER_COMMIT = 200;
const MAX_BYTES_PER_COMMIT = 1_500_000;
// Retry the whole read-ref -> tree -> commit -> update-ref sequence. A
// secondary rate limit is a "wait a few minutes" answer; the retry-after
// header says how long, and ignoring it just burns the next attempt.
const MAX_ATTEMPTS = 4;
const FALLBACK_BACKOFF_MS = 20_000;
const MAX_BACKOFF_MS = 120_000;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isRetryable = (error: unknown): boolean => {
  const status = (error as { status?: number })?.status ?? 0;
  // This exact phrase is what GitHub returns for the secondary limit — the one
  // that killed the first publish. Match on it, not on status alone: a 403 can
  // also mean "integration lacks permission", which no amount of retrying
  // fixes and which must fail fast and red.
  const message = String((error as { message?: string })?.message ?? "");
  if (/secondary rate limit/i.test(message)) return true;
  // 409/422 here is the ref having moved under us (the crank commits to the
  // same branch), which the next attempt re-reads.
  if (status === 409 || status === 422) return true;
  return status >= 500;
};

const backoffMs = (error: unknown, attempt: number): number => {
  const header = (error as { response?: { headers?: Record<string, string> } })?.response
    ?.headers?.["retry-after"];
  const seconds = Number(header);
  // A header of 0 means "retry now" and must not fall through to the fallback
  // backoff (which would make a free retry cost 20 s).
  if (header != null && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }
  return Math.min(FALLBACK_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
};

type GitLike = {
  getRef: () => Promise<{ object: { sha: string } }>;
  createTree: (baseTree: string, tree: Record<string, unknown>[]) => Promise<{ sha: string }>;
  createCommit: (message: string, treeSha: string, parentSha: string) => Promise<{ sha: string }>;
  updateRef: (sha: string) => Promise<unknown>;
  getCommitTree: (sha: string) => Promise<{ sha: string }>;
};

// The octokit call sequence, extracted so the batching is testable without a
// network or a token. Reads the branch head once per ATTEMPT (not once per
// file), then costs 3 POSTs per batch regardless of how many files it holds.
export const commitBatches = async (
  git: GitLike,
  batches: { files: { path: string; content: string }[]; message: string }[],
  log: (line: string) => void = console.log,
): Promise<number> => {
  let committed = 0;
  for (const batch of batches) {
    if (batch.files.length === 0) continue;
    // A retry restarts from a fresh ref read: the previous attempt's tree or
    // commit may exist as a dangling object, which is harmless in git.
    let lastError: unknown;
    let done = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
      try {
        const head = await git.getRef();
        const headCommit = await git.getCommitTree(head.object.sha);
        const tree = await git.createTree(
          headCommit.sha,
          batch.files.map((file) => ({
            path: file.path,
            mode: "100644",
            type: "blob",
            content: file.content,
          })),
        );
        const commit = await git.createCommit(batch.message, tree.sha, head.object.sha);
        await git.updateRef(commit.sha);
        committed += batch.files.length;
        done = true;
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === MAX_ATTEMPTS) throw error;
        const wait = backoffMs(error, attempt);
        log(
          `  commit attempt ${attempt} failed (${
            (error as { status?: number }).status
          }): retrying in ${Math.round(wait / 1000)}s`,
        );
        await sleep(wait);
      }
    }
    if (!done) throw lastError;
  }
  return committed;
};

// Count/byte chunking that preserves input order, so index.json is committed
// with the first batch it lands in.
export const buildBatches = (
  files: { path: string; content: string }[],
  message: string,
): { files: { path: string; content: string }[]; message: string }[] => {
  if (files.length === 0) return [];
  const batches: { files: { path: string; content: string }[]; message: string }[] = [];
  let current: { path: string; content: string }[] = [];
  let bytes = 0;
  const flush = () => {
    if (current.length === 0) return;
    batches.push({
      files: current,
      // Every batch of one run must be attributable to that run, so batch 2+
      // says which one it is in an otherwise identical message.
      message: batches.length === 0 ? message : `${message} (batch ${batches.length + 1})`,
    });
    current = [];
    bytes = 0;
  };
  for (const file of files) {
    const size = Buffer.byteLength(file.content, "utf8");
    if (current.length > 0 && (current.length >= MAX_FILES_PER_COMMIT || bytes + size > MAX_BYTES_PER_COMMIT)) {
      flush();
    }
    current.push(file);
    bytes += size;
  }
  flush();
  return batches;
};

export const saveDataToGitHub = async (
  files: {
    path: string;
    content: string;
  }[],
  message?: string,
) => {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is not set");
  }

  const octokit = new Octokit({ auth: githubToken });
  const owner = "SolanaVault";
  const repo = "vault-lst-list-generator";
  // Overridable so the publish path can be exercised end to end against a
  // scratch branch instead of being believed on faith.
  const branch = process.env.GITHUB_BRANCH ?? "main";

  const commitMessage = message ?? `Add data for timestamp ${Date.now()}`;
  const batches = buildBatches(files, commitMessage);
  if (batches.length === 0) return 0;

  const git: GitLike = {
    getRef: () => octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` }).then((r) => r.data),
    getCommitTree: (sha) =>
      octokit.rest.git
        .getCommit({ owner, repo, commit_sha: sha })
        .then((r) => r.data.tree),
    createTree: (base_tree, tree) =>
      octokit.rest.git.createTree({ owner, repo, base_tree, tree } as never).then((r) => r.data),
    createCommit: (msg, tree, parent) =>
      octokit
        .rest.git.createCommit({ owner, repo, message: msg, tree, parents: [parent] })
        .then((r) => r.data),
    updateRef: (sha) =>
      octokit.rest.git
        .updateRef({ owner, repo, ref: `heads/${branch}`, sha, force: false })
        .then((r) => r.data),
  };

  const committed = await commitBatches(git, batches);
  console.log(
    `Data saved to GitHub: ${committed} file(s) in ${batches.length} commit(s) on ${branch}`,
  );
  return committed;
};
