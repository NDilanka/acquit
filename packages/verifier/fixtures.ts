// The verifier's view of the fixture registry. The registry file is named by ACQUIT_FIXTURES (an
// absolute path, like the hidden-case store it replaces); each entry names its frozen commit, its
// frozen test path, the extractor for its frozen cases, and its own private case file. The book
// loads every fixture's cases once at boot and digests them; a run's manifest selects its cases by
// that digest, so each run is judged against exactly the cases its job froze.

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureCasesPath, parseFixtureRegistry, refuseDuplicateDigests } from "../core/src/fixtures.ts";
import { FixtureConfigError } from "../core/src/fixtures.ts";
import type { FixtureContract, FixtureEntry, FixtureRef } from "../core/src/fixtures.ts";
import type { Digest, TestId } from "../core/src/ids.ts";
import type { HiddenCase } from "../core/src/verifier.ts";
import { FROZEN_EXTRACTORS } from "./frozen-cases.ts";
import { loadHiddenCasesFromFile, publicExampleDigest } from "./hidden.ts";
import { hiddenContractOf } from "./hidden.ts";

export { FixtureConfigError } from "../core/src/fixtures.ts";

/** The registry file this deployment's fixtures are declared in. It replaces ACQUIT_HIDDEN_CASES. */
export const FIXTURES_ENV = "ACQUIT_FIXTURES";
/** The committed development registry: fixture 1 over the public example cases, under ACQUIT_DEV=1. */
export const EXAMPLE_FIXTURES_PATH = fileURLToPath(new URL("./fixtures/fixtures.example.json", import.meta.url));

export type FixtureRegistry = { readonly entries: readonly FixtureEntry[]; readonly path: string };

/**
 * The environment policy: an absolute registry path is the deployment's declaration. Without one,
 * only an explicit development process falls back to the committed example; everything else refuses
 * by name before the process listens.
 */
export function loadFixtureRegistry(env: NodeJS.ProcessEnv = process.env): FixtureRegistry {
	const named = env[FIXTURES_ENV]?.trim() ?? "";
	if (named === "") {
		if (env.ACQUIT_DEV === "1") return { entries: parseFixtureRegistry(readFileSync(EXAMPLE_FIXTURES_PATH, "utf8"), EXAMPLE_FIXTURES_PATH), path: EXAMPLE_FIXTURES_PATH };
		throw new FixtureConfigError("FIXTURES_CONFIG_MISSING", [FIXTURES_ENV],
			"Set it to the absolute path of this deployment's fixture registry. ACQUIT_DEV=1 falls back to the committed example.");
	}
	if (!isAbsolute(named)) throw new FixtureConfigError("FIXTURES_CONFIG_INVALID", [FIXTURES_ENV], `Give an absolute path, not ${named}.`);
	return { entries: parseFixtureRegistry(readFileSync(named, "utf8"), named), path: named };
}

/** One fixture's judged data: its registry entry, its private cases, their digest, and its frozen extractor. */
export type FixtureBookEntry = {
	readonly entry: FixtureEntry;
	readonly cases: readonly HiddenCase[];
	readonly digest: Digest;
	readonly frozenCases: (source: string) => readonly HiddenCase[];
};

export type FixtureBook = {
	/** The registry file the book was built from. A path, never a case value. */
	readonly source: string;
	readonly byDigest: ReadonlyMap<Digest, FixtureBookEntry>;
};

/**
 * Loads every fixture's private case file once, names the book's selector (the digest), and refuses
 * the deployment that would be ambiguous: two fixtures holding one case set, or a non-dev
 * deployment pointing a fixture at the committed public example.
 */
export function buildFixtureBook(registry: FixtureRegistry, env: NodeJS.ProcessEnv = process.env): FixtureBook {
	const dev = env.ACQUIT_DEV === "1";
	const byDigest = new Map<Digest, FixtureBookEntry>();
	const digests: { readonly digest: Digest; readonly at: string }[] = [];
	for (const entry of registry.entries) {
		const extractor = FROZEN_EXTRACTORS[entry.frozenExtractor];
		if (!extractor) throw new FixtureConfigError("FIXTURES_CONFIG_INVALID", [FIXTURES_ENV],
			`fixture ${entry.repository}#${entry.issue.number} names frozen extractor "${entry.frozenExtractor}", which this build does not carry.`);
		const path = fixtureCasesPath(entry, registry.path);
		let cases: readonly HiddenCase[];
		try {
			cases = loadHiddenCasesFromFile(path, { count: entry.hidden, idPrefix: entry.hiddenIdPrefix });
		} catch (error) {
			throw new FixtureConfigError("FIXTURES_CONFIG_INVALID", [FIXTURES_ENV], error instanceof Error ? error.message : String(error));
		}
		const digest = hiddenContractOf(cases).digest;
		if (!dev && digest === publicExampleDigest()) {
			throw new FixtureConfigError("FIXTURES_CONFIG_INVALID", [FIXTURES_ENV],
				`${path} parses to the committed public example. Name this deployment's own private cases, or set ACQUIT_DEV=1 for a development run.`);
		}
		digests.push({ digest, at: path });
		byDigest.set(digest, { entry, cases, digest, frozenCases: extractor });
	}
	refuseDuplicateDigests(digests);
	return { source: registry.path, byDigest };
}

const frozenTestIds = (count: number): readonly TestId[] => Array.from({ length: count }, (_, i) => `frozen:${i + 1}` as TestId);

/** What core's OpenJob freezes: one contract per registered fixture, its hidden ids and digest derived once. The cases are dropped at this line. */
export function fixtureContracts(registry: FixtureRegistry): readonly FixtureContract[] {
	return registry.entries.map(entry => {
		const cases = loadHiddenCasesFromFile(fixtureCasesPath(entry, registry.path), { count: entry.hidden, idPrefix: entry.hiddenIdPrefix });
		const hidden = hiddenContractOf(cases);
		return { repository: entry.repository, issue: entry.issue, frozenAt: entry.frozenAt, frozenTestPath: entry.frozenTestPath,
			frozenTests: frozenTestIds(entry.visible), hiddenTests: hidden.ids, hiddenManifest: hidden.digest,
			protectedPaths: entry.protectedPaths, ...(entry.demoForkPrefix === undefined ? {} : { demoForkPrefix: entry.demoForkPrefix }) };
	});
}

/** What the store's manifest backfill matches jobs by. No case file is read. */
export function fixtureRefs(registry: FixtureRegistry): readonly FixtureRef[] {
	return registry.entries.map(entry => ({ repository: entry.repository, issue: { number: entry.issue.number },
		frozenTestPath: entry.frozenTestPath, demoForkPrefix: entry.demoForkPrefix }));
}

/** The registry path a boot line names: the deployment's file, or the committed example in development. */
export function fixtureRegistrySource(env: NodeJS.ProcessEnv = process.env): string {
	return env[FIXTURES_ENV]?.trim() || (env.ACQUIT_DEV === "1" ? EXAMPLE_FIXTURES_PATH : "");
}
