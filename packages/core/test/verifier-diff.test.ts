// The screen must see every way a protected path can change, not only the added lines of a patch.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommitSha } from "../src/ids.ts";
import { screenDiff } from "../src/verifier.ts";
import type { DefinitionOfDone, RejectReason } from "../src/verifier.ts";
import { gitSource } from "../../verifier/judge.ts";

const protectedPaths: DefinitionOfDone["protectedPaths"] = ["tests/**", ".github/**", "package.json", "package-lock.json"];
const definitionOfDone = { protectedPaths } as DefinitionOfDone;

function frozenRepository(): { readonly repo: string; readonly frozen: CommitSha; readonly remove: () => void } {
	const repo = mkdtempSync(join(tmpdir(), "acquit-screen-"));
	mkdirSync(join(repo, "tests"), { recursive: true });
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "package.json"), '{"name":"invoice-app"}\n');
	writeFileSync(join(repo, "tests/totals.test.ts"), 'import { expect } from "vitest";\nexpect(1).toBe(1);\n');
	writeFileSync(join(repo, "src/money.ts"), "export function formatTotal(): string { return \"1\"; }\n");
	const git = (args: readonly string[]) => {
		const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
		return result.stdout.trim();
	};
	git(["init", "-q"]);
	git(["config", "user.email", "fixture@example.invalid"]);
	git(["config", "user.name", "fixture"]);
	git(["add", "-A"]);
	git(["commit", "-qm", "frozen"]);
	return { repo, frozen: git(["rev-parse", "HEAD"]) as CommitSha, remove: () => rmSync(repo, { recursive: true, force: true }) };
}

function commitFrom(fixture: { readonly repo: string; readonly frozen: CommitSha }, branch: string, mutate: (repo: string) => void): CommitSha {
	const git = (args: readonly string[]) => {
		const result = spawnSync("git", ["-C", fixture.repo, ...args], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
		return result.stdout.trim();
	};
	git(["checkout", "-q", "-B", branch, fixture.frozen]);
	mutate(fixture.repo);
	git(["add", "-A"]);
	git(["commit", "-qm", branch]);
	return git(["rev-parse", "HEAD"]) as CommitSha;
}

const paths = (reasons: readonly RejectReason[]): readonly string[] =>
	reasons.filter((reason): reason is Extract<RejectReason, { kind: "PROTECTED_PATH_MODIFIED" }> => reason.kind === "PROTECTED_PATH_MODIFIED").map(reason => reason.path);

test("every protected-path change is screened, not only the added lines of a patch", () => {
	const fixture = frozenRepository();
	try {
		const source = gitSource(fixture.repo);
		const observed: Record<string, readonly string[]> = {};
		for (const [name, mutate] of [
			["deleted", (repo: string) => rmSync(join(repo, "tests/totals.test.ts"))],
			["renamed", (repo: string) => spawnSync("git", ["-C", repo, "mv", "tests/totals.test.ts", "tests/totals-renamed.test.ts"])],
			["mode-changed", (repo: string) => chmodSync(join(repo, "tests/totals.test.ts"), 0o755)],
			["binary-added", (repo: string) => writeFileSync(join(repo, "tests/fixture.bin"), Buffer.from([0, 1, 2, 3]))],
			["source-edited", (repo: string) => writeFileSync(join(repo, "src/money.ts"), "export function formatTotal(): string { return \"2\"; }\n")],
		] as const) {
			const head = commitFrom(fixture, name, mutate);
			observed[name] = paths(screenDiff(source.diff(fixture.frozen, head), definitionOfDone));
		}
		assert.deepEqual(observed, {
			deleted: ["tests/totals.test.ts"],
			renamed: ["tests/totals.test.ts"],
			"mode-changed": ["tests/totals.test.ts"],
			"binary-added": ["tests/fixture.bin"],
			"source-edited": [],
		});
	} finally { fixture.remove(); }
});
