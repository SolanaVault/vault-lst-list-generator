import fs from "node:fs";
import path from "node:path";
import { saveDataToGitHub } from "./helpers/github";
import {
	fetchJsonWithRetry,
	fetchTextWithRetry,
	isVoteNotFound,
} from "./helpers/metricsFetch";
import validatorInfoJson from "./validatorInfo.json";
import validatorsJson from "./validators.json";

// Pre-computed validator-metrics publisher (spec sections 1 and 2). The only
// endpoints ever called are the ones built in fetchDueSections / cluster
// epochs / the stakebot pointer files — never /v1/gauges, /v1/reports,
// /v1/stake-sources, /v1/alerts, /v1/digests, /v1/feed-health, and never a
// POST. software.current and rewards are local joins with no HTTP at all.

const DEFAULT_BASE_URL = "https://validator-metrics.vaultapi.dev";
const STAKEBOT_RAW_BASE =
	"https://raw.githubusercontent.com/SolanaVault/stakebot-data/refs/heads/main";
const PUBLISHED_BASE_URL =
	"https://raw.githubusercontent.com/SolanaVault/vault-lst-list-generator/main";
// Raw-HTTP carries read: merge.ts's discipline, 10 s timeout, non-fatal.
const PREVIOUS_READ_TIMEOUT_MS = 10_000;
// A timed-out previous read costs a full re-commit of byte-identical files
// (unchanged(null) is false by design), so give it one retry before giving
// up — see fetchPreviousJson.
const PREVIOUS_READ_ATTEMPTS = 2;
const BASE58_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// A stakebot schema change must not silently publish an empty page.
const MIN_SET_SIZE = 50;
const MIN_SET_FRACTION_OF_PREVIOUS = 0.5;
// Slots-in-epoch constant, spec 2.4.
const SLOTS_PER_EPOCH = 432_000;
const CLUSTER_EPOCHS_KEEP = 40;
const CLUSTER_EPOCHS_REQUEST_BACK = 40;
const CLUSTER_EPOCHS_REQUEST_FORWARD = 2;

// Per-section refetch age in ms, spec 2 cadence table. software and rewards
// are local joins rebuilt every run, so they have no entry here.
const REFRESH_AGE_MS: Record<string, number> = {
	ranks: 12 * 60 * 60_000,
	bonds: 24 * 60 * 60_000,
	sfdp: 24 * 60 * 60_000,
	delinquency: 6 * 60 * 60_000,
	blockRewards: 6 * 60 * 60_000,
};
// The wall-clock gap between two runs is the cron period MINUS the previous
// run's own duration (generatedAt is stamped mid/late in the run) MINUS
// Actions scheduling jitter. Requiring elapsed >= age exactly therefore
// marks the slowest sections "not due" on any overrun and the cadence
// silently drifts to 12 h, then 18 h. Tolerate elapsed >= age - grace.
export const CADENCE_GRACE_MS = 30 * 60_000;

// Cadence clock (spec 2 sections), pure so the tests can pin every edge.
// A missing/unparseable previous generatedAt makes everything due (spec 2.1);
// a future-dated generatedAt (clock skew) is due as well — negative elapsed
// must never read as "not due yet". Unknown sections default to due.
export const isSectionDue = (
	section: string,
	nowMs: number,
	previousGeneratedMs: number,
): boolean => {
	if (!Number.isFinite(previousGeneratedMs)) {
		return true;
	}
	const elapsedMs = nowMs - previousGeneratedMs;
	if (elapsedMs < 0) {
		return true;
	}
	const ageMs: number | undefined = REFRESH_AGE_MS[section];
	return elapsedMs >= (ageMs ?? 0) - CADENCE_GRACE_MS;
};
// Sections that can be carried forward from the previous file. The age clock
// is run-level: it ticks from the previous index.json generatedAt, the one
// timestamp the byte-stability rules allow (per-validator files must stay
// timestamp-free).
// Per-validator sections are inserted in buildFiles in this fixed order,
// matching the spec 1 example (byte-stability: key order = builder order).

// Does the previous published file already hold this section? A missing key
// means the section was never fetched, so it is due regardless of the clock.
//
// `sfdp` is the one section that is NOT a top-level key: it rides inside
// sections.software.data.sfdp (software itself is a local join rebuilt every
// run). A naive previousSections["sfdp"] lookup is therefore always undefined,
// which silently kills the 24 h cadence and refetches sfdp — 2 live
// api.solana.org calls — for every validator on every run. Look it up where it
// actually lives. A null stored sfdp (no identity, or a failure published as
// null) counts as absent on purpose: retry rather than stay blank forever.
export const hasPreviousSection = (
	section: string,
	previousSections: Record<string, unknown> | null,
): boolean => {
	if (!previousSections) {
		return false;
	}
	if (section === "sfdp") {
		const software = previousSections["software"];
		return (
			isRecord(software) &&
			software.ok === true &&
			isRecord(software.data) &&
			software.data["sfdp"] != null
		);
	}
	return previousSections[section] !== undefined;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// Byte-stability gate: never re-commit a file whose bytes are unchanged. The
// comparison runs against the previous file already read for carries
// (canonicalize(prevParsed) === newBytes iff the data is identical).
// previous === null intentionally returns FALSE: with an unreadable previous
// file the bytes are UNKNOWN, so the run re-commits rather than risking
// skipping a file that did change. fetchPreviousJson retries to make that
// path rare; it stays conservative on purpose.
export const unchanged = (previous: unknown, content: string): boolean => {
	if (previous === null) {
		return false;
	}
	try {
		return serialize(previous) === content;
	} catch {
		return false;
	}
};

const roundTo = (value: number, decimals: number) => {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

type Options = {
	baseUrl: string;
	outDir?: string;
	sample?: number;
	votes?: string[];
	force: boolean;
	concurrency: number;
};

const parseArgs = (argv: string[]): Options => {
	const options: Options = {
		baseUrl: DEFAULT_BASE_URL,
		force: false,
		concurrency: 3,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			i += 1;
			if (i >= argv.length) {
				throw new Error(`Missing value for ${arg}`);
			}
			return argv[i];
		};

		switch (arg) {
			case "--out-dir":
				options.outDir = value();
				break;
			case "--sample": {
				options.sample = Number(value());
				if (!Number.isInteger(options.sample) || options.sample <= 0) {
					throw new Error("--sample must be a positive integer");
				}
				break;
			}
			case "--votes":
				// De-dupe: a repeated key would otherwise commit the same path
				// twice and double-list it in index.json.
				options.votes = [
					...new Set(
						value()
							.split(",")
							.map((vote) => vote.trim())
							.filter((vote) => vote.length > 0),
					),
				];
				if (options.votes.length === 0) {
					throw new Error("--votes must list at least one vote account");
				}
				break;
			case "--force":
				options.force = true;
				break;
			case "--base-url":
				options.baseUrl = value().replace(/\/+$/, "");
				break;
			case "--concurrency": {
				options.concurrency = Number(value());
				if (
					!Number.isInteger(options.concurrency) ||
					options.concurrency <= 0
				) {
					throw new Error("--concurrency must be a positive integer");
				}
				break;
			}
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
};

// Request counters so the cron log shows what a run cost. Each logical
// request counts once even if the retry helper made up to 3 HTTP attempts.
let upstreamRequestCount = 0;
let previousFileReadCount = 0;

const fetchUpstream = async <T = unknown>(
	baseUrl: string,
	endpoint: string,
): Promise<T> => {
	upstreamRequestCount += 1;
	return fetchJsonWithRetry<T>(`${baseUrl}${endpoint}`);
};

// The stakebot pointer file is a bare text path, not JSON.
const fetchUpstreamText = async (
	baseUrl: string,
	endpoint: string,
): Promise<string> => {
	upstreamRequestCount += 1;
	return fetchTextWithRetry(`${baseUrl}${endpoint}`);
};

// Reads a previously published file over raw HTTP. Non-fatal on every failure
// mode (a 404 for a validator added this run is normal) — exactly the discipline
// of helpers/merge.ts:24-41. In --out-dir mode the previous state is read from
// the out dir first: that dir holds the last run's serialized output, and the
// zero-secrets demo loop re-runs against it; production publish never passes a
// local dir and still reads raw GitHub only.
// Retries once: a previous-file read that times out leaves `previous ===
// null`, and the write path then conservatively re-commits byte-identical
// files (see the conservative-write note in the commit loop) — one retry
// keeps a transient edge blip from paying that ~150-file churn cost, and the
// comment there records why we deliberately do NOT suppress writes on an
// unknown previous state instead. A 404 is a definite answer ("no previous
// file"), so it is never retried.
const fetchPreviousJson = async (
	file: string,
	localDir?: string,
): Promise<unknown | null> => {
	previousFileReadCount += 1;
	if (localDir) {
		try {
			const raw = fs.readFileSync(
				path.join(localDir, "validator-metrics", file),
				"utf8",
			);
			return JSON.parse(raw);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error(
					`Could not read previous validator-metrics/${file} from ${localDir}, falling back to raw HTTP:`,
					error,
				);
			}
		}
	}
	let lastError: unknown;
	for (let attempt = 1; attempt <= PREVIOUS_READ_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(
				`${PUBLISHED_BASE_URL}/validator-metrics/${file}`,
				{ signal: AbortSignal.timeout(PREVIOUS_READ_TIMEOUT_MS) },
			);
			if (!response.ok) {
				const httpError = new Error(`HTTP ${response.status}`) as Error & {
					status?: number;
				};
				httpError.status = response.status;
				throw httpError;
			}
			return await response.json();
		} catch (error) {
			lastError = error;
			if ((error as { status?: number }).status === 404) {
				break;
			}
		}
	}
	console.error(
		`Could not read previous validator-metrics/${file}, continuing without it:`,
		lastError,
	);
	return null;
};

// Collect every key whose name contains "vote" (case-insensitive) whose value
// is a 32-44 char base58 string, deduped, first-seen order preserved. The
// shape test here doubles as the "every collected pubkey must pass base58
// shape" gate from spec 2.2 — malformed values can never enter the set.
const collectVotePubkeys = (stats: unknown): string[] => {
	const found = new Set<string>();

	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) {
				walk(item);
			}
			return;
		}
		if (!isRecord(value)) {
			return;
		}
		for (const [key, child] of Object.entries(value)) {
			if (
				key.toLowerCase().includes("vote") &&
				typeof child === "string" &&
				BASE58_SHAPE.test(child)
			) {
				found.add(child);
			}
			walk(child);
		}
	};

	walk(stats);
	return [...found];
};

// Reads the stakebot pointer file, then the stats file it names, and returns
// the validator set as the source orders it (stake-descending).
const collectStakebotSet = async (): Promise<string[]> => {
	const pointer = await fetchUpstreamText(
		STAKEBOT_RAW_BASE,
		"/bot-stats-latest.txt",
	);
	const pointerPath = typeof pointer === "string" ? pointer.trim() : "";
	if (!pointerPath.endsWith(".json") || pointerPath.startsWith("/")) {
		throw new Error(`Unusable stakebot pointer content: ${pointerPath}`);
	}
	const stats = await fetchUpstream<unknown>(
		STAKEBOT_RAW_BASE,
		`/${pointerPath}`,
	);
	if (!isRecord(stats)) {
		throw new Error("Stakebot stats file is not an object");
	}
	return collectVotePubkeys(stats);
};

type ValidatorEntry = (typeof validatorsJson.validators)[number];

type LocalValidatorInfo = {
	identity: string | null;
	name: string | null;
	entry: ValidatorEntry | null;
};

// Local join sources (spec 2.4): vote account -> identity/name/validators.json
// row. Names come from validatorInfo.json, keyed by identity.
const loadLocalValidatorData = (): Map<string, LocalValidatorInfo> => {
	const namesByIdentity = new Map<string, string>();
	for (const info of validatorInfoJson) {
		if (!isRecord(info)) {
			continue;
		}
		const identity = info.identityPubkey;
		const name = isRecord(info.info) ? info.info.name : undefined;
		if (typeof identity === "string" && typeof name === "string") {
			namesByIdentity.set(identity, name);
		}
	}

	const byVote = new Map<string, LocalValidatorInfo>();
	for (const validator of validatorsJson.validators) {
		if (typeof validator?.voteAccountPubkey !== "string") {
			continue;
		}
		const identity =
			typeof validator.identityPubkey === "string"
				? validator.identityPubkey
				: null;
		byVote.set(validator.voteAccountPubkey, {
			identity,
			name: identity ? (namesByIdentity.get(identity) ?? null) : null,
			entry: validator,
		});
	}

	return byVote;
};

// The stakebot stats file covers only a fraction of the validators the website
// actually shows, so a stakebot-only set left most detail pages blank. The
// website renders a detail page for exactly the validators.json rows whose
// identityPubkey has an entry in validatorInfo.json — the same join that
// produced this map's `name` — so every such vote account has to be published
// too. A validators.json row with NO validatorInfo.json match is deliberately
// excluded: the website has no page for it, so publishing metrics for it buys
// nothing. Map insertion order is validators.json order (stake-descending),
// which keeps this list deterministic. The base58 test keeps the
// "every collected pubkey passes the shape gate" rule (spec 2.2) true for this
// second source as well.
export const collectSiteListPubkeys = (
	localData: Map<string, LocalValidatorInfo>,
): string[] => {
	const pubkeys: string[] = [];
	for (const [voteAccount, info] of localData) {
		if (info.name !== null && BASE58_SHAPE.test(voteAccount)) {
			pubkeys.push(voteAccount);
		}
	}
	return pubkeys;
};

// Published set: stakebot keys first, exactly as collectStakebotSet returned
// them, then the site-list votes, de-duped with first-seen order preserved so
// the same inputs always produce the same index.json ordering.
export const unionValidatorSets = (
	stakebotSet: string[],
	siteList: string[],
): {
	stakebotCount: number;
	siteCount: number;
	voteAccounts: string[];
} => ({
	stakebotCount: stakebotSet.length,
	siteCount: siteList.length,
	voteAccounts: [...new Set([...stakebotSet, ...siteList])],
});

export type Section =
	| { ok: true; data: unknown }
	| { ok: false; reason: string; detail: string };

const isSection = (value: unknown): value is Section =>
	isRecord(value) && typeof value.ok === "boolean";

// The only ok:false that means "this fetch failed" — not_found and
// not_recorded are genuine states and must replace the previous payload.
const isUpstreamFailure = (section: Section): boolean =>
	!section.ok && section.reason === "upstream_error";

// Final value for one per-validator section. A failed fetch must never
// destroy a previously good ok:true payload: keep the previous section (the
// fetch failure is still collected in `failures`, so the cron goes red while
// the page keeps its real numbers). When the previous section was itself a
// failure there is nothing to serve, so the new failure wins as before.
export const resolveSectionValue = (
	freshSection: Section | undefined,
	previousSection: Section | undefined,
): Section | undefined => {
	if (freshSection === undefined) {
		return previousSection;
	}
	if (
		isUpstreamFailure(freshSection) &&
		previousSection !== undefined &&
		previousSection.ok
	) {
		return previousSection;
	}
	return freshSection;
};

// True when a failed fetch of `section` would be answered with carried
// forward data. Must stay in sync with resolveSectionValue (including the
// sfdp-inside-software special case) so fetchDueSections only prints
// "serving previous data" when buildFiles actually serves it.
const hasCarriablePrevious = (
	previousSections: Record<string, unknown> | null,
	section: string,
): boolean => {
	if (!previousSections) {
		return false;
	}
	if (section === "sfdp") {
		const software = previousSections.software;
		return (
			isSection(software) &&
			software.ok &&
			isRecord(software.data) &&
			isRecord(software.data.sfdp)
		);
	}
	const carried = previousSections[section];
	return isSection(carried) && carried.ok;
};

const stripKeys =
	(keys: string[]) =>
	(data: unknown): unknown => {
		if (!isRecord(data)) {
			return data;
		}
		const copy = { ...data };
		for (const key of keys) {
			delete copy[key];
		}
		return copy;
	};

// Fetches only the sections due this run. Anything not due is carried forward
// at build time and must NOT appear here — a carried section is never marked
// skipped_stale (that reason is internal only, spec 2). A failed fetch still
// reports (run exits non-zero either way), but when buildFiles will serve the
// previous ok:true payload for it, the collected failure says so explicitly.
const fetchDueSections = async (
	baseUrl: string,
	voteAccount: string,
	identity: string | null,
	force: boolean,
	isDue: (section: string) => boolean,
	previousSections: Record<string, unknown> | null,
	failures: string[],
): Promise<Record<string, Section>> => {
	const due = (section: string) => force || isDue(section);
	const attempts: { section: string; url: string; strip?: string[] }[] = [];
	if (due("ranks")) {
		attempts.push({ section: "ranks", url: `/v1/ranks/${voteAccount}` });
	}
	if (due("bonds")) {
		attempts.push({
			section: "bonds",
			url: `/v1/bonds/${voteAccount}`,
			strip: ["fetchedAt"],
		});
	}
	if (due("delinquency")) {
		attempts.push({
			section: "delinquency",
			url: `/v1/delinquency/${voteAccount}?epochs=30`,
		});
	}
	if (due("blockRewards")) {
		attempts.push({
			section: "blockRewards",
			url: `/v1/block-rewards/${voteAccount}?epochs=15`,
		});
	}
	// sfdp keys off the identity pubkey (not the vote account); no identity,
	// no sfdp. The payload lands inside sections.software.data.sfdp.
	if (identity && due("sfdp")) {
		attempts.push({
			section: "sfdp",
			url: `/v1/sfdp/${identity}`,
			strip: ["checkedAt"],
		});
	}

	const results = await Promise.all(
		attempts.map(async ({ section, url, strip }) => {
			try {
				let data: unknown = await fetchUpstream(baseUrl, url);
				if (strip) {
					data = stripKeys(strip)(data);
				}
				if (section === "blockRewards" && isRecord(data)) {
					// Empty arrays = the validator does not run the mobile app. That is
					// the intended app gap (spec 0), labelled not_recorded, never scary.
					const epochs = data.epochs;
					const recentBlocks = data.recentBlocks;
					if (
						Array.isArray(epochs) &&
						epochs.length === 0 &&
						Array.isArray(recentBlocks) &&
						recentBlocks.length === 0
					) {
						return [
							section,
							{
								ok: false,
								reason: "not_recorded",
								detail: "no recorded block rewards (validator opt-in required)",
							} as Section,
						];
					}
				}
				return [section, { ok: true, data } as Section];
			} catch (error) {
				if (isVoteNotFound(error)) {
					// Not in the current voting set — normal state, spec 2.3.
					return [
						section,
						{
							ok: false,
							reason: "not_found",
							detail: "vote account not found in current voting set",
						} as Section,
					];
				}
				const detail = (error as Error).message;
				// The run stays red either way (spec: failures still recorded); the
				// wording tells the operator whether the page kept its good data.
				failures.push(
					hasCarriablePrevious(previousSections, section)
						? `${voteAccount}: ${section} fetch failed: ${detail}, serving previous data`
						: `${voteAccount}: ${section} fetch failed: ${detail}`,
				);
				return [
					section,
					{ ok: false, reason: "upstream_error", detail } as Section,
				];
			}
		}),
	);

	return Object.fromEntries(results) as Record<string, Section>;
};

// Latest settled cluster epoch: the in-progress epoch is absent upstream, so
// the newest row is the current one. Tolerate out-of-order payloads.
const latestClusterEpoch = (
	epochs: unknown,
): Record<string, unknown> | null => {
	if (!Array.isArray(epochs)) {
		return null;
	}
	let latest: Record<string, unknown> | null = null;
	let latestEpoch = -1;
	for (const epochRow of epochs) {
		if (
			isRecord(epochRow) &&
			typeof epochRow.epoch === "number" &&
			epochRow.epoch > latestEpoch
		) {
			latest = epochRow;
			latestEpoch = epochRow.epoch;
		}
	}
	return latest;
};

const buildSoftwareSection = (
	info: LocalValidatorInfo,
	sfdp: unknown,
): Section => {
	const entry = info.entry;
	if (!entry) {
		// Delisted or missing from the daily snapshot; same ok:false shape spec
		// 2.4 prescribes for missing local data.
		return {
			ok: false,
			reason: "not_found",
			detail: "validator not present in validators.json",
		};
	}
	return {
		ok: true,
		data: {
			version: entry.version,
			commissionPct: entry.commission,
			delinquent: entry.delinquent,
			lastVote: entry.lastVote,
			rootSlot: entry.rootSlot,
			skipRatePct:
				typeof entry.skipRate === "number"
					? roundTo(entry.skipRate * 100, 3)
					: null,
			epochCredits: entry.epochCredits,
			credits: entry.credits,
			activatedStakeSol: entry.activatedStake / 1e9,
			sfdp: isRecord(sfdp) || sfdp === null ? sfdp : null,
		},
	};
};

// Documented estimate (spec 2.4): cluster epoch averages x this validator's
// share of the slots. The UI must label it estimated; we never present it as
// exact.
const buildRewardsSection = (
	info: LocalValidatorInfo,
	clusterLatest: Record<string, unknown> | null,
): Section => {
	const entry = info.entry;
	const totalActiveStake = validatorsJson.totalActiveStake;
	if (
		!entry ||
		clusterLatest === null ||
		typeof clusterLatest.avgRewardsPerLeaderSlotSol !== "number" ||
		typeof clusterLatest.avgMevPerLeaderSlotSol !== "number" ||
		typeof clusterLatest.epoch !== "number" ||
		typeof totalActiveStake !== "number" ||
		totalActiveStake <= 0 ||
		typeof entry.activatedStake !== "number"
	) {
		return {
			ok: false,
			reason: "upstream_error",
			detail: "cluster or validators.json data missing for estimate",
		};
	}
	const leaderSlotsPerEpoch = Math.round(
		(entry.activatedStake / totalActiveStake) * SLOTS_PER_EPOCH,
	);
	return {
		ok: true,
		data: {
			basis: "cluster_epoch_average",
			epoch: clusterLatest.epoch,
			leaderSlotsPerEpoch,
			blockRewardsSol: roundTo(
				leaderSlotsPerEpoch * clusterLatest.avgRewardsPerLeaderSlotSol,
				2,
			),
			mevSol: roundTo(
				leaderSlotsPerEpoch * clusterLatest.avgMevPerLeaderSlotSol,
				2,
			),
			commissionPct: entry.commission,
			clusterAvgRewardsPerLeaderSlotSol:
				clusterLatest.avgRewardsPerLeaderSlotSol,
			clusterEpoch: clusterLatest.epoch,
		},
	};
};

type PhaseA = {
	voteAccount: string;
	info: LocalValidatorInfo;
	previous: unknown | null;
	fresh: Record<string, Section>;
};

// software.current and rewards are local joins: rebuilt every run. Only the
// sfdp payload embedded in software has its own 24 h cadence and is carried
// forward from the previous file's software.data.sfdp. Exported because the
// per-validator publication shape (notably the ranks payload, which is
// published verbatim — see the vault:null test) is pinned by the test suite.
export const buildFiles = (
	phaseA: PhaseA[],
	clusterEpochs: unknown,
	epochFromIndex: number | null,
): {
	contents: Map<string, string>;
	failed: string[];
	epoch: number | null;
} => {
	const clusterLatest = latestClusterEpoch(clusterEpochs);
	const contents = new Map<string, string>();
	const failed: string[] = [];
	let epoch: number | null = null;

	for (const item of phaseA) {
		const { voteAccount, info, previous, fresh } = item;
		const previousFile = isRecord(previous) ? previous : null;
		const previousSections =
			previousFile && isRecord(previousFile.sections)
				? previousFile.sections
				: null;

		// Final section value: fresh from this run, else carried forward verbatim
		// (an absent key means "not due and never fetched", spec 1); a fresh
		// fetch failure yields to a previous ok:true section (resolveSectionValue).
		const sectionValue = (name: string): Section | undefined => {
			const carried = previousSections?.[name];
			return resolveSectionValue(
				fresh[name],
				isSection(carried) ? carried : undefined,
			);
		};

		const ranksEpoch = (source: Section | undefined): number | null =>
			source &&
			source.ok &&
			isRecord(source.data) &&
			typeof source.data.epoch === "number"
				? source.data.epoch
				: null;
		const ranksSection = sectionValue("ranks");
		const validatorEpoch =
			ranksEpoch(ranksSection) ??
			(typeof previousFile?.epoch === "number" ? previousFile.epoch : null);
		if (validatorEpoch !== null && (epoch === null || validatorEpoch > epoch)) {
			epoch = validatorEpoch;
		}

		// sfdp rides inside the locally rebuilt software section and follows the
		// same rule as resolveSectionValue: a failed 24 h sfdp cycle must not
		// blank out a previously published sfdp payload.
		const previousSoftware = previousSections?.software;
		const previousSfdp =
			isSection(previousSoftware) &&
			previousSoftware.ok &&
			isRecord(previousSoftware.data)
				? (previousSoftware.data.sfdp ?? null)
				: null;
		let sfdp: unknown = null;
		if (fresh.sfdp !== undefined) {
			sfdp =
				isUpstreamFailure(fresh.sfdp) && isRecord(previousSfdp)
					? previousSfdp
					: fresh.sfdp.ok
						? fresh.sfdp.data
						: null;
		} else {
			sfdp = previousSfdp;
		}

		const finalSections: Record<string, Section> = {};
		const put = (name: string, value: Section | undefined): void => {
			if (value !== undefined) {
				finalSections[name] = value;
			}
		};
		put("ranks", ranksSection);
		put("delinquency", sectionValue("delinquency"));
		put("blockRewards", sectionValue("blockRewards"));
		put("bonds", sectionValue("bonds"));
		put("software", buildSoftwareSection(info, sfdp));
		put("rewards", buildRewardsSection(info, clusterLatest));

		const usable = Object.values(finalSections).some((section) => section.ok);
		if (!usable) {
			failed.push(voteAccount);
		}

		contents.set(
			`validator-metrics/${voteAccount}.json`,
			serialize({
				$schemaVersion: 1,
				voteAccount,
				identity: info.identity,
				epoch: validatorEpoch ?? epochFromIndex ?? null,
				sections: finalSections,
			}),
		);
	}

	return { contents, failed, epoch };
};

// Sort + dedupe + trim the cluster rows so cluster.json stays byte-stable for
// epochs that have already settled.
const normalizeClusterEpochs = (epochs: unknown): Record<string, unknown>[] => {
	if (!Array.isArray(epochs)) {
		return [];
	}
	const byEpoch = new Map<number, Record<string, unknown>>();
	for (const epochRow of epochs) {
		if (isRecord(epochRow) && typeof epochRow.epoch === "number") {
			byEpoch.set(epochRow.epoch, epochRow);
		}
	}
	return [...byEpoch.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, row]) => row)
		.slice(-CLUSTER_EPOCHS_KEEP);
};

const run = async () => {
	const options = parseArgs(process.argv.slice(2));
	// --sample/--votes would truncate index.json to a handful of validators;
	// those demo flags must never publish.
	if ((options.sample || options.votes) && !options.outDir) {
		console.error(
			"--sample and --votes only write to disk; combine with --out-dir instead of publishing a truncated index",
		);
		process.exit(1);
	}

	const startedAt = Date.now();
	const localData = loadLocalValidatorData();
	const failures: string[] = [];

	// The previous index carries the two things we need: the collapse-gate
	// total and the run-level age clock. Reading it is non-fatal.
	const previousIndexRaw = await fetchPreviousJson(
		"index.json",
		options.outDir,
	);
	const previousIndex = isRecord(previousIndexRaw) ? previousIndexRaw : null;
	const previousTotal =
		previousIndex && typeof previousIndex.total === "number"
			? previousIndex.total
			: null;
	const previousGeneratedMs =
		previousIndex && typeof previousIndex.generatedAt === "string"
			? Date.parse(previousIndex.generatedAt)
			: NaN;
	const generatedAtValid = !Number.isNaN(previousGeneratedMs);
	const nowMs = Date.now();
	const isDue = (section: string) =>
		isSectionDue(section, nowMs, previousGeneratedMs);

	// Validator set (spec 2.2). Unreadable set: publish nothing, exit non-zero.
	let voteAccounts: string[];
	// What this run publishes, reported on the run-level summary line.
	let setComposition = "explicit --votes";
	if (options.votes) {
		// Explicit --votes is a developer-specified demo set; the collapse gate
		// (which compares against the previous index) does not apply to it.
		voteAccounts = options.votes;
	} else {
		let stakebotSet: string[];
		try {
			stakebotSet = await collectStakebotSet();
		} catch (error) {
			console.error(
				"Validator set could not be read from stakebot, publishing nothing:",
				error,
			);
			process.exit(1);
		}
		if (stakebotSet.length < MIN_SET_SIZE) {
			console.error(
				`Validator set collapsed to ${stakebotSet.length} (< ${MIN_SET_SIZE}), publishing nothing`,
			);
			process.exit(1);
		}
		// Union last on purpose: both stakebot gates above must still abort on a
		// broken stakebot file, which the (bigger, local) site list would
		// otherwise paper over. The previous-total collapse comparison then runs
		// against the UNION size, because the union is what gets published.
		const union = unionValidatorSets(
			stakebotSet,
			collectSiteListPubkeys(localData),
		);
		setComposition = `stakebot ${union.stakebotCount} + site list ${union.siteCount} -> ${union.voteAccounts.length} unique`;
		voteAccounts = union.voteAccounts;
		if (
			previousTotal !== null &&
			previousTotal > 0 &&
			voteAccounts.length < previousTotal * MIN_SET_FRACTION_OF_PREVIOUS
		) {
			console.error(
				`Validator set collapsed to ${voteAccounts.length} (< ${Math.round(
					MIN_SET_FRACTION_OF_PREVIOUS * 100,
				)}% of previous total ${previousTotal}), publishing nothing`,
			);
			process.exit(1);
		}
	}
	const sampleNote = options.sample ? `, --sample ${options.sample}` : "";
	if (options.sample) {
		voteAccounts = voteAccounts.slice(0, options.sample);
	}
	console.log(
		`Validator set: ${voteAccounts.length} vote accounts (${setComposition}${sampleNote}; clock: ${
			generatedAtValid
				? `${Math.round((nowMs - previousGeneratedMs) / 60_000)} min since previous publish)`
				: "no previous index, all sections due)"
		}`,
	);

	// Per-validator fetches: concurrency-capped chunks with a small jittered
	// pause between them, matching bot.ts conventions. Each unit reads its own
	// previous file (for carries) and fetches only the sections due.
	const phaseA: PhaseA[] = [];
	for (let i = 0; i < voteAccounts.length; i += options.concurrency) {
		const chunk = voteAccounts.slice(i, i + options.concurrency);
		const results = await Promise.all(
			chunk.map(async (voteAccount) => {
				const local = localData.get(voteAccount) ?? {
					identity: null,
					name: null,
					entry: null,
				};
				const previous = await fetchPreviousJson(
					`${voteAccount}.json`,
					options.outDir,
				);
				const previousSections =
					isRecord(previous) && isRecord(previous.sections)
						? previous.sections
						: null;
				// No previous file (or no key in it) => that section is due, spec 2.1.
				const fresh = await fetchDueSections(
					options.baseUrl,
					voteAccount,
					local.identity,
					options.force,
					(section) =>
						!hasPreviousSection(section, previousSections) || isDue(section),
					previousSections,
					failures,
				);
				return { voteAccount, info: local, previous, fresh };
			}),
		);
		phaseA.push(...results);
		if (i + options.concurrency < voteAccounts.length) {
			await sleep(200 + Math.floor(Math.random() * 300));
		}
	}

	// Cluster epochs: exactly ONE fetch per run (spec 2.3), ≥30 epochs back.
	// Epoch knowledge comes from the previous index or from ranks payloads we
	// already fetched this run — never a second probe.
	let clusterEpochs: Record<string, unknown>[] | null = null;
	let freshClusterContent: string | null = null;
	const ranksEpochValues = phaseA
		.map((item) => item.fresh.ranks)
		.filter((section): section is { ok: true; data: unknown } =>
			Boolean(section && section.ok),
		)
		.map((section) =>
			isRecord(section.data) && typeof section.data.epoch === "number"
				? section.data.epoch
				: null,
		)
		.filter((value): value is number => value !== null);
	const knownEpoch = Math.max(
		typeof previousIndex?.epoch === "number" ? previousIndex.epoch : -1,
		...(ranksEpochValues.length > 0 ? ranksEpochValues : [-1]),
	);
	if (knownEpoch > 0) {
		try {
			const cluster = await fetchUpstream<unknown>(
				options.baseUrl,
				`/v1/cluster-epochs?from=${
					knownEpoch - CLUSTER_EPOCHS_REQUEST_BACK
				}&to=${knownEpoch + CLUSTER_EPOCHS_REQUEST_FORWARD}`,
			);
			clusterEpochs = normalizeClusterEpochs(
				isRecord(cluster) ? cluster.epochs : null,
			);
			if (clusterEpochs.length === 0) {
				throw new Error("cluster-epochs returned no epochs");
			}
			freshClusterContent = serialize({
				$schemaVersion: 1,
				epochs: clusterEpochs,
			});
		} catch (error) {
			failures.push(`cluster-epochs fetch failed: ${(error as Error).message}`);
		}
	} else {
		console.error(
			"No epoch knowledge this run (no previous index, no fresh ranks); skipping the cluster-epochs fetch",
		);
	}

	// Previous cluster.json: fallback when this run could not fetch, and the
	// comparison target so an unchanged cluster.json is not re-committed.
	const previousClusterRaw = await fetchPreviousJson(
		"cluster.json",
		options.outDir,
	);
	if (clusterEpochs === null) {
		const previousCluster = isRecord(previousClusterRaw)
			? normalizeClusterEpochs(previousClusterRaw.epochs)
			: [];
		if (previousCluster.length > 0) {
			clusterEpochs = previousCluster;
		}
	}

	const epochFromIndex =
		previousIndex && typeof previousIndex.epoch === "number"
			? previousIndex.epoch
			: null;
	const { contents, failed, epoch } = buildFiles(
		phaseA,
		clusterEpochs,
		epochFromIndex,
	);

	const indexContent = serialize({
		$schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		epoch: epoch ?? epochFromIndex,
		// Named for what the set actually is since the site-list union: the
		// stakebot targets plus every validator the website has a page for.
		// Free-form on the reader side (z.string()), nothing branches on it.
		validatorSetSource: "stakebot+siteList",
		total: voteAccounts.length,
		wrote: voteAccounts.length - failed.length,
		failed,
		// Per-validator fetch failures: without them a cron that served stale
		// carries looked clean to a reader of the data. generatedAt already makes
		// index.json change every run, so this cannot cost extra commits.
		failures,
		validators: phaseA.map((item) => ({
			voteAccount: item.voteAccount,
			identity: item.info.identity,
			name: item.info.name,
		})),
	});

	// Byte-stability: never re-commit a file whose bytes are unchanged (the
	// gate itself is the module-level unchanged(), shared with cluster.json).
	const filesToCommit: { path: string; content: string }[] = [
		{ path: "validator-metrics/index.json", content: indexContent },
	];
	if (freshClusterContent !== null) {
		if (options.outDir || !unchanged(previousClusterRaw, freshClusterContent)) {
			filesToCommit.push({
				path: "validator-metrics/cluster.json",
				content: freshClusterContent,
			});
		}
	} else if (isRecord(previousClusterRaw)) {
		// Carry the previous cluster.json forward. Gate it with the same
		// unchanged() comparison the validator files use: serialize(previous)
		// is byte-identical to what is already published, and committing it on
		// every failed-cluster run was pure churn. --out-dir still writes so
		// the on-disk mirror stays complete.
		const carriedContent = serialize(previousClusterRaw);
		if (options.outDir || !unchanged(previousClusterRaw, carriedContent)) {
			filesToCommit.push({
				path: "validator-metrics/cluster.json",
				content: carriedContent,
			});
		}
	}

	let carried = 0;
	for (const item of phaseA) {
		const content = contents.get(
			`validator-metrics/${item.voteAccount}.json`,
		) as string;
		// unchanged(null) === false here is deliberate: if this run could not
		// read a validator's previous file at all, its bytes are unknown and
		// re-committing ~150 byte-identical files beats risking a skip of a
		// file that did change. The fix for the churn is upstream
		// (fetchPreviousJson now retries once to make timeouts rare); the
		// conservative write path is intentionally left alone.
		if (!options.outDir && unchanged(item.previous, content)) {
			carried += 1;
			continue;
		}
		filesToCommit.push({
			path: `validator-metrics/${item.voteAccount}.json`,
			content,
		});
	}

	if (options.outDir) {
		const targetDir = path.join(options.outDir, "validator-metrics");
		fs.mkdirSync(targetDir, { recursive: true });
		for (const file of filesToCommit) {
			fs.writeFileSync(path.join(options.outDir, file.path), file.content);
		}
		console.log(
			`Wrote ${filesToCommit.length} files to ${options.outDir} (no GitHub publish)`,
		);
	} else {
		console.log(
			`Saving ${filesToCommit.length} files to GitHub (${carried} unchanged validator files not re-committed)`,
		);
		await saveDataToGitHub(filesToCommit);
	}
	console.log(
		`Run done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${
			voteAccounts.length
		} validators, ${failed.length} without usable data, ${upstreamRequestCount} upstream requests, ${previousFileReadCount} previous-file reads`,
	);

	if (failed.length > 0) {
		console.error(
			`Note: ${failed.length} validator(s) produced no usable data (see index.json failed list)`,
		);
	}

	// Same discipline as bot.ts: publish happened above; now make the workflow
	// red for anything that genuinely failed upstream.
	if (failures.length > 0) {
		console.error(
			`Failing run: ${failures.length} fetch failure(s) (data for everything else was still saved):`,
		);
		for (const failure of failures) {
			console.error(` - ${failure}`);
		}
		process.exit(1);
	}
};

// Entry point (spec 5: bare run()). Guarded because the cadence clock and
// the section resolver are pure helpers that this repo's node:test suite
// imports — an unguarded run() would launch a live publisher pass at import
// time. Running this file as a script is unaffected.
if (require.main === module) {
	run();
}
