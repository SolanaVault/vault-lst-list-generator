/*
 * Vendored from SolanaVault/directed-stake:
 *   packages/solana-utils/src/failoverRpcFetch.ts
 * Do not edit here; re-copy on upstream change.
 */

/**
 * An RPC transport that blinks over to a second endpoint.
 *
 * `retryingRpcFetch.ts` kept jobs alive through the short blips -- a socket
 * that refused once answered on the second attempt. It cannot help when the
 * endpoint itself is down: a load balancer emitting 503s for minutes, a
 * provider outage, or the subtler variant where the node answers 200 and
 * every response says "Node is behind by 1,180 slots". Retrying that into
 * the ground reads stale state for as long as the blip lasts. A second
 * endpoint costs one more API key and turns those outages into a log line.
 *
 * What counts as "the primary is unwell, ask the backup" is deliberately
 * narrow: transport errors, HTTP 408/429/5xx, and the handful of JSON-RPC
 * errors a sick node emits on an HTTP 200. A `-32002` simulation failure or
 * an invalid-params error is the network answering perfectly well, and
 * re-asking a different node the same question it just refused produces the
 * same refusal while hiding a real bug inside a delay. Default is always
 * "not transient"; the classifier in this file lists the exceptions.
 *
 * Nothing here logs a URL or hostname: they carry API keys. Log lines label
 * the endpoints "primary" and "fallback" and describe how each failed.
 */

import type { Commitment, ConnectionConfig } from "@solana/web3.js";
import { Connection } from "@solana/web3.js";

import type { RetryingRpcFetchOptions } from "./retryingRpcFetch.js";
import { makeRetryingRpcFetch } from "./retryingRpcFetch.js";

export interface FailoverRpcFetchOptions extends RetryingRpcFetchOptions {
  /** Fallback endpoint. Undefined/empty => behave exactly like makeRetryingRpcFetch. */
  fallbackUrl?: string;
  /**
   * Attempts on the primary before failing over. Two when a fallback exists:
   * the first failure may be the kind the retry layer alone rides out, so
   * give the primary one more chance before spending the backup's rate
   * limits; the second says the endpoint is not recovering under itself.
   */
  primaryAttempts?: number;
  /** Where failover lines go. Never receives a URL, only "primary"/"fallback". */
  onFailover?: (message: string) => void;
}

/**
 * Transport-level failure, mirrored from the (private) helper of the same
 * name in retryingRpcFetch.ts so the two layers agree on what "the wire
 * failed" means. `fetch` reports refused connections, DNS failures and
 * timeouts as a `TypeError` with a nested cause rather than a status.
 */
const isTransportError = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError"));

/** The statuses that mean the server is unwell, as in the retry layer. */
export const isTransientHttpStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

/** The two phrases a lagging or wedged node answers with. */
const NODE_UNWELL_PATTERN = /node is behind|node is unhealthy/i;

/**
 * What `sendTransaction` comes back with when the node's own simulation
 * blew up -- the request was fine, the node was not.
 */
const PREFLIGHT_SIMULATION_FAILURE =
  "internal error during preflight simulation";

/**
 * Whether a JSON-RPC error's `data` pins the failure on the transaction
 * rather than the node. Gateways file genuine rejections under the generic
 * codes with the real fault in `data.err` ("BlockhashNotFound", an
 * InstructionError) -- that is the network answering, whatever the code
 * claims. `err: null` is the transaction being fine, so it does not count.
 */
const carriesConcreteRejection = (data: unknown): boolean => {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const { err } = data as { err?: unknown };
  return err !== undefined && err !== null;
};

/**
 * Whether one JSON-RPC error object describes a node that is unwell rather
 * than a request that is wrong.
 *
 * Everything not listed here is a real answer: `-32002` simulation failures
 * (custom program errors, missing account funds), blockhash-not-found,
 * `-32602` invalid params, and anything unrecognised all stay on the node
 * that produced them.
 */
export const isTransientRpcFailure = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message, data } = error as {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
  const text = typeof message === "string" ? message : "";
  if (code === -32005 || NODE_UNWELL_PATTERN.test(text)) {
    return true;
  }
  if (text.toLowerCase().includes(PREFLIGHT_SIMULATION_FAILURE)) {
    return true;
  }
  // The JSON-RPC catch-all. Only its literal "Internal error" opening is a
  // node complaint, and only while the node has not pinned a concrete
  // transaction error on it right below the surface.
  return (
    code === -32603 &&
    text.startsWith("Internal error") &&
    !carriesConcreteRejection(data)
  );
};

/** The first transiently-failing error in a single or batched body, if any. */
const transientErrorIn = (body: unknown): unknown => {
  const entries = Array.isArray(body) ? body : [body];
  for (const entry of entries) {
    if (typeof entry === "object" && entry !== null && "error" in entry) {
      const error = (entry as { error: unknown }).error;
      if (isTransientRpcFailure(error)) {
        return error;
      }
    }
  }
  return undefined;
};

/** Whether a parsed JSON-RPC response body reports a transient failure. */
export const isTransientRpcBody = (body: unknown): boolean =>
  transientErrorIn(body) !== undefined;

/**
 * Text from an error message is not trusted to stay URL-free: a custom
 * fetch can build its message around the request URL, and gateways do echo
 * one back inside a JSON-RPC message. A log line must never carry one.
 */
const scrubUrls = (text: string): string =>
  text.replace(/https?:\/\/\S+/gu, "[url]");

/**
 * How a thrown attempt failed, for a log line. `error.message` only: the
 * `cause` undici hangs off a refused connect carries the host it could not
 * reach, and hosts are secrets here.
 */
const describeThrownError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return isTransportError(error)
    ? `transport error: ${scrubUrls(message)}`
    : `error: ${scrubUrls(message)}`;
};

/** A log-safe description of a JSON-RPC error: code and message, no URL. */
const describeJsonRpcError = (error: unknown): string => {
  const { code, message } =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; message?: unknown })
      : {};
  const codeText = typeof code === "number" ? code.toString() : "?";
  return typeof message === "string" && message.length > 0
    ? `JSON-RPC error ${codeText} (${scrubUrls(message)})`
    : `JSON-RPC error ${codeText}`;
};

/**
 * The request's method for the failover log line.
 *
 * Only bodies we serialise ourselves are read; anything unparseable (or a
 * raw send body) is just labelled "request". Never taken from the URL.
 */
const methodLabel = (init: RequestInit | undefined): string => {
  const body = init?.body;
  if (typeof body !== "string") {
    return "request";
  }
  const entryMethod = (entry: unknown): string | undefined =>
    typeof entry === "object" && entry !== null && "method" in entry
      ? String((entry as { method: unknown }).method)
      : undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) {
      const methods = parsed.map(entryMethod);
      // Send batches read as sendTransactions, as in the retry layer.
      return (
        methods.find((method) => method === "sendTransaction") ??
        methods.find((method) => method !== undefined) ??
        "request"
      );
    }
    return entryMethod(parsed) ?? "request";
  } catch {
    return "request";
  }
};

/**
 * Bodies above this size are never peeked inside on the healthy path.
 *
 * A JSON-RPC error body is tiny -- code, message, maybe a small `data` --
 * while a successful `getProgramAccounts` reply runs to tens of megabytes.
 * Parsing one of those on every request, on top of the parse `Connection`
 * itself is about to do, doubles peak memory/CPU to look for a complaint
 * that never fits in that volume. Anything announced (content-length) or
 * measured (chunked text) above this cap is taken at face value as an
 * answer; real errors sail past the cap on the status code instead.
 */
const MAX_CLASSIFIED_BODY_BYTES = 64 * 1024;

/**
 * Why this Response means the endpoint is unwell, or undefined when it is an
 * answer worth handing back to the caller.
 *
 * The JSON body is read via `clone()`: peeking inside the response must not
 * consume the Response that goes back to `Connection`.
 */
const transientReasonFor = async (
  response: Response,
): Promise<string | undefined> => {
  if (!response.ok) {
    return isTransientHttpStatus(response.status)
      ? `HTTP ${response.status.toString()}`
      : undefined;
  }
  // `Number(null)` is 0 and a malformed header is NaN; both fall through to
  // the measured path below, which never trusts the announcement anyway.
  const declaredBytes = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredBytes) &&
    declaredBytes > MAX_CLASSIFIED_BODY_BYTES
  ) {
    return undefined;
  }
  try {
    const text = await response.clone().text();
    // Chunked replies carry no content-length, so the size is only knowable
    // after the read; `JSON.parse` -- not the read -- is what multiplies a
    // tens-of-megabytes body into a heap graph, so oversized text stops here.
    if (text.length > MAX_CLASSIFIED_BODY_BYTES) {
      return undefined;
    }
    const error = transientErrorIn(JSON.parse(text) as unknown);
    return error === undefined ? undefined : describeJsonRpcError(error);
  } catch {
    // A 200 that is not JSON is the node answering in some other voice;
    // hand it back rather than inventing a failure. Default is not transient.
    return undefined;
  }
};

/**
 * Builds a `fetch` for `new Connection(url, { fetch })` that fails over to a
 * second endpoint when the first is transiently unwell.
 *
 * Every request tries the primary through `makeRetryingRpcFetch` (with
 * `primaryAttempts` when a fallback exists); only its transient failures
 * travel to the backup. With no `fallbackUrl` this returns
 * `makeRetryingRpcFetch` itself -- identical behaviour, default attempts
 * included, zero added layers.
 *
 * `sendTransaction` keeps the rule from retryingRpcFetch.ts -- "a signed
 * transaction that may already have landed is not a request to repeat on a
 * hunch" -- so it gets exactly one attempt on the primary no matter how
 * `primaryAttempts` is set. What it additionally gets here is the single
 * hand-off to the fallback when the primary failed the transaction before
 * it ever reached the cluster: the body is the same signed bytes, so the
 * signature is the same, and a signature that (somehow) did land dedupes --
 * the transaction cannot be applied twice on account of this hop. Any real
 * retry still belongs to the callers that rebuild with a fresh blockhash.
 */
export const makeFailoverRpcFetch = ({
  fallbackUrl,
  primaryAttempts = 2,
  fetchImpl = fetch,
  onFailover = (message) => {
    console.warn(message);
  },
  ...retryOptions
}: FailoverRpcFetchOptions = {}): typeof fetch => {
  const fallback = fallbackUrl?.trim();
  if (!fallback) {
    // No second endpoint: callers get exactly the retry transport they had.
    return makeRetryingRpcFetch({ ...retryOptions, fetchImpl });
  }

  // At least one hit on the primary, always: a request that skipped it would
  // quietly route half of a healthy job through the backup's rate limits.
  // (The `|| 1` catches the NaN a `Number(process.env.X)` can leave behind,
  // which Math.max alone does not clamp.)
  const askPrimary = makeRetryingRpcFetch({
    ...retryOptions,
    attempts: Math.max(1, Math.trunc(primaryAttempts) || 1),
    fetchImpl,
  });
  // A single attempt on the backup -- one more is the caller's business --
  // built through the retry layer so the timeout and the caller-abort
  // handling come along for free.
  const askFallback = makeRetryingRpcFetch({
    ...retryOptions,
    attempts: 1,
    fetchImpl,
  });

  return async (input, init) => {
    const label = methodLabel(init);
    let reason: string;

    try {
      const response = await askPrimary(input, init);
      const failure = await transientReasonFor(response);
      if (failure === undefined) {
        return response;
      }
      // The discarded primary response holds a socket until its stream is
      // released; don't park it through the fallback round trip.
      void response.body?.cancel().catch(() => undefined);
      reason = failure;
    } catch (error) {
      // A caller that aborted wants to stop, not to be answered elsewhere;
      // and a thrown error that is not the wire failing is the request's
      // fault, not the endpoint's.
      const abandoned = init?.signal?.aborted === true;
      if (abandoned || !isTransportError(error)) {
        throw error;
      }
      reason = describeThrownError(error);
    }

    // The caller may have aborted while the primary answer was being read
    // and classified; that is not a failure to report to the backup.
    if (init?.signal?.aborted === true) {
      throw new Error(`RPC failed on primary (${reason}); caller aborted`);
    }

    // Same method, same body, same headers -- only the endpoint changes.
    try {
      const response = await askFallback(fallback, init);
      const failure = await transientReasonFor(response);
      onFailover(
        failure === undefined
          ? `RPC failover: ${label} failed on primary (${reason}); served by fallback`
          : `RPC failover: ${label} failed on primary (${reason}); fallback also failed (${failure}); surfacing its result`,
      );
      return response;
    } catch (error) {
      // Both endpoints are down: the backup's error is the one the caller
      // sees -- it is the freshest failure -- after both are logged.
      onFailover(
        `RPC failover: ${label} failed on primary (${reason}); fallback also failed (${describeThrownError(error)}); surfacing its error`,
      );
      throw error;
    }
  };
};

/**
 * A `Connection` that keeps reading when its endpoint is transiently unwell.
 *
 * The convenience the cranks and invoice scripts kept hand-rolling: build
 * the failover transport and wire it in, in one call. `config` accepts both
 * shapes web3.js itself accepts -- a bare commitment string or a
 * `ConnectionConfig` -- so call sites read the same as
 * `new Connection(url, "confirmed")`.
 *
 * ```ts
 * const connection = createFailoverConnection(primary, backup, "confirmed");
 * ```
 */
export const createFailoverConnection = (
  primaryUrl: string,
  fallbackUrl: string | undefined,
  config?: ConnectionConfig | Commitment,
  options?: Omit<FailoverRpcFetchOptions, "fallbackUrl">,
): Connection => {
  // The same normalisation web3.js's constructor does, one step earlier.
  const connectionConfig =
    typeof config === "string" ? { commitment: config } : config;
  return new Connection(primaryUrl, {
    ...connectionConfig,
    fetch: makeFailoverRpcFetch({ ...options, fallbackUrl }),
  });
};
