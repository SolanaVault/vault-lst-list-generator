import assert from "node:assert/strict";
import test from "node:test";

import { makeFailoverRpcFetch } from "./vendor/failoverRpcFetch";

// The upstream failoverRpcFetch.test.ts lives with the vendored helper in
// SolanaVault/directed-stake but needs vitest (and is not re-copied here), so
// these are the three properties that matter most, in this repo's node:test
// style: a transport timeout fails over, a program error does not, and with
// no fallback configured the transport is the retry layer unchanged.

// The URLs look like they carry API keys because the real ones do: no log
// line may ever repeat them back.
const PRIMARY = "https://primary.example/rpc?api_key=PRIMARYKEY";
const FALLBACK = "https://backup.example/rpc?api_key=FALLBACKKEY";
const SECRET_PARTS = [
  "primary.example",
  "backup.example",
  "PRIMARYKEY",
  "FALLBACKKEY",
  "172.64.151.87",
];

const ok = (body: unknown = { jsonrpc: "2.0", result: 1, id: 1 }) =>
  new Response(JSON.stringify(body), { status: 200 });

const read = (method = "getAccountInfo"): RequestInit => ({
  method: "POST",
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
});

// `connect ETIMEDOUT` surfaces from undici as a TypeError with a cause; the
// cause is assigned after construction to stay off the ES2022 lib types.
const transportFailure = () => {
  const error = new TypeError("fetch failed");
  (error as Error & { cause?: unknown }).cause = new Error(
    "connect ETIMEDOUT 172.64.151.87:443"
  );
  return error;
};

const noSleep = () => Promise.resolve();

/** The URL a fetch was addressed to, whatever shape `input` arrived in. */
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

type Reply = () => Response | Promise<Response>;

/** A fetch that answers per URL, counts its hits, refuses anywhere else. */
const routingFetch = (routes: Record<string, Reply>) => {
  const hits: string[] = [];
  const fetchImpl = (
    input: RequestInfo | URL,
    _init?: RequestInit
  ): Promise<Response> => {
    const url = urlOf(input);
    hits.push(url);
    const route = routes[url];
    if (route === undefined) {
      return Promise.reject(new Error(`unexpected fetch to ${url}`));
    }
    return Promise.resolve(route());
  };
  return {
    fetchImpl,
    hitCount: (url: string) => hits.filter((hit) => hit === url).length,
  };
};

test("transport timeout on the primary is served by the fallback", async () => {
  const { fetchImpl, hitCount } = routingFetch({
    [PRIMARY]: () => Promise.reject(transportFailure()),
    [FALLBACK]: () => ok(),
  });
  const failovers: string[] = [];
  const transport = makeFailoverRpcFetch({
    fallbackUrl: FALLBACK,
    fetchImpl,
    sleepImpl: noSleep,
    onRetry: () => undefined,
    onFailover: (message) => {
      failovers.push(message);
    },
  });

  const response = await transport(PRIMARY, read("getAccountInfo"));

  assert.equal(response.status, 200);
  assert.equal(hitCount(PRIMARY), 2); // the default primaryAttempts
  assert.equal(hitCount(FALLBACK), 1);
  assert.equal(failovers.length, 1);
  assert.match(failovers[0], /getAccountInfo/);
  assert.match(failovers[0], /failed on primary/);
  assert.match(failovers[0], /served by fallback/);
  assert.match(failovers[0], /fetch failed/);
  for (const secret of SECRET_PARTS) {
    assert.doesNotMatch(failovers[0], new RegExp(secret, "u"));
  }
});

test("a program error stays on the node that reported it", async () => {
  // The network answered perfectly well. Asking the backup the same
  // question would reproduce the refusal and hide the bug.
  const { fetchImpl, hitCount } = routingFetch({
    [PRIMARY]: () =>
      ok({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32002,
          message:
            "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1",
        },
      }),
  });
  const failovers: string[] = [];
  const transport = makeFailoverRpcFetch({
    fallbackUrl: FALLBACK,
    fetchImpl,
    sleepImpl: noSleep,
    onRetry: () => undefined,
    onFailover: (message) => {
      failovers.push(message);
    },
  });

  const response = await transport(PRIMARY, read("sendTransaction"));
  const body = (await response.json()) as { error: { code: number } };

  assert.equal(body.error.code, -32002);
  assert.equal(hitCount(PRIMARY), 1);
  assert.equal(hitCount(FALLBACK), 0);
  assert.equal(failovers.length, 0);
});

test("without a fallback it is the retry transport verbatim", async () => {
  const { fetchImpl, hitCount } = routingFetch({
    [PRIMARY]: () => Promise.reject(transportFailure()),
  });
  const failovers: string[] = [];
  const transport = makeFailoverRpcFetch({
    fallbackUrl: undefined,
    fetchImpl,
    sleepImpl: noSleep,
    onRetry: () => undefined,
    onFailover: (message) => {
      failovers.push(message);
    },
  });

  // Every attempt stays on the primary and the last failure surfaces --
  // exactly the retry transport's behaviour, attempts included.
  await assert.rejects(() => transport(PRIMARY, read("getSlot")), {
    name: "TypeError",
    message: "fetch failed",
  });
  // The retry layer's own default of four attempts, not primaryAttempts.
  assert.equal(hitCount(PRIMARY), 4);
  assert.equal(hitCount(FALLBACK), 0);
  assert.equal(failovers.length, 0);
});
