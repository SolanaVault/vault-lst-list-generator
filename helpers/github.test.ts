import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBatches, commitBatches } from "./github";

const file = (n: number, bytes = 10): { path: string; content: string } => ({
  path: `validator-metrics/${n}.json`,
  content: "x".repeat(bytes),
});

// Records the call sequence so the "3 POSTs per batch" claim is a fact
// instead of a comment, and so a retry shows up as more than just "it passed".
const fakeGit = (opts: { failFirst?: number; bytes?: number } = {}) => {
  const calls: string[] = [];
  let refSha = 0;
  let failuresLeft = opts.failFirst ?? 0;
  const fail = () => {
    const error = Object.assign(new Error("You have exceeded a secondary rate limit."), {
      status: 403,
      response: { headers: { "retry-after": "0" } },
    });
    throw error;
  };
  const git = {
    getRef: async () => {
      calls.push("getRef");
      return { object: { sha: `ref${refSha}` } };
    },
    getCommitTree: async () => {
      calls.push("getCommit");
      return { sha: `tree-base${refSha}` };
    },
    createTree: async (base: string, tree: Record<string, unknown>[]) => {
      calls.push(`createTree:${base}:${tree.length}`);
      if (failuresLeft > 0) {
        failuresLeft--;
        fail();
      }
      return { sha: `tree${calls.length}` };
    },
    createCommit: async (message: string, treeSha: string, parent: string) => {
      calls.push(`createCommit:${message}:${treeSha}:${parent}`);
      refSha++;
      return { sha: `commit${refSha}` };
    },
    updateRef: async (sha: string) => {
      calls.push(`updateRef:${sha}`);
      return {};
    },
  };
  return { git, calls };
};

describe("buildBatches", () => {
  it("keeps a normal-size run in a single commit", () => {
    const batches = buildBatches([file(1), file(2)], "Publish validator metrics");
    assert.equal(batches.length, 1);
    assert.equal(batches[0].message, "Publish validator metrics");
    assert.equal(batches[0].files.length, 2);
  });

  it("caps a batch by file count", () => {
    const files = Array.from({ length: 450 }, (_, i) => file(i));
    const batches = buildBatches(files, "m");
    assert.deepEqual(
      batches.map((b) => b.files.length),
      [200, 200, 50],
    );
    assert.equal(batches[0].message, "m");
    assert.equal(batches[1].message, "m (batch 2)");
  });

  it("caps a batch by bytes too, because a tree POST has a body limit", () => {
    // 200 files x 9,000 bytes would be 1.8 MB: over the cap on size, not count.
    const files = Array.from({ length: 200 }, (_, i) => file(i, 9000));
    const batches = buildBatches(files, "m");
    assert.ok(batches.length > 1, "expected a byte-driven split");
    for (const batch of batches) {
      const bytes = batch.files.reduce(
        (sum, f) => sum + Buffer.byteLength(f.content, "utf8"),
        0,
      );
      assert.ok(bytes <= 1_500_000, `batch is ${bytes} bytes`);
    }
    const total = batches.reduce((sum, b) => sum + b.files.length, 0);
    assert.equal(total, 200, "no file may be dropped or duplicated");
  });

  it("puts nothing in an empty run", () => {
    assert.deepEqual(buildBatches([], "m"), []);
  });
});

describe("commitBatches", () => {
  it("costs 3 POSTs per batch, whatever the file count", async () => {
    const { git, calls } = fakeGit();
    const files = Array.from({ length: 150 }, (_, i) => file(i));
    const count = await commitBatches(git, buildBatches(files, "m"), () => {});
    assert.equal(count, 150);
    assert.deepEqual(
      calls.filter((c) => c.startsWith("createTree")),
      ["createTree:tree-base0:150"],
    );
    // getRef + getCommit + createTree + createCommit + updateRef
    assert.equal(calls.length, 5);
  });

  it("advances the ref between batches instead of reusing a stale head", async () => {
    const { git, calls } = fakeGit();
    const files = Array.from({ length: 300 }, (_, i) => file(i));
    await commitBatches(git, buildBatches(files, "m"), () => {});
    // Second batch must build on the first batch's commit, not on the branch
    // head as it looked when the run started.
    assert.ok(
      calls.some((c) => c === "createTree:tree-base1:100"),
      `expected batch 2 to base on the new head, got ${calls.join(" | ")}`,
    );
    assert.ok(calls.some((c) => c.startsWith("createCommit:m (batch 2)")));
  });

  it("survives a secondary rate limit by retrying the whole sequence", async () => {
    const { git, calls } = fakeGit({ failFirst: 1 });
    const count = await commitBatches(git, buildBatches([file(1)], "m"), () => {});
    assert.equal(count, 1);
    // Two ref reads: the failed attempt and the one that landed.
    assert.equal(calls.filter((c) => c === "getRef").length, 2);
  });

  it("gives up on a permission error instead of retrying it four times", async () => {
    const calls: string[] = [];
    const git = {
      getRef: async () => {
        calls.push("getRef");
        return { object: { sha: "r" } };
      },
      getCommitTree: async () => ({ sha: "t" }),
      createTree: async () => {
        throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
      },
      createCommit: async () => ({ sha: "c" }),
      updateRef: async () => ({}),
    };
    await assert.rejects(() => commitBatches(git, buildBatches([file(1)], "m"), () => {}), /not accessible/);
    assert.equal(calls.filter((c) => c === "getRef").length, 1, "must not retry a hard 403");
  });
});
