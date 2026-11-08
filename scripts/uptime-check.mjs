// Checks the hosted demo's public routes and exits 1 on any miss, which fails the scheduled workflow.
// Node's built-in fetch only: no dependency, no secret, and no request that writes state.

const BASE_URL = "https://80-225-220-230.sslip.io";
const TIMEOUT_MS = 15_000;
// Every page route is served the same app shell (try_files falls back to index.html), so the shell is the marker.
const PAGE_PATHS = ["/", "/tour", "/verifiers", "/print"];
const SHELL_MARKERS = ['<div id="root"', "<title>Acquit</title>"];
const SESSION_PATH = "/api/session";

async function checkPage(path) {
  return check(path, async response => {
    const html = await response.text();
    const missing = SHELL_MARKERS.filter(marker => !html.includes(marker));
    return missing.length === 0 ? null : `app shell marker missing: ${missing.join(", ")}`;
  });
}

async function checkSession() {
  return check(SESSION_PATH, async response => {
    const body = await response.json().catch(() => null);
    // The route answers 200 with JSON in both modes: "public" on the hosted demo, "dev" where ACQUIT_DEV=1.
    return body !== null && typeof body === "object" && (body.mode === "public" || body.mode === "dev")
      ? null : "response is not the session JSON (mode is not public or dev)";
  });
}

async function check(path, judge) {
  const url = new URL(path, BASE_URL).href;
  const started = Date.now();
  let status = "-";
  let problem = null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "acquit-uptime-check" } });
    status = String(response.status);
    if (response.status === 200) {
      problem = await judge(response);
    } else {
      await response.body?.cancel();
      problem = `status ${response.status}, expected 200`;
    }
  } catch (error) {
    // fetch wraps the socket error in its cause (sometimes an AggregateError), so the code is read from there.
    const cause = error?.cause;
    problem = `request failed: ${cause?.code ?? cause?.errors?.[0]?.code ?? cause?.cause?.code ?? error?.name ?? "unknown error"}`;
  }
  const elapsed = Date.now() - started;
  const result = { path, status, elapsed, problem };
  const line = `${problem === null ? "PASS" : "FAIL"} ${status.padEnd(3)} ${String(elapsed).padStart(6)} ms  ${url}${problem === null ? "" : `  -> ${problem}`}`;
  console.log(line);
  if (problem !== null) console.log(`::error title=Uptime check failed::${url} ${problem}`);
  return result;
}

const results = [];
for (const path of PAGE_PATHS) results.push(await checkPage(path));
results.push(await checkSession());

const failed = results.filter(result => result.problem !== null);
console.log(`${new Date().toISOString()} uptime: ${results.length - failed.length} of ${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
