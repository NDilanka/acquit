import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { disableStream, namespaceDirName, streamGuard } from "./stream-guard.mjs";

// agent-browser on this host keeps runtime files under
// $XDG_RUNTIME_DIR/agent-browser/namespaces/<prefix>_<ns>/run/ with the
// original session string in the file names (doubled underscores retained).
const layout = (root, ns, files) => {
	const run = join(root, "namespaces", namespaceDirName(ns), "run");
	mkdirSync(run, { recursive: true });
	for (const name of files) writeFileSync(join(run, name), "");
	return run;
};

const home = "/home/stream-guard-unused-home";

test("refuses approval when the session stream file sits in the XDG runtime layout", () => {
	const xdg = mkdtempSync(join(tmpdir(), "stream-guard-"));
	layout(join(xdg, "agent-browser"), "1dbf92f2da68__h2k1", ["1dbf92f2da68__h2k1.config", "1dbf92f2da68__h2k1.stream"]);
	const guard = streamGuard("1dbf92f2da68__h2k1", { XDG_RUNTIME_DIR: xdg }, home);
	assert.equal(guard.ok, false);
	assert.match(guard.reason, /stream file/i);
});

test("refuses approval when any stream file exists in the session's run directory", () => {
	const xdg = mkdtempSync(join(tmpdir(), "stream-guard-"));
	layout(join(xdg, "agent-browser"), "verify-acquit-lane-50", ["other-observer.stream"]);
	const guard = streamGuard("verify-acquit-lane-50", { XDG_RUNTIME_DIR: xdg }, home);
	assert.equal(guard.ok, false);
	assert.match(guard.reason, /stream file/i);
});

test("refuses approval when the runtime root cannot be resolved", () => {
	const xdg = mkdtempSync(join(tmpdir(), "stream-guard-"));
	const guard = streamGuard("verify-acquit-lane-50", { XDG_RUNTIME_DIR: xdg }, home);
	assert.equal(guard.ok, false);
	assert.match(guard.reason, /runtime root/i);
});

test("refuses approval when the namespace directory cannot be resolved", () => {
	const xdg = mkdtempSync(join(tmpdir(), "stream-guard-"));
	mkdirSync(join(xdg, "agent-browser", "namespaces"), { recursive: true });
	const guard = streamGuard("verify-acquit-lane-50", { XDG_RUNTIME_DIR: xdg }, home);
	assert.equal(guard.ok, false);
	assert.match(guard.reason, /namespace directory/i);
});

test("approves when the session's run directory holds no stream file", () => {
	const xdg = mkdtempSync(join(tmpdir(), "stream-guard-"));
	layout(join(xdg, "agent-browser"), "verify-acquit-lane-50", ["verify-acquit-lane-50.config", "verify-acquit-lane-50.target"]);
	assert.deepEqual(streamGuard("verify-acquit-lane-50", { XDG_RUNTIME_DIR: xdg }, home), { ok: true });
});

test("falls back to the home root when XDG_RUNTIME_DIR is unset", () => {
	const homeRoot = mkdtempSync(join(tmpdir(), "stream-guard-"));
	layout(join(homeRoot, ".agent-browser"), "verify-acquit-lane-50", ["verify-acquit-lane-50.stream"]);
	const guard = streamGuard("verify-acquit-lane-50", {}, homeRoot);
	assert.equal(guard.ok, false);
	assert.match(guard.reason, /stream file/i);
});

test("honors AGENT_BROWSER_SOCKET_DIR verbatim, the way agent-browser resolves it", () => {
	const socket = mkdtempSync(join(tmpdir(), "stream-guard-"));
	layout(socket, "verify-acquit-lane-50", ["verify-acquit-lane-50.stream"]);
	const guard = streamGuard("verify-acquit-lane-50", { AGENT_BROWSER_SOCKET_DIR: socket, XDG_RUNTIME_DIR: join(tmpdir(), "stream-guard-unused-xdg") }, home);
	assert.equal(guard.ok, false);
	assert.match(guard.reason, /stream file/i);
});

test("reports a failed stream disable instead of swallowing it", async () => {
	await assert.rejects(() => disableStream(async () => { throw new Error("browser command failed"); }), /Stream disable failed/);
	await assert.resolves(() => disableStream(async () => null));
});
