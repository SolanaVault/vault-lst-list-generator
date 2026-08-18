import assert from "node:assert/strict";
import test from "node:test";

import { isSafeHttpsUrl } from "./safeUrl";

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
