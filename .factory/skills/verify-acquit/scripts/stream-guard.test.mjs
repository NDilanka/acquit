import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browserEnvOf, disableStream, namespaceDirName, runtimeRoot, streamGuard } from "./stream-guard.mjs";

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
	assert.equal(streamGuard("verify-acquit-lane-50", { XDG_RUNTIME_DIR: xdg }, home).ok, true);
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

test("the guard inspects the browser's own runtime root, never a stale parent override", () => {
	// fund-escrow.mjs strips every AGENT_BROWSER_* name before the browser child starts; the guard
	// must resolve the runtime root from that same stripped environment, or a stale empty namespace
	// under the parent's override passes for the real session while the real stream file sits in
	// the XDG layout the browser actually uses.
	const xdg = mkdtempSync(join(tmpdir(), "stream-guard-"));
	const override = mkdtempSync(join(tmpdir(), "stream-guard-"));
	layout(join(xdg, "agent-browser"), "verify-acquit-lane-50", ["verify-acquit-lane-50.stream"]);
	layout(join(override, "agent-browser"), "verify-acquit-lane-50", []);
	const parent = { AGENT_BROWSER_SOCKET_DIR: override, XDG_RUNTIME_DIR: xdg };
	assert.equal(runtimeRoot(parent), override, "the parent would resolve the stale override");
	const clean = browserEnvOf(parent);
	assert.equal(clean.AGENT_BROWSER_SOCKET_DIR, undefined, "the browser environment carries no override");
	assert.equal(runtimeRoot(clean, home), join(xdg, "agent-browser"));
	const guard = streamGuard("verify-acquit-lane-50", clean, home);
	assert.equal(guard.ok, false, "the real stream file is found, so approval is refused");
	assert.match(guard.reason, /stream file/i);
});

test("reports a failed stream disable instead of swallowing it", async () => {
	await assert.rejects(() => disableStream(async () => { throw new Error("browser command failed"); }), /Stream disable failed/);
	await disableStream(async () => null);
	await disableStream(async () => { throw new Error("Browser command failed: stream, disable. Streaming is not enabled for this session"); });
});
