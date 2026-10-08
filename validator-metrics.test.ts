import assert from "node:assert/strict";
import test from "node:test";

import {
	CADENCE_GRACE_MS,
	buildFiles,
	collectSiteListPubkeys,
	hasPreviousSection,
	isSectionDue,
	resolveSectionValue,
	settleDelinquency,
	type Section,
	unchanged,
	unionValidatorSets,
} from "./validator-metrics";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Fixed "now": 2026-10-07T12:00:00Z.
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

// --- Cadence clock (grace window) ---

test("cadence: a section exactly at its refresh age is due", () => {
	assert.equal(isSectionDue("delinquency", NOW, NOW - 6 * HOUR), true);
	assert.equal(isSectionDue("blockRewards", NOW, NOW - 6 * HOUR), true);
	assert.equal(isSectionDue("ranks", NOW, NOW - 12 * HOUR), true);
	assert.equal(isSectionDue("bonds", NOW, NOW - 24 * HOUR), true);
	assert.equal(isSectionDue("sfdp", NOW, NOW - 24 * HOUR), true);
});

test("cadence: age minus 29 minutes is due (grace absorbs run overrun and cron jitter)", () => {
	assert.equal(
		isSectionDue("delinquency", NOW, NOW - (6 * HOUR - 29 * MINUTE)),
		true,
	);
	assert.equal(
		isSectionDue("ranks", NOW, NOW - (12 * HOUR - 29 * MINUTE)),
		true,
	);
	assert.equal(
		isSectionDue("bonds", NOW, NOW - (24 * HOUR - 29 * MINUTE)),
		true,
	);
});

test("cadence: age minus 31 minutes is not due yet (grace window is bounded)", () => {
	assert.equal(CADENCE_GRACE_MS, 30 * MINUTE);
	assert.equal(
		isSectionDue("delinquency", NOW, NOW - (6 * HOUR - 31 * MINUTE)),
		false,
	);
	assert.equal(
		isSectionDue("ranks", NOW, NOW - (12 * HOUR - 31 * MINUTE)),
		false,
	);
	assert.equal(
		isSectionDue("bonds", NOW, NOW - (24 * HOUR - 31 * MINUTE)),
		false,
	);
});

test("cadence: missing/unparseable previous generatedAt makes every section due", () => {
	for (const section of [
		"ranks",
		"bonds",
		"sfdp",
		"delinquency",
		"blockRewards",
	]) {
		assert.equal(isSectionDue(section, NOW, NaN), true);
	}
});

test("cadence: future-dated generatedAt (clock skew) is due, never a negative-elapsed 'not due'", () => {
	assert.equal(isSectionDue("delinquency", NOW, NOW + 90 * MINUTE), true);
	assert.equal(isSectionDue("ranks", NOW, NOW + 12 * HOUR), true);
	assert.equal(isSectionDue("bonds", NOW, NOW + 48 * HOUR), true);
});

// --- Failed fetch vs previous section ---

const previousOk: Section = { ok: true, data: { epoch: 1051 } };
const freshFailure: Section = {
	ok: false,
	reason: "upstream_error",
	detail: "HTTP 500",
};

test("a failed fetch serves the previous ok:true payload instead of the failure", () => {
	assert.equal(resolveSectionValue(freshFailure, previousOk), previousOk);
});

test("a failed fetch with a previous that was itself ok:false serves the new failure (nothing to swallow into)", () => {
	const previousFailed: Section = {
		ok: false,
		reason: "not_found",
		detail: "vote account not found in current voting set",
	};
	assert.equal(resolveSectionValue(freshFailure, previousFailed), freshFailure);
});

test("not_found is a real state change, not a fetch failure: it replaces a previous ok:true", () => {
	const notFound: Section = {
		ok: false,
		reason: "not_found",
		detail: "vote account not found in current voting set",
	};
	assert.equal(resolveSectionValue(notFound, previousOk), notFound);
});

test("a successful fetch replaces the previous; an absent fresh section carries forward", () => {
	const freshOk: Section = { ok: true, data: { epoch: 1052 } };
	assert.equal(resolveSectionValue(freshOk, previousOk), freshOk);
	assert.equal(resolveSectionValue(undefined, previousOk), previousOk);
	assert.equal(resolveSectionValue(undefined, undefined), undefined);
});

// --- Commit churn gate ---

test("unchanged() skips re-committing a blob identical to the serialized previous (cluster-carry gate too)", () => {
	const blob = `${JSON.stringify(previousOk, null, 2)}\n`;
	assert.equal(unchanged(previousOk, blob), true);
});

test("unchanged(null) is false: an unreadable previous file conservatively re-commits", () => {
	assert.equal(unchanged(null, "anything\n"), false);
});

// --- The sfdp cadence gate (regression: sfdp was fetched for EVERY validator
// on EVERY run because its previous key is nested inside software.data, so a
// top-level previousSections["sfdp"] lookup is always undefined and the 24 h
// clock never applied). Shape below mirrors what buildSoftwareSection writes,
// and the live --base-url proxy run re-proves it against real output. ---

const sfdpPayload = { identity: "ident", participant: { state: "Approved" } };
const publishedSections: Record<string, unknown> = {
	ranks: { ok: true, data: { epoch: 1051 } },
	software: { ok: true, data: { version: "2.2.14", sfdp: sfdpPayload } },
};

test("sfdp nested inside software.data counts as a previous section", () => {
	assert.equal(hasPreviousSection("sfdp", publishedSections), true);
	assert.equal(hasPreviousSection("ranks", publishedSections), true);
});

test("sfdp absent / null / unpublished-software all read as 'never fetched'", () => {
	assert.equal(hasPreviousSection("sfdp", null), false);
	assert.equal(hasPreviousSection("sfdp", {}), false);
	assert.equal(
		hasPreviousSection("sfdp", {
			software: { ok: true, data: { version: "2.2.14", sfdp: null } },
		}),
		false,
	);
	// A missing identity publishes software without sfdp at all.
	assert.equal(
		hasPreviousSection("sfdp", { software: { ok: true, data: {} } }),
		false,
	);
	// A software section that itself failed carries no sfdp either.
	assert.equal(
		hasPreviousSection("sfdp", {
			software: { ok: false, reason: "not_found", detail: "gone" },
		}),
		false,
	);
});

test("a stored sfdp makes the 24 h clock authoritative again", () => {
	const now = Date.UTC(2026, 9, 7, 12);
	// 1 h after the previous publish: present-and-fresh must NOT be refetched.
	assert.equal(hasPreviousSection("sfdp", publishedSections), true);
	assert.equal(isSectionDue("sfdp", now, now - HOUR), false);
	// 24 h on the clock: now due, grace notwithstanding.
	assert.equal(isSectionDue("sfdp", now, now - 24 * HOUR), true);
});

// --- Published validator set: stakebot UNION this repo's own validator list ---
// The stakebot stats file covers only a fraction of the validators the website
// has detail pages for, so a stakebot-only set left most Metrics tabs blank.
// The union must stay deterministic (it drives index.json order), must not
// invent keys, and must never be smaller than the stakebot set.

// 32-char base58-shaped stand-in vote accounts (alphabet excludes 0/O/I/l).
const voteKey = (label: string): string => label.padEnd(32, "z");
const localInfo = (identity: string | null, name: string | null) => ({
	identity,
	name,
	entry: null,
});

test("union: stakebot keys come first in source order, then the site list in validators.json order", () => {
	const stakebot = [voteKey("sbA"), voteKey("sbB"), voteKey("sbC")];
	const siteList = [voteKey("siteA"), voteKey("siteB")];
	const union = unionValidatorSets(stakebot, siteList);
	assert.deepEqual(union.voteAccounts, [...stakebot, ...siteList]);
	assert.equal(union.stakebotCount, 3);
	assert.equal(union.siteCount, 2);
});

test("union: a vote account listed by both sources appears exactly once, at its stakebot position", () => {
	const shared = voteKey("shared");
	const union = unionValidatorSets(
		[voteKey("sbA"), shared, voteKey("sbB")],
		[voteKey("siteA"), shared, voteKey("siteB"), shared],
	);
	assert.deepEqual(union.voteAccounts, [
		voteKey("sbA"),
		shared,
		voteKey("sbB"),
		voteKey("siteA"),
		voteKey("siteB"),
	]);
	// siteCount reports the (already de-duped) source list it was handed.
	assert.equal(union.siteCount, 4);
	assert.equal(new Set(union.voteAccounts).size, union.voteAccounts.length);
});

test("the published set is never smaller than the stakebot-only set", () => {
	const stakebot = [voteKey("sbA"), voteKey("sbB"), voteKey("sbC")];
	for (const siteList of [
		[],
		[voteKey("sbA")],
		[voteKey("siteA"), voteKey("sbB"), voteKey("siteB")],
	]) {
		const union = unionValidatorSets(stakebot, siteList);
		assert.ok(union.voteAccounts.length >= stakebot.length);
		for (const vote of stakebot) {
			assert.ok(union.voteAccounts.includes(vote));
		}
	}
});

test("site list: only validators.json rows the website has a page for, in validators.json order", () => {
	const siteList = collectSiteListPubkeys(
		new Map([
			[voteKey("siteA"), localInfo("identA", "Figment")],
			// No validatorInfo.json entry for this identity -> the website has
			// no page for it -> deliberately excluded.
			[voteKey("noInfo"), localInfo("identUnknown", null)],
			// No identity at all -> nothing to join on.
			[voteKey("noIdentity"), localInfo(null, null)],
			[voteKey("siteB"), localInfo("identB", "Helius")],
			// Malformed shape never enters the published set, same as the
			// stakebot source.
			["not-a-valid-base58-vote-account-at-all-!!", localInfo("identC", "Bad")],
		]),
	);
	assert.deepEqual(siteList, [voteKey("siteA"), voteKey("siteB")]);
});

// --- ranks publication for validators outside The Vault's peer group ---
// The `vault` cell (stake.vault / performance.vault) is null for
// validators outside The Vault's peer group — now the MAJORITY of the published
// set (Figment is global rank 1/681 with no Vault group). The payload is a
// verbatim passthrough, so it must never be coerced to 0 or reshaped. Payloads
// below are the real upstream shapes.

const VOTE = voteKey("published");

type PublishedFile = {
	sections: Record<string, { ok: boolean; data: Record<string, unknown> }>;
};

const publishedFile = (
	ranksData: unknown,
): { raw: string; file: PublishedFile } => {
	const { contents } = buildFiles(
		[
			{
				voteAccount: VOTE,
				info: localInfo("ident", "Figment"),
				previous: null,
				fresh: { ranks: { ok: true, data: ranksData } },
			},
		],
		null,
		null,
		PUBLISH_NOW,
	);
	const raw = contents.get(`validator-metrics/${VOTE}.json`) as string;
	return { raw, file: JSON.parse(raw) as PublishedFile };
};

const publishedRanks = (file: PublishedFile) => file.sections.ranks;

// stake.vault / performance.vault, the cell the Metrics tab renders.
const vaultCell = (data: Record<string, unknown>, group: string): unknown =>
	(data[group] as Record<string, unknown>)["vault"];

// The publish clock, pinned so delinquency settling is testable (the run passes
// the same now it uses for the cadence clock).
const PUBLISH_NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const MIN = 60_000;

const coverageRow = (epoch: number, endAt: number) => ({
	epoch,
	startAt: endAt - 1000 * MIN,
	endAt,
	partial: false,
	delinquentMs: 0,
	incidents: 0,
});

test("settleDelinquency drops the still-watched row and keeps every closed one", () => {
	const data = {
		votePubkey: VOTE,
		epochs: [
			coverageRow(1049, PUBLISH_NOW - 3000 * MIN),
			coverageRow(1050, PUBLISH_NOW - 2000 * MIN),
			// The live epoch: its endAt is "a minute ago" and moves every read.
			coverageRow(1051, PUBLISH_NOW - MIN),
		],
		incidents: [],
	};
	const settled = settleDelinquency(data, PUBLISH_NOW) as typeof data;
	assert.deepEqual(
		settled.epochs.map((r) => r.epoch),
		[1049, 1050],
	);
	// Everything besides the dropped row survives verbatim, incidents included.
	assert.equal(settled.votePubkey, VOTE);
	assert.deepEqual(settled.epochs[1], data.epochs[1]);
});

test("settleDelinquency returns the same object when nothing is live", () => {
	const data = { epochs: [coverageRow(1050, PUBLISH_NOW - 400 * MIN)], incidents: [] };
	// Identity, not an equal copy: this is what keeps a quiet run byte-identical
	// instead of rewriting the file with a re-serialized payload.
	assert.equal(settleDelinquency(data, PUBLISH_NOW), data);
});

test("settleDelinquency never publishes an empty history", () => {
	// A validator tracked minutes ago has one row and it is live.
	const data = { epochs: [coverageRow(1051, PUBLISH_NOW - MIN)], incidents: [] };
	assert.equal(settleDelinquency(data, PUBLISH_NOW), data);
});

test("settleDelinquency is idempotent and ignores payloads it cannot read", () => {
	const data = {
		epochs: [coverageRow(1050, PUBLISH_NOW - 500 * MIN), coverageRow(1051, PUBLISH_NOW)],
	};
	const once = settleDelinquency(data, PUBLISH_NOW);
	assert.deepEqual(settleDelinquency(once, PUBLISH_NOW), once);
	for (const junk of [null, undefined, 42, "x", {}, { epochs: "not-an-array" }]) {
		assert.deepEqual(settleDelinquency(junk, PUBLISH_NOW), junk);
	}
});

test("published bytes carry no live delinquency row", () => {
	const { contents } = buildFiles(
		[
			{
				voteAccount: VOTE,
				info: localInfo("ident", "Figment"),
				previous: null,
				fresh: {
					ranks: { ok: true, data: FIGMENT_RANKS },
					delinquency: {
						ok: true,
						data: {
							votePubkey: VOTE,
							epochs: [
								coverageRow(1050, PUBLISH_NOW - 400 * MIN),
								coverageRow(1051, PUBLISH_NOW - 2 * MIN),
							],
							incidents: [],
						},
					},
				},
			},
		],
		null,
		1051,
		PUBLISH_NOW,
	);
	const published = JSON.parse(
		contents.get(`validator-metrics/${VOTE}.json`) as string,
	) as PublishedFile;
	const epochs = (published.sections.delinquency.data as { epochs: { epoch: number }[] })
		.epochs;
	assert.deepEqual(
		epochs.map((r) => r.epoch),
		[1050],
	);
});

// Live /v1/ranks/CcaHc2L43ZWjwCHART3oZoJvHLAe9hzT2DJNUpBzoTN1 (Figment).
const FIGMENT_RANKS = {
	epoch: 1051,
	stakeSol: 17653054.750562392,
	creditsLastEpoch: 6899849,
	country: "Germany",
	continent: "Europe",
	stake: {
		global: { rank: 1, of: 681 },
		vault: null,
		country: { rank: 1, of: 192 },
		continent: { rank: 1, of: 414 },
	},
	performance: {
		global: { rank: 428, of: 677 },
		vault: null,
		country: { rank: 153, of: 192 },
		continent: { rank: 312, of: 414 },
	},
};

// Live /v1/ranks/mesh3Px7WMi7Dkxke4ZZBULoKHM6sp37wKtg4DwPqPY (the Vault's own
// operator-facing node: global AND vault ranks).
const MESH_RANKS = {
	epoch: 1051,
	stakeSol: 110676.30401641,
	creditsLastEpoch: 6900019,
	country: "Lithuania",
	continent: "Europe",
	stake: {
		global: { rank: 481, of: 681 },
		vault: { rank: 121, of: 157 },
		country: { rank: 17, of: 18 },
		continent: { rank: 309, of: 414 },
	},
	performance: {
		global: { rank: 334, of: 677 },
		vault: { rank: 91, of: 157 },
		country: { rank: 14, of: 18 },
		continent: { rank: 265, of: 414 },
	},
};

test("ranks: no Vault peer group publishes vault: null (key present, never coerced to 0)", () => {
	const { raw, file } = publishedFile(FIGMENT_RANKS);
	const ranks = publishedRanks(file);
	assert.equal(ranks.ok, true);
	// Verbatim: no coercion, no dropped or reordered keys.
	assert.deepEqual(ranks.data, FIGMENT_RANKS);
	assert.equal(vaultCell(ranks.data, "stake"), null);
	assert.equal(vaultCell(ranks.data, "performance"), null);
	assert.equal(raw.match(/"vault": null/g)?.length, 2);
	assert.doesNotMatch(raw, /"vault":\s*0\b/);
});

test("ranks: a payload with no vault key at all is published without one (nothing is back-filled)", () => {
	const { raw, file } = publishedFile({
		epoch: 1051,
		stake: { global: { rank: 679, of: 681 } },
	});
	const ranks = publishedRanks(file);
	assert.equal(ranks.ok, true);
	assert.deepEqual(ranks.data, { epoch: 1051, stake: { global: { rank: 679, of: 681 } } });
	assert.doesNotMatch(raw, /"vault"/);
});

test("ranks: a validator with a Vault peer group keeps its vault ranks verbatim", () => {
	const { raw, file } = publishedFile(MESH_RANKS);
	const ranks = publishedRanks(file);
	assert.equal(ranks.ok, true);
	assert.deepEqual(ranks.data, MESH_RANKS);
	assert.deepEqual(vaultCell(ranks.data, "stake"), { rank: 121, of: 157 });
	assert.deepEqual(vaultCell(ranks.data, "performance"), { rank: 91, of: 157 });
	assert.ok(!raw.includes('"vault": null'));
});
