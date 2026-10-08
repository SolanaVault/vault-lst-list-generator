// Retry-JSON fetch for the validator-metrics publisher (validator-metrics.ts).
// Deliberately a plain-URL sibling of fetchSafeJsonWithRetry in safeUrl.ts,
// NOT a reuse of it: fetchSafeJson was built for user-submitted token-metadata
// URLs, so its SSRF guard refuses hostnames that resolve to non-public IPs and
// it caps bodies at MAX_METADATA_RESPONSE_BYTES (1 MiB). Both assumptions are
// wrong for this job — the base URL is operator-supplied (and pointed at
// localhost by unit tests), and payloads are read back verbatim upstream
// fields that must not be silently truncated. The retry shape (3 attempts,
// 800 ms fixed backoff, timeout via AbortSignal, shared user-agent) mirrors
// fetchSafeJsonWithRetry on purpose.
import { METADATA_USER_AGENT } from "./safeUrl";

const UPSTREAM_FETCH_ATTEMPTS = 3;
const UPSTREAM_FETCH_BACKOFF_MS = 800;
const UPSTREAM_FETCH_TIMEOUT_MS = 15_000;
const VOTE_NOT_FOUND_STATUS = 502;

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class FetchJsonError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: unknown
  ) {
    super(message);
    this.name = "FetchJsonError";
  }
}

// The upstream answers 502 {"error":"vote account not found"} for validators
// that are delisted or not in the current voting set. That is a NORMAL state
// (§2.3 of the metrics spec), so callers must be able to tell it apart from a
// real upstream failure without string-matching error messages.
export const isVoteNotFound = (error: unknown): boolean =>
  error instanceof FetchJsonError &&
  error.status === VOTE_NOT_FOUND_STATUS &&
  typeof error.body === "object" &&
  error.body !== null &&
  (error.body as { error?: unknown }).error === "vote account not found";

type FetchJsonOptions = {
  timeoutMs?: number;
  attempts?: number;
  backoffMs?: number;
};

const fetchTextOnce = async (url: string, timeoutMs: number): Promise<string> => {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": METADATA_USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  if (!response.ok) {
    // The body of a failed response may itself be JSON ({"error":...}); parse
    // it best-effort so isVoteNotFound can inspect it.
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep raw text
    }
    throw new FetchJsonError(
      `Request to ${url} failed with HTTP ${response.status}`,
      response.status,
      body
    );
  }

  return text;
};

const fetchWithRetry = async (
  url: string,
  options: FetchJsonOptions
): Promise<string> => {
  const timeoutMs = options.timeoutMs ?? UPSTREAM_FETCH_TIMEOUT_MS;
  const attempts = options.attempts ?? UPSTREAM_FETCH_ATTEMPTS;
  const backoffMs = options.backoffMs ?? UPSTREAM_FETCH_BACKOFF_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs);
    }
    try {
      return await fetchTextOnce(url, timeoutMs);
    } catch (error) {
      lastError = error;
      if (isVoteNotFound(error)) {
        // Permanent, EXPECTED outcome (§2.3: validator not in the current
        // voting set), not a transient fault. Retrying it just burns
        // 2x backoff per affected validator per fetch on every run, so the
        // loop stops at the first response. Genuine transient failures
        // (other 5xx, network errors, timeouts) still use the full budget.
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

export const fetchTextWithRetry = (
  url: string,
  options: FetchJsonOptions = {}
): Promise<string> => fetchWithRetry(url, options);

export const fetchJsonWithRetry = async <T = unknown>(
  url: string,
  options: FetchJsonOptions = {}
): Promise<T> => {
  const text = await fetchWithRetry(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FetchJsonError(
      `Request to ${url} returned invalid JSON (HTTP 200)`,
      200,
      text
    );
  }
};
