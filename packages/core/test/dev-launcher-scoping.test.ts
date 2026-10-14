// The `npm run dev` launcher hands its API and verifier children the environment they resolve the
// private scoping store from. It must never name an ACQUIT_SCOPING_DIR itself: an explicit
// override skips the shared resolver's fail-fast guard, and the old in-repo default parked
// private case files inside the git work tree. With no override anywhere, both children resolve
// the private default themselves — the same environment, the same DATABASE_PATH, the same store —
// and that store sits outside every repository.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveScopingDir } from "../src/scoping-dir.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const cleanUp = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });

// A stub child records the environment the launcher actually handed it, then stays alive until
// the launcher's own teardown kills it.
const stub = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.STUB_OUT, JSON.stringify({ label: process.argv[1], env: { ...process.env } }) + "\\n");
setInterval(() => {}, 1 << 30);
`;

type Recorded = { label: string; env: NodeJS.ProcessEnv };

test("the dev launcher's API and verifier children carry no in-repo scoping override", async () => {
	const repo = mkdtempSync(join(tmpdir(), "acquit-dev-repo-"));
	const home = mkdtempSync(join(tmpdir(), "acquit-dev-home-"));
	let launcher: ReturnType<typeof spawn> | null = null;
	try {
		// The launcher runs from its own repo layout: the real script, copied, over stub children.
		mkdirSync(join(repo, "scripts"));
		copyFileSync(join(repoRoot, "scripts", "dev.mjs"), join(repo, "scripts", "dev.mjs"));
		mkdirSync(join(repo, "apps", "api", "src"), { recursive: true });
		mkdirSync(join(repo, "packages", "verifier"), { recursive: true });
		writeFileSync(join(repo, "apps", "api", "src", "server.ts"), stub);
		writeFileSync(join(repo, "packages", "verifier", "server.ts"), stub);
		const webStub = join(repo, "web-stub.mjs");
		writeFileSync(webStub, stub);
		const stubOut = join(repo, "children.jsonl");

		const baseEnv: NodeJS.ProcessEnv = { ...process.env };
		delete baseEnv.ACQUIT_SCOPING_DIR;
		launcher = spawn(process.execPath, ["scripts/dev.mjs"], {
			cwd: repo, detached: true,
			// A production dev run: no scoping override anywhere, this run's own home, and a database
			// beside the source it serves — the store still must never follow it into the repo.
			env: { ...baseEnv, XDG_CONFIG_HOME: "", HOME: home, DATABASE_PATH: join(repo, "data", "acquit.db"),
				npm_execpath: webStub, STUB_OUT: stubOut },
			stdio: ["ignore", "ignore", "pipe"],
		});

		const recorded = await new Promise<Recorded[]>((settle, fail) => {
			let err = "";
			launcher!.stderr!.on("data", (chunk: Buffer) => { err += String(chunk); });
			launcher!.on("exit", code => fail(new Error(`the launcher exited early (${code}): ${err}`)));
			const deadline = Date.now() + 15_000;
			const tick = () => {
				let lines: string[] = [];
				try { lines = readFileSync(stubOut, "utf8").trim().split("\n").filter(Boolean); } catch { lines = []; }
				if (lines.length >= 3) return settle(lines.map(line => JSON.parse(line) as Recorded));
				if (Date.now() > deadline) return fail(new Error(`the children never recorded their environment: ${err}`));
				setTimeout(tick, 50);
			};
			tick();
		});
		launcher.kill("SIGTERM");
		await new Promise<void>(settled => launcher!.once("exit", () => settled()));

		const envOf = (suffix: string) => recorded.find(record => record.label.endsWith(suffix))?.env;
		const apiEnv = envOf("apps/api/src/server.ts");
		const verifierEnv = envOf("packages/verifier/server.ts");
		assert.ok(apiEnv, "the launcher spawned the API child");
		assert.ok(verifierEnv, "the launcher spawned the verifier child");
		const children: Array<[string, NodeJS.ProcessEnv]> = [["API", apiEnv], ["verifier", verifierEnv]];
		for (const [label, childEnv] of children) {
			const override = childEnv.ACQUIT_SCOPING_DIR;
			assert.ok(override === undefined || override.trim() === "" || !resolve(override).startsWith(resolve(repo)),
				`the launcher named an in-repo ACQUIT_SCOPING_DIR for the ${label} child: ${override}`);
			const store = resolveScopingDir(childEnv);
			assert.ok(!resolve(store).startsWith(resolve(repo)), `the ${label} child's scoping store ${store} sits inside the repository`);
		}
		assert.equal(resolveScopingDir(apiEnv), resolveScopingDir(verifierEnv),
			"both children must resolve the same scoping store from the launcher's environment");
	} finally {
		try { if (launcher?.pid) process.kill(-launcher.pid, "SIGKILL"); } catch { /* already gone */ }
		cleanUp(repo); cleanUp(home);
	}
});
