// The screen must see every way a protected path can change, not only the added lines of a patch.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommitSha, Digest } from "../src/ids.ts";
import { screenDiff } from "../src/verifier.ts";
import type { DefinitionOfDone, Glob, RejectReason } from "../src/verifier.ts";
import { gitSource } from "../../verifier/judge.ts";

const protectedPaths = ["tests/**", ".github/**", "package.json", "package-lock.json"] as Glob[];
const definitionOfDone: DefinitionOfDone = { issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals" },
	frozenAt: "0".repeat(40) as CommitSha, frozenTests: [], hiddenManifest: "0".repeat(64) as Digest, hiddenTests: [], protectedPaths };

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

test("a gitlink in the submitted tree is refused by name, like a symlink", () => {
	const fixture = frozenRepository();
	try {
		const git = (args: readonly string[]) => {
			const result = spawnSync("git", ["-C", fixture.repo, ...args], { encoding: "utf8" });
			if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
			return result.stdout.trim();
		};
		const gitlink = (branch: string, path: string): CommitSha => {
			git(["checkout", "-q", "-B", branch, fixture.frozen]);
			rmSync(join(fixture.repo, path), { recursive: true, force: true });
			git(["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},${path}`]);
			git(["commit", "-qm", branch]);
			return git(["rev-parse", "HEAD"]) as CommitSha;
		};
		const source = gitSource(fixture.repo);
		const added = gitlink("gitlink-added", "vendor/lib");
		assert.deepEqual(screenDiff(source.diff(fixture.frozen, added), definitionOfDone), [{ kind: "TREE_GITLINK", path: "vendor/lib" }]);
		const swapped = gitlink("gitlink-swapped", "src/money.ts");
		assert.deepEqual(screenDiff(source.diff(fixture.frozen, swapped), definitionOfDone), [{ kind: "TREE_GITLINK", path: "src/money.ts" }]);
		const protectedLink = gitlink("gitlink-protected", "tests/sub");
		assert.deepEqual(screenDiff(source.diff(fixture.frozen, protectedLink), definitionOfDone), [
			{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/sub" },
			{ kind: "TREE_GITLINK", path: "tests/sub" },
		]);
	} finally { fixture.remove(); }
});

test("a protected edit and a late source edit past 256 changed paths are still screened", () => {
	const fixture = frozenRepository();
	try {
		const source = gitSource(fixture.repo);
		const head = commitFrom(fixture, "padded", repo => {
			writeFileSync(join(repo, "tests/totals.test.ts"), 'import { expect } from "vitest";\nexpect(2).toBe(2);\n');
			for (let index = 0; index < 300; index++) {
				const dir = join(repo, "aaa", String(index).padStart(3, "0"));
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "note.txt"), `padding ${index}\n`);
			}
			writeFileSync(join(repo, "zzz-late.ts"), 'import { expect } from "vitest";\nexport const late = 1;\n');
		});
		const diff = source.diff(fixture.frozen, head);
		assert.equal(diff.changes.length, 302);
		assert.deepEqual(screenDiff(diff, definitionOfDone), [
			{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" },
			{ kind: "TEST_FRAMEWORK_IN_SOURCE", path: "zzz-late.ts", symbol: "vitest" },
		]);
	} finally { fixture.remove(); }
});
