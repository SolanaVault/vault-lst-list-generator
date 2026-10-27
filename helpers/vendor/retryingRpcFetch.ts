/*
 * Vendored from SolanaVault/directed-stake:
 *   packages/solana-utils/src/retryingRpcFetch.ts
 * Do not edit here; re-copy on upstream change.
 */

/**
 * An RPC transport that survives the endpoint blinking.
 *
 * Every scheduled job here makes hundreds of RPC calls in sequence, and one of
 * them throwing takes the whole run down. On 2026-08-25 invoice creation had
 * already closed a hundred settled invoices when the endpoint stopped
 * answering: transactions started expiring, and then a bare
 * `connect ETIMEDOUT 172.64.151.87:443` surfaced out of web3.js as an uncaught
 * `TypeError: fetch failed` and ended the job. Epoch 1021 went unbilled --
 * a hundred and forty-eight invoices -- because a socket did not open.
 *
 * `fetchJsonWithRetry` already does this for the third-party APIs billing reads
 * from, for the same reason and after the same failure. This is the same idea
 * one layer down, handed to `Connection` so every read it makes is covered
 * without a single call site changing.
 *
 * Two things it deliberately does not do. It does not retry `sendTransaction`:
 * a signed transaction that may already have landed is not a request to repeat
 * on a hunch, and the callers that send have their own retry that rebuilds with
 * a fresh blockhash. And it does not look inside a successful response: a
 * JSON-RPC error is the node answering, not failing, and smoothing those over
 * would hide real faults behind a delay.
 */

export interface RetryingRpcFetchOptions {
  /** Total attempts per request, including the first. */
  attempts?: number;
  /** Abort an attempt that has not answered in this long. */
  timeoutMs?: number;
  /** Delay before retry `n` is `baseDelayMs * n`. */
  baseDelayMs?: number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  onRetry?: (message: string) => void;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The server is unwell rather than the request being wrong. */
const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

/**
 * Transport-level failure. `fetch` reports DNS failures, refused connections
 * and timeouts as a `TypeError` with a nested cause rather than a status, so
 * there is nothing more specific to match on.
 */
const isTransportError = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError"));

/**
 * The JSON-RPC method a request carries, when it can be read cheaply.
 *
 * Returns undefined for anything unparseable, which is treated as retryable:
 * the only bodies that matter here are the ones we send ourselves.
 */
const requestMethod = (init: RequestInit | undefined): string | undefined => {
  const body = init?.body;
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) {
      // A batch is retryable only if every call in it is.
      const methods = parsed.map((entry) =>
        typeof entry === "object" && entry !== null && "method" in entry
          ? String((entry as { method: unknown }).method)
          : "",
      );
      return (
        methods.find((method) => method === "sendTransaction") ?? methods[0]
      );
    }
    if (typeof parsed === "object" && parsed !== null && "method" in parsed) {
      return String((parsed as { method: unknown }).method);
    }
  } catch {
    return undefined;
  }
  return undefined;
};

/**
 * Builds a `fetch` for `new Connection(url, { fetch })`.
 *
 * Costs nothing when the endpoint is healthy: the retry only runs after a
 * failure that would otherwise have ended the process.
 */
export const makeRetryingRpcFetch = ({
  attempts = 4,
  timeoutMs = 30_000,
  baseDelayMs = 500,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  onRetry = (message) => {
    console.warn(message);
  },
}: RetryingRpcFetchOptions = {}): typeof fetch => {
  return async (input, init) => {
    const retryable = requestMethod(init) !== "sendTransaction";
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      // Respect a caller's own abort as well as this attempt's timeout.
      const callerSignal = init?.signal ?? undefined;
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal;
      try {
        const response = await fetchImpl(input, { ...init, signal });
        if (
          response.ok ||
          !retryable ||
          !isRetryableStatus(response.status) ||
          attempt === attempts
        ) {
          return response;
        }
        lastError = new Error(
          `RPC responded with HTTP ${response.status.toString()}`,
        );
        onRetry(
          `RPC attempt ${attempt.toString()}/${attempts.toString()} got HTTP ${response.status.toString()}, retrying`,
        );
      } catch (error) {
        // A caller that aborted wants to stop, not to be retried.
        const abandoned = callerSignal?.aborted === true;
        if (
          abandoned ||
          !retryable ||
          !isTransportError(error) ||
          attempt === attempts
        ) {
          throw error;
        }
        lastError = error;
        onRetry(
          `RPC attempt ${attempt.toString()}/${attempts.toString()} failed (${
            error instanceof Error ? error.message : String(error)
          }), retrying`,
        );
      } finally {
        clearTimeout(timer);
      }

      // Linear, like the upstream helper: these are brief blips, and a long
      // exponential wait would only push a scheduled run past its own deadline.
      await sleepImpl(baseDelayMs * attempt);
    }

    // Unreachable: the final attempt returns or throws above.
    throw lastError instanceof Error
      ? lastError
      : new Error(`RPC failed after ${attempts.toString()} attempts`);
  };
};
