import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import http from "node:http";
import test from "node:test";

import {
  FetchJsonError,
  fetchJsonWithRetry,
  isVoteNotFound,
} from "./metricsFetch";
import { METADATA_USER_AGENT } from "./safeUrl";

const withServer = async (
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    attempt: number
  ) => void,
  run: (origin: string, attempts: () => number) => Promise<void>
): Promise<void> => {
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls += 1;
    handler(request, response, calls);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, () => calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

test("returns parsed JSON and sends the crate's user-agent", async () => {
  let agent: string | undefined;
  await withServer(
    (request, response) => {
      agent = request.headers["user-agent"];
      response.setHeader("content-type", "application/json");
      response.end('{"epoch":1051}');
    },
    async (origin) => {
      const body = await fetchJsonWithRetry<{ epoch: number }>(origin);
      assert.deepEqual(body, { epoch: 1051 });
      assert.equal(agent, METADATA_USER_AGENT);
    }
  );
});

test("retries transient failures until the request succeeds", async () => {
  await withServer(
    (_request, response, attempt) => {
      if (attempt < 3) {
        response.writeHead(503);
        response.end('{"error":"try later"}');
        return;
      }
      response.end('{"ok":true}');
    },
    async (origin, attempts) => {
      const body = await fetchJsonWithRetry<{ ok: boolean }>(origin, {
        attempts: 3,
        backoffMs: 5,
      });
      assert.deepEqual(body, { ok: true });
      assert.equal(attempts(), 3);
    }
  );
});

test("gives up after the attempt budget and reports status and body", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(500);
      response.end('{"error":"boom"}');
    },
    async (origin, attempts) => {
      await assert.rejects(
        fetchJsonWithRetry(origin, { attempts: 2, backoffMs: 5 }),
        (error: unknown) =>
          error instanceof FetchJsonError &&
          error.status === 500 &&
          (error.body as { error?: string }).error === "boom"
      );
      assert.equal(attempts(), 2);
    }
  );
});

test("propagates the 502 vote-not-found signal after exactly one attempt", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(502);
      response.end('{"error":"vote account not found"}');
    },
    async (origin, attempts) => {
      await assert.rejects(
        fetchJsonWithRetry(origin, { attempts: 3, backoffMs: 5 }),
        (error: unknown) => isVoteNotFound(error)
      );
      // Permanent, expected state (§2.3): the retry loop must terminate
      // immediately instead of burning the budget on every run.
      assert.equal(attempts(), 1);
    }
  );
});

test("still retries a transient 500 the full attempt budget", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(500);
      response.end('{"error":"boom"}');
    },
    async (origin, attempts) => {
      await assert.rejects(
        fetchJsonWithRetry(origin, { attempts: 3, backoffMs: 5 }),
        (error: unknown) =>
          error instanceof FetchJsonError && error.status === 500
      );
      assert.equal(attempts(), 3);
    }
  );
});

test("rejects 200 responses that are not JSON", async () => {
  await withServer(
    (_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<html>bad gateway</html>");
    },
    async (origin) => {
      await assert.rejects(
        fetchJsonWithRetry(origin, { attempts: 1 }),
        (error: unknown) =>
          error instanceof FetchJsonError &&
          error.status === 200 &&
          isVoteNotFound(error) === false
      );
    }
  );
});
