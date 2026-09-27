/**
 * History accumulation for the VLP Dune feed (query 5304965).
 *
 * The Dune query only emits the last ~90 days of rows (its `WHERE block_time
 * >= now() - 90 day` filter), and its `vlp_price` running-max is therefore
 * only correct relative to that window. The generator keeps the full series
 * here in git: each daily run merges the incoming window into the stored
 * rows, then recomputes the monotonic price columns against the FULL merged
 * history so `vlp_price` never depends on what happens to fall inside the
 * Dune window.
 */

export type DuneRow = Record<string, unknown> & {
  block_time?: string;
  block_slot?: number;
};

const KEY = (r: DuneRow): string =>
  `${r.block_slot ?? ""}|${r.block_time ?? ""}`;

/**
 * Merge `incoming` (the latest Dune window, usually newest-first) into
 * `existing` (the stored full history, any order).
 *
 * - Rows are keyed by (block_slot, block_time). On collision the INCOMING
 *   copy wins (it was computed from fresher upstream matviews).
 * - `vlp_price` is recomputed as the running max of `rate_floor_24h` over the
 *   whole merged series (ascending time), matching the v22 definition while
 *   no longer being window-relative. If `rate_floor_24h` is absent (query
 *   regression), existing `vlp_price` values are kept and forced monotonic.
 * - Result is sorted newest-first and truncated to `maxRows` (oldest dropped).
 */
export const mergeVlpHistory = (
  incoming: DuneRow[],
  existing: DuneRow[],
  maxRows = 10000
): DuneRow[] => {
  const byKey = new Map<string, DuneRow>();
  for (const row of existing) {
    if (row && row.block_time) byKey.set(KEY(row), row);
  }
  for (const row of incoming) {
    if (row && row.block_time) byKey.set(KEY(row), row);
  }

  const ascending = [...byKey.values()].sort((a, b) =>
    new Date(String(a.block_time)).getTime() -
    new Date(String(b.block_time)).getTime()
  );

  let runningMax = Number.NEGATIVE_INFINITY;
  for (const row of ascending) {
    const floor =
      typeof row.rate_floor_24h === "number" ? row.rate_floor_24h : null;
    if (floor !== null) {
      if (floor > runningMax) runningMax = floor;
      row.vlp_price = runningMax;
    } else if (typeof row.vlp_price === "number") {
      // Rows without rate_floor_24h (older query versions) cannot contribute a
      // floor, only a ceiling from their stored price. Clamp them to the
      // running max without feeding their value back into it, so a stale high
      // legacy row can never artificially raise subsequent fresh rows.
      row.vlp_price = Math.max(runningMax, row.vlp_price);
    }
  }

  return ascending
    .reverse()
    .slice(0, Math.max(0, maxRows));
};

/**
 * Extract previously stored rows from a dune.json payload. Handles the
 * current shape ({ result: { rows } }) plus historical shapes that used to be
 * committed: { current: [...] } and { dataset: [...] }. Callers should read
 * `current` before `dataset` (newest-first head vs long tail).
 */
export const extractStoredRows = (payload: unknown): DuneRow[] => {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;
  const result = p.result as Record<string, unknown> | undefined;
  if (Array.isArray(result?.rows)) return result!.rows as DuneRow[];
  if (Array.isArray(p.current)) return p.current as DuneRow[];
  if (Array.isArray(p.dataset)) return p.dataset as DuneRow[];
  return [];
};
