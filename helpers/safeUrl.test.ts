import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  createSafeLookup,
  fetchSafeJson,
  isPublicIpAddress,
  isSafeHttpsUrl,
  parseJsonBody,
  validateRedirectTarget,
} from "./safeUrl";

test("accepts HTTPS URLs with domain names", () => {
  assert.equal(
    isSafeHttpsUrl(
      "https://gateway.irys.xyz/ENQWSDNsb3EZsLaq7s7PrA64PfEUUFM8XEq8Q5cAwbJ6"
    ),
    true
  );
});

test("rejects IP-hosted and local metadata URLs", () => {
  assert.equal(
    isSafeHttpsUrl(
      "http://172.86.119.34:8443/?fetch=http%3A%2F%2F84.32.59.222%3A3000"
    ),
    false
  );
  assert.equal(isSafeHttpsUrl("https://172.86.119.34/metadata.json"), false);
  assert.equal(isSafeHttpsUrl("https://[::1]/metadata.json"), false);
  assert.equal(isSafeHttpsUrl("https://localhost/metadata.json"), false);
});

test("rejects non-URL image values and insecure URLs", () => {
  assert.equal(isSafeHttpsUrl("RELAY_OK"), false);
  assert.equal(
    isSafeHttpsUrl(
      "eyJvcmlnaW5hbFN0YWNrRnJhbWUiOnsiZmlsZSI6Im5leHQuY29uZmlnLnRzIn19"
    ),
    false
  );
  assert.equal(isSafeHttpsUrl("http://example.com/image.png"), false);
});

test("rejects private, loopback, link-local, and mapped IP addresses", () => {
  for (const address of [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "::1",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:0:127.0.0.1",
    "::ffff:0:169.254.169.254",
    "64:ff9b::a00:1",
    "64:ff9b:1::a00:1",
    "2002:7f00:1::",
    "fc00::1",
    "fe80::1",
    "fec0::1",
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }

  assert.equal(isPublicIpAddress("1.1.1.1"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
});

test("rejects a hostname if any connection-time DNS answer is unsafe", async () => {
  const safeLookup = createSafeLookup((_hostname, _options, callback) => {
    callback(null, [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
  });

  await assert.rejects(
    new Promise((resolve, reject) => {
      safeLookup("example.com", { all: true }, (error, addresses) => {
        if (error) {
          reject(error);
        } else {
          resolve(addresses);
        }
      });
    }),
    /Blocked unsafe address/
  );
});

test("safe metadata fetching wires in connection-time DNS enforcement", async () => {
  await assert.rejects(
    fetchSafeJson(
      "https://metadata.example/metadata.json",
      1_000,
      (_hostname, _options, callback) => {
        callback(null, [{ address: "169.254.169.254", family: 4 }]);
      }
    ),
    /Blocked unsafe address/
  );
});

test("accepts bounded JSON response bodies", async () => {
  const body = await parseJsonBody(
    Readable.from(['{"name":"Vault"}']),
    "application/json; charset=utf-8",
    undefined
  );

  assert.deepEqual(body, { name: "Vault" });
});

test("accepts JSON bodies served with a non-JSON content type", async () => {
  const body = await parseJsonBody(
    Readable.from(['{"name":"Vault"}']),
    "text/plain",
    undefined
  );

  assert.deepEqual(body, { name: "Vault" });
});

test("rejects invalid JSON and oversized response bodies", async () => {
  await assert.rejects(
    parseJsonBody(Readable.from(["not json"]), "text/plain", undefined),
    /not valid JSON/
  );
  await assert.rejects(
    parseJsonBody(
      Readable.from(["12345", "67890"]),
      "application/json",
      undefined,
      8
    ),
    /size limit/
  );
  await assert.rejects(
    parseJsonBody(Readable.from(["{}"]), "application/json", "9", 8),
    /size limit/
  );
  await assert.rejects(
    parseJsonBody(Readable.from(["not json"]), "application/json", undefined),
    /Unexpected token|not valid JSON|JSON/
  );
});

test("rejects bodies that exceed the size limit when sniffed as JSON", async () => {
  await assert.rejects(
    parseJsonBody(Readable.from(["12345", "67890"]), "text/plain", undefined, 8),
    /size limit/
  );
});

test("validates redirect targets before they are fetched", () => {
  // Plain redirects like gateway.irys.xyz -> CDN are allowed.
  assert.equal(
    validateRedirectTarget(
      "https://gateway.irys.xyz/ENQWSDNsb3EZsLaq7s7PrA64PfEUUFM8XEq8Q5cAwbJ6",
      "https://cdn.datasprite.app/metadata.json"
    ),
    "https://cdn.datasprite.app/metadata.json"
  );

  // Relative Location headers resolve against the current URL.
  assert.equal(
    validateRedirectTarget("https://example.com/a/b.json", "/c/d.json"),
    "https://example.com/c/d.json"
  );

  // Missing Location header, non-HTTPS, IP literals, and private hosts fail.
  assert.throws(
    () => validateRedirectTarget("https://example.com/a.json", undefined),
    /missing a location header/
  );
  assert.throws(
    () => validateRedirectTarget("https://example.com/a.json", "http://example.com/b.json"),
    /Unsafe metadata redirect URL/
  );
  assert.throws(
    () => validateRedirectTarget("https://example.com/a.json", "https://169.254.169.254/latest"),
    /Unsafe metadata redirect URL/
  );
  assert.throws(
    () => validateRedirectTarget("https://example.com/a.json", "https://[::1]/metadata.json"),
    /Unsafe metadata redirect URL/
  );
  assert.throws(
    () => validateRedirectTarget("https://example.com/a.json", "https://user@example.com/a"),
    /Unsafe metadata redirect URL/
  );
  assert.throws(
    () => validateRedirectTarget("https://example.com/a.json", "mailto:you@example.com"),
    /Unsafe metadata redirect URL/
  );
});
