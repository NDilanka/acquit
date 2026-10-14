// The deployment's fixture registry: the fixtures a job may be opened against, each naming its
// frozen commit, its frozen test path, and where its private hidden cases live. OpenJob freezes a
// manifest per job from one entry; the verifier selects the cases for a run from the manifest's
// own digest. This module parses the registry and matches fixtures; it never reads a case file
// (the cases themselves never enter core) and holds no demo fixture of its own.

import type { CommitSha, Digest, TestId } from "./ids.ts";
import type { DefinitionOfDone, Glob } from "./verifier.ts";

/** What a deployment derives from one fixture's private hidden-case file: the ids and their digest. */
export type HiddenContract = { readonly ids: readonly TestId[]; readonly digest: Digest };

/** One registered fixture, as OpenJob freezes it. The manifest is this shape, naming the job's own repository. */
export type FixtureContract = {
	readonly repository: string;
	readonly issue: { readonly number: number; readonly title: string };
	readonly frozenAt: CommitSha;
	readonly frozenTestPath: string;
	readonly frozenTests: readonly TestId[];
	readonly hiddenTests: readonly TestId[];
	readonly hiddenManifest: Digest;
	readonly protectedPaths: readonly Glob[];
	/** The `<org>/` org whose `demo-<visitor>` forks open this fixture; absent, no fork names it. */
	readonly demoForkPrefix?: string;
	/** The fixture's trusted fix commit, the second phase AI scoping's filters require a drafted
	 * case to pass on. Absent, the fixture is not scoped: OpenJob never kicks a draft for it. */
	readonly trustedFix?: CommitSha;
	/** The per-currency-family coverage gate the fixture's draft must satisfy before approval. */
	readonly coverageFamilies?: readonly CurrencyFamily[];
};

/** One family the coverage gate names: its own label, and the currency codes that cover it. */
export type CurrencyFamily = { readonly name: string; readonly currencies: readonly string[] };

/** What the store's manifest backfill matches a stored job by: its fixture's registry reference. */
export type FixtureRef = { readonly repository: string; readonly issue: { readonly number: number }; readonly frozenTestPath: string; readonly demoForkPrefix?: string };

/** One registry file entry, before its private cases are loaded. */
export type FixtureEntry = {
	readonly repository: string;
	readonly issue: { readonly number: number; readonly title: string };
	readonly frozenAt: CommitSha;
	readonly frozenTestPath: string;
	readonly visible: number;
	readonly hidden: number;
	readonly hiddenIdPrefix: string;
	readonly protectedPaths: readonly Glob[];
	/** The fixture's private hidden-case file: absolute, or relative to the registry file's directory. */
	readonly hiddenCases: string;
	/** The literal frozen-case extractor the verifier runs against this fixture's frozen test file. */
	readonly frozenExtractor: string;
	readonly demoForkPrefix?: string;
	/** The fixture's trusted fix commit, the second phase AI scoping's filters require a drafted
	 * case to pass on. Absent, the fixture is not scoped: OpenJob never kicks a draft for it. */
	readonly trustedFix?: CommitSha;
	/** The per-currency-family coverage gate the fixture's draft must satisfy before approval. */
	readonly coverageFamilies?: readonly CurrencyFamily[];
};

export class FixtureConfigError extends Error {
	readonly code: "FIXTURES_CONFIG_MISSING" | "FIXTURES_CONFIG_INVALID";
	/** Environment or field names, never values. */
	readonly names: readonly string[];
	constructor(code: "FIXTURES_CONFIG_MISSING" | "FIXTURES_CONFIG_INVALID", names: readonly string[], detail: string) {
		super(`${code === "FIXTURES_CONFIG_MISSING" ? "Missing configuration" : "Invalid configuration"}: ${names.join(", ")}. ${detail}`);
		this.name = "FixtureConfigError";
		this.code = code;
		this.names = names;
	}
}

function refuse(names: readonly string[], detail: string): never {
	throw new FixtureConfigError("FIXTURES_CONFIG_INVALID", names, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `${repository}#${issue}`: the registry's own key for a fixture. */
export function fixtureKey(repository: string, issue: number): string {
	return `${repository}#${issue}`;
}

/** The manifest OpenJob freezes for a job opened on `repository`: the fixture's own contract, with the job's repository named. */
export function manifestOf(fixture: FixtureContract, repository: string): DefinitionOfDone {
	return { issue: { repository, number: fixture.issue.number, title: fixture.issue.title },
		frozenAt: fixture.frozenAt, frozenTestPath: fixture.frozenTestPath, frozenTests: fixture.frozenTests,
		hiddenTests: fixture.hiddenTests, hiddenManifest: fixture.hiddenManifest, protectedPaths: fixture.protectedPaths };
}

type FixtureKeyed = { readonly repository: string; readonly issue: { readonly number: number }; readonly demoForkPrefix?: string };

/**
 * The fixture a job is opened against: an exact repository and issue match, or — for a visitor
 * actor opening a job on the very repository its session carries — the fixture whose demo fork
 * prefix that repository sits under. Anything else is unregistered.
 */
export function matchFixture<T extends FixtureKeyed>(fixtures: readonly T[], repository: string, issueNumber: number, actorRepository: string | null): T | null {
	const exact = fixtures.find(f => f.repository === repository && f.issue.number === issueNumber && (actorRepository === null || actorRepository === repository));
	if (exact) return exact;
	if (actorRepository !== null && actorRepository === repository) {
		return fixtures.find(f => f.issue.number === issueNumber && f.demoForkPrefix !== undefined
			&& repository.startsWith(`${f.demoForkPrefix}demo-`)) ?? null;
	}
	return null;
}

const ENTRY_FIELDS: readonly string[] = ["repository", "issue", "frozenAt", "frozenTestPath", "visible", "hidden", "hiddenIdPrefix", "protectedPaths", "hiddenCases", "frozenExtractor", "demoForkPrefix", "trustedFix", "coverageFamilies"];
const OWNER_NAME = /^[a-zA-Z0-9-]+$/;
const REPOSITORY_NAME = /^[a-zA-Z0-9._-]+$/;

/** The strict registry parser: unknown fields, a bad shape, or a duplicate fixture refuse by name. */
export function parseFixtureRegistry(text: string, source: string): readonly FixtureEntry[] {
	let value: unknown;
	try { value = JSON.parse(text) as unknown; }
	catch { refuse([source], `${source} is not JSON.`); }
	if (!isRecord(value)) refuse([source], `${source} must hold one object.`);
	for (const key of Object.keys(value)) if (key !== "version" && key !== "fixtures") refuse([source], `${source} has an unknown field ${key}.`);
	if (value.version !== 1) refuse([source], `${source} must carry version 1.`);
	if (!Array.isArray(value.fixtures) || value.fixtures.length === 0) refuse([source], `${source} must carry a non-empty fixtures array.`);
	const seen = new Set<string>();
	const entries: FixtureEntry[] = [];
	for (const [index, raw] of value.fixtures.entries()) {
		const at = `${source} fixture ${index + 1}`;
		if (!isRecord(raw)) refuse([at], `${at} must be an object.`);
		for (const key of Object.keys(raw)) if (!ENTRY_FIELDS.includes(key)) refuse([at], `${at} has an unknown field ${key}.`);
		const repositoryName = String(raw.repository ?? "");
		const [owner, name, ...rest] = repositoryName.split("/");
		if (rest.length > 0 || owner === undefined || name === undefined || !OWNER_NAME.test(owner) || !REPOSITORY_NAME.test(name)) {
			refuse([at], `${at} must carry repository as an owner/name such as maya-client/invoice-app.`);
		}
		const repository = `${owner}/${name}`;
		const issue = raw.issue;
		if (!isRecord(issue)) refuse([at], `${at} must carry an issue object.`);
		for (const key of Object.keys(issue)) if (key !== "number" && key !== "title") refuse([at], `${at} issue has an unknown field ${key}.`);
		const number: unknown = issue.number;
		if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) refuse([at], `${at} issue must carry a positive whole number.`);
		const title = issue.title;
		if (typeof title !== "string" || title === "" || title.length > 300) refuse([at], `${at} issue must carry a title of at most 300 characters.`);
		const frozenAt = raw.frozenAt;
		if (typeof frozenAt !== "string" || !/^[0-9a-f]{40}$/.test(frozenAt)) refuse([at], `${at} must carry frozenAt as a 40-hex commit.`);
		const frozenTestPath = raw.frozenTestPath;
		if (typeof frozenTestPath !== "string" || frozenTestPath === "" || frozenTestPath.length > 300
			|| frozenTestPath.startsWith("/") || frozenTestPath.split("/").includes("..")) {
			refuse([at], `${at} must carry frozenTestPath as a relative path inside the fixture repository.`);
		}
		const visible: unknown = raw.visible;
		if (typeof visible !== "number" || !Number.isSafeInteger(visible) || visible < 1 || visible > 500) refuse([at], `${at} must carry visible as a whole number between 1 and 500.`);
		const hidden: unknown = raw.hidden;
		if (typeof hidden !== "number" || !Number.isSafeInteger(hidden) || hidden < 1 || hidden > 500) refuse([at], `${at} must carry hidden as a whole number between 1 and 500.`);
		const hiddenIdPrefix = raw.hiddenIdPrefix === undefined ? "hidden" : raw.hiddenIdPrefix;
		if (typeof hiddenIdPrefix !== "string" || !/^[a-z][a-z0-9]{0,39}$/.test(hiddenIdPrefix)) {
			refuse([at], `${at} hiddenIdPrefix must be a lowercase name of at most 40 characters.`);
		}
		const protectedPaths = raw.protectedPaths;
		if (!Array.isArray(protectedPaths) || protectedPaths.length === 0 || !protectedPaths.every(p => typeof p === "string" && p.length > 0 && p.length <= 200)) {
			refuse([at], `${at} must carry protectedPaths as a non-empty array of globs.`);
		}
		const hiddenCases = raw.hiddenCases;
		if (typeof hiddenCases !== "string" || hiddenCases === "" || hiddenCases.length > 1024) refuse([at], `${at} must carry hiddenCases as a path.`);
		const frozenExtractor = raw.frozenExtractor;
		if (typeof frozenExtractor !== "string" || frozenExtractor === "" || frozenExtractor.length > 64) refuse([at], `${at} must carry frozenExtractor.`);
		const demoForkPrefix = raw.demoForkPrefix;
		if (demoForkPrefix !== undefined && (typeof demoForkPrefix !== "string" || !/^[a-zA-Z0-9-]+\/$/.test(demoForkPrefix))) {
			refuse([at], `${at} demoForkPrefix must be an owner or org name followed by a slash.`);
		}
		const trustedFix = raw.trustedFix;
		if (trustedFix !== undefined && (typeof trustedFix !== "string" || !/^[0-9a-f]{40}$/.test(trustedFix))) {
			refuse([at], `${at} trustedFix must be a 40-hex commit.`);
		}
		const coverageFamilies = raw.coverageFamilies;
		if (coverageFamilies !== undefined) {
			if (!Array.isArray(coverageFamilies) || coverageFamilies.length === 0) refuse([at], `${at} coverageFamilies must be a non-empty array of families.`);
			for (const family of coverageFamilies) {
				if (!isRecord(family)) refuse([at], `${at} coverageFamilies entry must be an object.`);
				for (const key of Object.keys(family)) if (key !== "name" && key !== "currencies") refuse([at], `${at} coverageFamilies entry has an unknown field ${key}.`);
				const name = family.name;
				if (typeof name !== "string" || name === "" || name.length > 60) refuse([at], `${at} coverageFamilies entry must carry a name of at most 60 characters.`);
				const currencies = family.currencies;
				if (!Array.isArray(currencies) || currencies.length === 0
					|| !currencies.every(code => typeof code === "string" && /^[A-Z]{3}$/.test(code))) {
					refuse([at], `${at} coverageFamilies entry must carry currencies as three-letter uppercase codes.`);
				}
			}
		}
		const key = fixtureKey(repository, number);
		if (seen.has(key)) refuse([at], `${source} registers ${key} twice.`);
		seen.add(key);
		entries.push({ repository, issue: { number, title }, frozenAt: frozenAt as CommitSha, frozenTestPath,
			visible, hidden, hiddenIdPrefix, protectedPaths: protectedPaths as readonly Glob[], hiddenCases, frozenExtractor,
			...(demoForkPrefix === undefined ? {} : { demoForkPrefix }),
			...(trustedFix === undefined ? {} : { trustedFix: trustedFix as CommitSha }),
			...(coverageFamilies === undefined ? {} : { coverageFamilies: coverageFamilies as { name: string; currencies: string[] }[] }) });
	}
	return entries;
}

/** A case file's path as the registry named it: absolute stays, relative resolves beside the registry file. */
export function fixtureCasesPath(entry: FixtureEntry, registryPath: string): string {
	if (entry.hiddenCases.startsWith("/")) return entry.hiddenCases;
	const dir = registryPath.slice(0, registryPath.lastIndexOf("/"));
	return `${dir}/${entry.hiddenCases}`;
}

/** The digest is the run's case selector: a registry that cannot pick one case set per digest is ambiguous. */
export function refuseDuplicateDigests(named: readonly { readonly digest: Digest; readonly at: string }[]): void {
	const seen = new Map<Digest, string>();
	for (const { digest, at } of named) {
		const first = seen.get(digest);
		if (first !== undefined) refuse([at], `${at} and ${first} hold the same hidden cases; give each fixture its own file.`);
		seen.set(digest, at);
	}
}
