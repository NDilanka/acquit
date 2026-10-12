import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// agent-browser resolves its runtime root as AGENT_BROWSER_SOCKET_DIR verbatim,
// then $XDG_RUNTIME_DIR/agent-browser, then ~/.agent-browser.
export function runtimeRoot(env = process.env, home = homedir()) {
	if (env.AGENT_BROWSER_SOCKET_DIR) return env.AGENT_BROWSER_SOCKET_DIR;
	if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "agent-browser");
	return join(home, ".agent-browser");
}

// Namespace directories collapse doubled underscores while run filenames keep
// the original session string (agent-browser 0.37.1 on this host).
export const namespaceDirName = (ns) => ns.replace(/_{2,}/g, "_");

// The sanitized environment a browser child actually runs under: every
// agent-browser override and every credential-shaped name is removed before
// the child starts. Guarding the session against the parent's environment
// instead would inspect a root the browser never uses -- fail closed when the
// override directory is absent, or worse, pass a stale empty namespace while
// the real stream file sits in the runtime root the browser resolved.
export function browserEnvOf(env) {
	const clean = { ...env };
	for (const name of Object.keys(clean)) {
		if (name.startsWith("AGENT_BROWSER_") || name === "FACTORY_DESKTOP_CDP_PORT"
			|| /PAYPAL|SANDBOX|MERCHANT_ID|PASSWORD|SECRET|TOKEN|API_KEY/.test(name)) delete clean[name];
	}
	return clean;
}

const directory = (path) => {
	try { return statSync(path).isDirectory(); } catch { return false; }
};

// Fail closed: approval may proceed only when the session's runtime namespace
// directory is found and holds no .stream file a stream client could read.
export function streamGuard(ns, env = process.env, home = homedir()) {
	const root = runtimeRoot(env, home);
	if (!directory(root)) return { ok: false, reason: `the agent-browser runtime root could not be resolved at ${root}` };
	const nsDir = join(root, "namespaces", namespaceDirName(ns));
	if (!directory(nsDir)) return { ok: false, reason: `the agent-browser namespace directory could not be resolved at ${nsDir}` };
	let entries;
	try { entries = readdirSync(join(nsDir, "run")); }
	catch { return { ok: false, reason: `the agent-browser run directory could not be read at ${join(nsDir, "run")}` }; }
	const streams = entries.filter((name) => name.endsWith(".stream"));
	if (streams.length > 0) return { ok: false, reason: `a session stream file is still present (${streams.join(", ")}); detach stream clients and retry` };
	return { ok: true, reason: "" };
}

// The stream-state check only means something when the disable command ran, so
// a failed disable is reported instead of swallowed. agent-browser answers
// "Streaming is not enabled for this session" once a disable already
// converged; that answer is the target state, not a failure.
export async function disableStream(browser) {
	try { await browser("stream", "disable"); }
	catch (error) {
		if (/not enabled/i.test(error.message)) return;
		throw new Error(`Stream disable failed. ${error.message}`);
	}
}
