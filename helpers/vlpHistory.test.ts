import assert from "node:assert/strict";
import { test } from "node:test";

import { extractStoredRows, mergeVlpHistory } from "./vlpHistory";

const row = (
  slot: number,
  day: string,
  floor = 1.0,
  extra: Record<string, unknown> = {}
) => ({
  block_slot: slot,
  block_time: `2026-0${day.slice(0)}-15T00:00:${String(slot % 60).padStart(2, "0")}Z`,
  rate_floor_24h: floor,
  vlp_price: floor,
  ...extra,
});

test("mergeVlpHistory unions disjoint windows newest-first", () => {
  const existing = [row(300, "6"), row(200, "5"), row(100, "4")];
  const incoming = [row(500, "8"), row(400, "7")];
  const merged = mergeVlpHistory(incoming, existing);
  assert.deepEqual(
    merged.map((r) => r.block_slot),
    [500, 400, 300, 200, 100]
  );
});

test("mergeVlpHistory lets incoming rows win on collision", () => {
  const existing = [row(400, "7", 1.0), row(300, "6", 1.0)];
  const incoming = [
    { ...row(400, "7", 1.0), markers: "fresh" } as never,
    row(350, "7", 1.0),
  ];
  const merged = mergeVlpHistory(incoming, existing);
  const fresh = merged.find((r) => r.block_slot === 400);
  assert.equal(fresh!.markers, "fresh");
  assert.equal(merged.length, 3);
});

test("mergeVlpHistory recomputes vlp_price across full history", () => {
  // Old stored rows had a low plateau; the incoming window (correct only
  // relative to its own window) must not drag the monotonic price down, and
  // a mid-history spike must raise every later row.
  const existing = [
    row(300, "6", 1.05), // historic spike inside stored range
    row(310, "6", 1.05),
    row(400, "7", 1.0),
  ];
  const incoming = [row(500, "8", 1.02), row(450, "8", 1.0)];
  const merged = mergeVlpHistory(incoming, existing);
  const prices = Object.fromEntries(
    merged.map((r) => [r.block_slot, r.vlp_price])
  );
  assert.equal(prices[300], 1.05);
  assert.equal(prices[310], 1.05);
  assert.equal(prices[400], 1.05, "post-spike rows stay at the running max");
  assert.equal(prices[450], 1.05);
  assert.equal(prices[500], 1.05);
});

test("mergeVlpHistory truncates oldest beyond maxRows", () => {
  const existing = Array.from({ length: 10 }, (_, i) => row(i + 1, "1", 1.0));
  const merged = mergeVlpHistory([], existing, 4);
  assert.equal(merged.length, 4);
  assert.deepEqual(
    merged.map((r) => r.block_slot),
    [10, 9, 8, 7]
  );
});

test("mergeVlpHistory does not let floorless legacy rows raise fresh rows", () => {
  const legacy = [
    { block_slot: 10, block_time: "2026-01-15T00:00:00Z", vlp_price: 1.03 },
  ];
  const incoming = [row(20, "2", 1.02)];
  const merged = mergeVlpHistory(incoming, legacy);
  assert.equal(merged.find((r) => r.block_slot === 10)!.vlp_price, 1.03);
  assert.equal(merged.find((r) => r.block_slot === 20)!.vlp_price, 1.02);
});

test("mergeVlpHistory tolerates junk rows", () => {
  const merged = mergeVlpHistory(
    [null as never, { nope: 1 } as never, row(5, "3", 1.0)],
    [undefined as never]
  );
  assert.equal(merged.length, 1);
});

test("rowTimeMs parses Dune display strings, ISO, and epoch seconds/ms", async () => {
  const { rowTimeMs } = await import("./vlpHistory");
  assert.ok(Number.isFinite(rowTimeMs("2026-09-22 00:49:23.000 UTC")));
  assert.ok(Number.isFinite(rowTimeMs("2026-09-22T00:49:23.000Z")));
  assert.equal(rowTimeMs(1759000000), 1759000000 * 1000);
  assert.equal(rowTimeMs(1759000000000), 1759000000000);
  assert.equal(rowTimeMs("1759000000000"), 1759000000000);
  assert.ok(Number.isNaN(rowTimeMs("garbage")));
  assert.ok(Number.isNaN(rowTimeMs(undefined)));
});

test("mergeVlpHistory orders Dune display strings and drops unparseable times", () => {
  const dune = (slot: number, t: string) => ({
    block_slot: slot,
    block_time: t,
    rate_floor_24h: 1 + slot / 100000,
  });
  const incoming = [
    dune(300, "2026-09-22 00:00:00.000 UTC"),
    dune(200, "2026-09-21 00:00:00.000 UTC"),
    { block_slot: 999, block_time: "not-a-time", rate_floor_24h: 9 },
  ];
  const merged = mergeVlpHistory(incoming, []);
  assert.deepEqual(
    merged.map((r) => r.block_slot),
    [300, 200]
  );
  assert.ok(
    (merged[0].vlp_price as number) >= (merged[1].vlp_price as number),
    "newest row carries the running max"
  );
});

test("extractStoredRows reads both dune.json shapes", () => {
  const v2 = { result: { rows: [row(1, "1", 1)] } };
  const v1 = { current: [row(2, "2", 1)] };
  assert.equal(extractStoredRows(v2).length, 1);
  assert.equal(extractStoredRows(v1).length, 1);
  assert.deepEqual(extractStoredRows(null), []);
  assert.deepEqual(extractStoredRows({}), []);
});
