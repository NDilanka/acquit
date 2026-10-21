// The ask routes over real HTTP: the closed read-only tool set answers the platform and operator roles
// (each its own set), clients and anonymous callers are refused, a tool call executes against the real book, and a turn without a usable provider key is refused
// before any call is attempted (the boot below points HOME at an empty dir, so no droid can spawn).

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_TURNS_PER_MINUTE } from "../src/ask.ts";

const root = join(import.meta.dirname, "..");

function bootServer(port: number, dbPath: string, home: string, extraEnv: Record<string, string> = {}): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5673",
				HOME: home, FACTORY_API_KEY: "",
				...extraEnv,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		const timer = setTimeout(() => rejectBoot(new Error(`server did not boot: ${out} ${err}`)), 30_000);
		child.stdout.on("data", (chunk: Buffer) => {
			out += String(chunk);
			if (out.includes("Acquit API:")) { clearTimeout(timer); resolveBoot(child); }
		});
		child.stderr.on("data", (chunk: Buffer) => { err += String(chunk); });
		child.on("exit", (code) => { clearTimeout(timer); rejectBoot(new Error(`server exited early (${code}): ${out} ${err}`)); });
	});
}

// Windows keeps the database file locked until the server process has exited, so removing the
// temp dir must wait for the exit rather than only signal it.
async function stopServer(child: ReturnType<typeof spawn> | null): Promise<void> {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
	child.kill("SIGTERM");
	await exited;
}

const post = (port: number, path: string, payload: unknown, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json",
		...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });

const get = (port: number, path: string, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test("the ask routes refuse clients and anonymous callers, and the platform's tool set is the closed read-only one", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-ask-route-"));
	const port = 4879;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"), join(dir, "homeless"));
		const minted = await post(port, "/api/platform/session", { key: "test-platform-key-0123456789abcdef" });
		assert.equal(minted.status, 201);
		const { token } = await minted.json() as { token: string };

		const anonymous = await get(port, "/api/ask-ledger/tools");
		assert.equal(anonymous.status, 401, "an unauthenticated ask route is refused before anything else");

		const signedIn = await post(port, "/api/session", { handle: "maya-client" });
		assert.equal(signedIn.status, 200);
		const { token: clientToken } = await signedIn.json() as { token: string };
		for (const attempt of [get(port, "/api/ask-ledger/tools", clientToken),
			post(port, "/api/ask-ledger/turn", { messages: [{ id: "m1", role: "user", content: "hello" }] }, clientToken),
			post(port, "/api/ask-ledger/tool", { name: "platform_totals", arguments: {} }, clientToken)]) {
			const refused = await attempt;
			assert.equal(refused.status, 403, "a client session is not the platform role");
		}

		const tools = await get(port, "/api/ask-ledger/tools", token);
		assert.equal(tools.status, 200);
		const listed = await tools.json() as { tools: { name: string }[]; model: string; keyConfigured: boolean };
		assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["get_dispute", "get_job", "get_order", "get_refund", "list_disputes",
			"list_jobs", "list_transactions", "platform_totals", "trace_figure"]);
		assert.equal(listed.model, "glm-5.3-flash", "the default provider's ask model is the ruled one");
		assert.equal(listed.keyConfigured, false, "a boot with no Factory key says so, without naming one");

		const totals = await post(port, "/api/ask-ledger/tool", { name: "platform_totals", arguments: {} }, token);
		assert.equal(totals.status, 200);
		assert.deepEqual(await totals.json() as unknown, { result: { held: 0, released: 0, refunded: 0, fees: 0, heldJobs: 0 } });

		const unknownTool = await post(port, "/api/ask-ledger/tool", { name: "capture_order", arguments: {} }, token);
		assert.equal(unknownTool.status, 502, "the executor is a closed set");

		const turn = await post(port, "/api/ask-ledger/turn",
			{ messages: [{ id: "m1", role: "user", content: "How much escrow is held right now, and does PayPal agree?" }] }, token);
		assert.equal(turn.status, 503, "no usable provider key, no turn");
		const refused = await turn.json() as { error: string };
		assert.equal(refused.error, "MODEL_KEY_MISSING");
		const log = await readFile(join(dir, "model-calls.jsonl"), "utf8");
		const records = log.split("\n").filter(line => line.trim() !== "").map(line => JSON.parse(line) as { caller: string; phase: string });
		assert.deepEqual(records.map(record => [record.caller, record.phase]),
			[["ask-ledger", "START"], ["ask-ledger", "END"]], "the refused turn still counts against the shared budget");

		// The turn's tool schemas are the loop's own -- the agent's read tools plus the harness's
		// delegate_to -- relayed into the prompt, so a delegated widget run can go through. An
		// unbounded or malformed list is refused.
		const delegated = await post(port, "/api/ask-ledger/turn", {
			messages: [{ id: "m1", role: "user", content: "Add a widget showing held escrow." }],
			tools: [{ name: "delegate_to", description: "Hand work to another agent.", parameters: { type: "object", properties: {} } }],
		}, token);
		assert.equal(delegated.status, 503, "the relayed tools are accepted, the turn still needs a key");
		const tooMany = await post(port, "/api/ask-ledger/turn", {
			messages: [{ id: "m1", role: "user", content: "hello" }],
			tools: Array.from({ length: 33 }, (_, i) => ({ name: `tool_${i}`, description: "x", parameters: { type: "object", properties: {} } })),
		}, token);
		assert.equal(tooMany.status, 400, "an unbounded tool list is refused");
	} finally {
		await stopServer(child);
		await rm(dir, { recursive: true, force: true });
	}
});

test("an operator's ask routes answer its own four tools alone, refuse every other name, and budget each operator's turns apart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-ask-operator-"));
	const port = 4880;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"), join(dir, "homeless"));
		const minted = await post(port, "/api/platform/session", { key: "test-platform-key-0123456789abcdef" });
		assert.equal(minted.status, 201);
		const { token: platformToken } = await minted.json() as { token: string };

		// A second operator, written into this test's own database once the server has created it. The
		// seeded world has one operator; a second is needed to show one operator's budget is its own.
		const seeded = new DatabaseSync(join(dir, "test.db"));
		seeded.prepare("INSERT INTO principals (handle, role, visitor_id) VALUES (?, ?, NULL)").run("rhea-ops", "OPERATOR");
		// Two demo visitors from one network address: minting a second visitor must not add allowance.
		for (const hex of ["00000000000a", "00000000000b"]) {
			const id = `v_${hex}`;
			seeded.prepare("INSERT INTO visitors (id, created_at, expires_at, ip_key, client_handle, operator_handle, repository, repository_id, state) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'ACTIVE')")
				.run(id, "2026-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", "ip_shared", `guest-${hex}`, `guest-${hex}-ops`);
			seeded.prepare("INSERT INTO principals (handle, role, visitor_id) VALUES (?, ?, ?)").run(`guest-${hex}-ops`, "OPERATOR", id);
		}
		seeded.close();

		const sessionFor = async (handle: string): Promise<string> => {
			const signedIn = await post(port, "/api/session", { handle });
			assert.equal(signedIn.status, 200);
			const { token } = await signedIn.json() as { token: string };
			const who = await (await get(port, "/api/session", token)).json() as { user: { role: string } };
			assert.equal(who.user.role, "OPERATOR", `${handle} signs in as an operator`);
			return token;
		};
		const devon = await sessionFor("devon-ops");
		const rhea = await sessionFor("rhea-ops");

		const listed = await get(port, "/api/ask-ledger/tools", devon);
		assert.equal(listed.status, 200);
		const offered = await listed.json() as { tools: { name: string }[] };
		assert.deepEqual(offered.tools.map(tool => tool.name), ["my_jobs", "my_job", "my_payouts", "my_totals"],
			"an operator is offered its own four tools, and no PayPal or book-wide tool");

		for (const name of ["list_jobs", "get_job", "list_transactions", "get_order", "platform_totals", "trace_figure"]) {
			const refused = await post(port, "/api/ask-ledger/tool", { name, arguments: {} }, devon);
			assert.equal(refused.status, 502, `${name} is refused for an operator`);
			assert.deepEqual(await refused.json() as unknown, { error: "TOOL_FAILED", detail: `no tool named ${name}` });
		}

		const totals = await post(port, "/api/ask-ledger/tool", { name: "my_totals", arguments: {} }, devon);
		assert.equal(totals.status, 200);
		assert.deepEqual(await totals.json() as unknown, { result: { paidOutCents: 0, feesWithheldCents: 0, jobsPaid: 0, heldCents: 0, heldJobs: 0 } });

		const unknownJob = await post(port, "/api/ask-ledger/tool", { name: "my_job", arguments: { jobId: "job_nowhere" } }, rhea);
		assert.equal(unknownJob.status, 502);
		assert.deepEqual(await unknownJob.json() as unknown, { error: "TOOL_FAILED", detail: "no job of yours named job_nowhere" });

		const messages = [{ id: "m1", role: "user", content: "What did I earn this week?" }];
		const myJobs = { name: "my_jobs", description: "Your jobs on Acquit.", parameters: { type: "object", properties: {} } };
		for (const tools of [[{ name: "platform_totals", description: "The book's totals.", parameters: { type: "object", properties: {} } }],
			[{ name: "delegate_to", description: "Hand work to another agent.", parameters: { type: "object", properties: {} } }]]) {
			const refused = await post(port, "/api/ask-ledger/turn", { messages, tools }, devon);
			assert.equal(refused.status, 400, "a relayed tool outside the operator's set never reaches the model");
			assert.equal((await refused.json() as { error: string }).error, "BAD_REQUEST");
		}

		// No provider key here, so an admitted turn stops at the model port with 503. The budget is checked first.
		const turn = (token: string) => post(port, "/api/ask-ledger/turn", { messages, tools: [myJobs] }, token);
		for (let admitted = 1; admitted <= OPERATOR_TURNS_PER_MINUTE; admitted += 1) {
			assert.equal((await turn(devon)).status, 503, `turn ${admitted} of the minute is admitted`);
		}
		const over = await turn(devon);
		assert.equal(over.status, 429, "the turn past the minute's allowance is refused");
		assert.equal((await over.json() as { error: string }).error, "MODEL_BUDGET");

		assert.equal((await turn(rhea)).status, 503, "another operator is still admitted");
		assert.equal((await turn(platformToken)).status, 503, "the platform's turns are not budgeted by the operator's limit");

		const first = await sessionFor("guest-00000000000a-ops");
		const second = await sessionFor("guest-00000000000b-ops");
		for (let admitted = 1; admitted <= OPERATOR_TURNS_PER_MINUTE; admitted += 1) {
			assert.equal((await turn(first)).status, 503, `visitor turn ${admitted} of the minute is admitted`);
		}
		assert.equal((await turn(second)).status, 429, "a second visitor from the same address shares the first one's allowance");
	} finally {
		await stopServer(child);
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * A delegated widget-agent turn as Studio's real harness builds it. The section sizes are the ones
 * measured on the real dashboard (evidence g1a3/ask-round4-fix/measurement.json, byte lengths only):
 * the built-in widget instructions clip at 4,000 characters, the eight tool schemas carry 27,378
 * bytes -- add_widget_filter's shape alone is 22,528, built from the data engine's filter operators
 * -- and the child thread's five messages add 1,420. The whole body measured 32,905 bytes, past the
 * 32,768-byte global cap every other route keeps.
 */
const filterOperators = ["=", "!=", ">", ">=", "<", "<=", "contains", "startsWith", "endsWith", "between", "in", "notIn", "isEmpty", "isNotEmpty"];
const dataTypes = ["string", "number", "boolean", "date", "money", "percent", "integer", "decimal", "currency", "text", "id", "enum", "category", "quantity", "rate"];
// The data engine advertises its filter operators per data type, and that enumeration is what makes
// the real schema large. Each type lists every operator with a one-sentence description.
const operatorsByType: Record<string, Record<string, { description: string }>> = {};
for (const type of dataTypes) {
	operatorsByType[type] = {};
	for (const op of filterOperators) {
		operatorsByType[type][op] = { description: `Apply ${op} to a ${type} field: the engine validates the comparison against the field's own type.` };
	}
}
const filterParameters = {
	type: "object",
	properties: {
		widgetId: { type: "string", description: "The widget the filter applies to." },
		filter: {
			type: "object",
			properties: {
				op: { type: "string", enum: ["append"], description: "Append one filter to the widget's filter list." },
				value: {
					type: "object",
					properties: {
						operator: { type: "string", description: "The comparison operator, one of the operators the field's data type supports.", operatorsByType },
						field: { type: "string", description: "The field id to filter on, as view_schema names it." },
						value: { description: "The comparison value, typed to the field." },
					},
					required: ["operator", "field"],
				},
			},
			required: ["op", "value"],
		},
	},
	required: ["widgetId", "filter"],
};

function widgetAgentTurn(): { messages: unknown[]; instructions: string; tools: { name: string; description: string; parameters: unknown }[] } {
	const instructions = [
		"## New widgets on this dashboard",
		"The widget you were given may not be on the grid yet. If view_widget shows it does not exist, add it yourself:",
		"1. Call add_widget with widgetId set to the task's widgetId, type set to the task's widgetType, and a small free spot on the grid (xTrack, yTrack, xSpan, ySpan).",
		"2. Call configure_widget as usual.",
		"3. Call complete_task saying what you added and configured.",
		"If the widget already exists, configure it instead of adding a copy.",
		"",
		"You configure a single acquit-held widget. Your job is to produce a valid configuration via configure_widget.",
		"Every tool you have acts on that one page, so nothing you call takes a page.",
		"",
		"## Data Overview",
		"The ledger carries one table of platform money lines with job ids, escrow states and capture ids.",
		"",
		"## Widget Guidance",
		"Map one numeric value; a tile 3 or 4 columns wide and 2 rows tall fits.",
	].join("\n").padEnd(4000, " The instruction continues to the clip the adapter applies.").slice(0, 4000);
	const sized = (name: string, description: string, parameters: unknown) => ({ name, description, parameters });
	const small = { type: "object", properties: {} };
	const tools = [
		sized("view_plan", "Read the plan this conversation keeps, with one entry per task the reader gave.", small),
		sized("view_widget", "Read one widget's full configuration: its type, data mapping, format, filters, size and any health issues.",
			{ type: "object", properties: { widgetId: { type: "string", description: "The widget id, as add_widget or the task names it." } }, required: ["widgetId"] }),
		sized("view_schema", "Read the dashboard data schema: every table, its fields, their types and the aggregations each supports.", small),
		sized("add_widget_filter", "Add one filter to one widget.", filterParameters),
		sized("remove_widget_filter", "Remove one filter from one widget.",
			{ type: "object", properties: { widgetId: { type: "string", description: "The widget whose filter is removed." },
				index: { type: "number", description: "The position of the filter to remove, as view_widget lists them." } }, required: ["widgetId", "index"] }),
		sized("configure_widget", "Patch one widget's configuration.",
			{ type: "object", properties: { widgetId: { type: "string", description: "The widget to configure." },
				dataMapping: { type: "object", description: "The field mapping, from the widget's own inputs to the schema's field ids." },
				format: { type: "object", description: "The display format: number precision, currency and suffix." } }, required: ["widgetId"] }),
		sized("add_widget", "Add a widget to the grid.",
			{ type: "object", properties: { widgetId: { type: "string", description: "The id the new widget takes on the grid." },
				type: { type: "string", description: "The widget type, from the dashboard's catalogue." },
				xTrack: { type: "number", description: "The grid column the widget starts at." },
				yTrack: { type: "number", description: "The grid row the widget starts at." },
				xSpan: { type: "number", description: "How many columns the widget spans." },
				ySpan: { type: "number", description: "How many rows the widget spans." } },
				required: ["widgetId", "type", "xTrack", "yTrack", "xSpan", "ySpan"] }),
		sized("complete_task", "Finish the task.",
			{ type: "object", properties: { summary: { type: "string", description: "One or two sentences on what was added and configured." },
				artifacts: { type: "object", description: "The ids of the widgets the task produced." } }, required: ["summary", "artifacts"] }),
	];
	const messages = [
		{ id: "t1", role: "user", content: "Make the widget show held escrow. The widget type is acquit-held and the widget id is held-escrow-main." },
		{ id: "t2", role: "tool", toolCallId: "preflight-1", content: JSON.stringify({ widgetId: "held-escrow-main", widgetType: "unknown", xSpan: 0, ySpan: 0, config: {}, filters: [], issues: [] }) },
		{ id: "t3", role: "tool", toolCallId: "preflight-2", content: "The plan has no entries yet." },
		{ id: "t4", role: "assistant", toolCalls: [{ id: "c1", function: { name: "view_widget", arguments: "{\"widgetId\":\"held-escrow-main\"}" } }] },
		{ id: "t5", role: "tool", toolCallId: "c1", content: JSON.stringify({ widgetId: "held-escrow-main", widgetType: "unknown", xSpan: 0, ySpan: 0, config: {}, filters: [], issues: [] }) },
	];
	return { messages, instructions, tools };
}

test("a delegated widget-agent turn above the global body cap reaches the model port, and one past the route's own cap is still refused", {
	skip: process.platform === "win32" && "the fake droid is a /bin/sh script on a POSIX PATH",
}, async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-ask-route-"));
	const port = 4878;
	const bin = join(dir, "bin");
	const record = join(dir, "droid-record");
	await mkdir(bin, { recursive: true });
	await mkdir(record, { recursive: true });
	let child: ReturnType<typeof spawn> | null = null;
	try {
		// A fake droid on the server's PATH is the injected droid run port: it records the prompt's
		// byte length (never its content) and answers one valid -o json result line.
		await writeFile(join(bin, "droid"), `#!/bin/sh
prev=""
for arg in "$@"; do
  if [ "$prev" = "-f" ]; then wc -c < "$arg" > "${record}/prompt-bytes"; fi
  prev="$arg"
done
echo '{"type":"result","is_error":false,"result":"{\\"message\\":\\"Widget added.\\",\\"calls\\":[]}","session_id":"fake-session","usage":{"factory_credits":1}}'
`, { mode: 0o755 });
		child = await bootServer(port, join(dir, "test.db"), join(dir, "homeless"), {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			FACTORY_API_KEY: "test-factory-key-not-real",
		});
		const minted = await post(port, "/api/platform/session", { key: "test-platform-key-0123456789abcdef" });
		assert.equal(minted.status, 201);
		const { token } = await minted.json() as { token: string };

		const body = widgetAgentTurn();
		const bodyBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
		assert.ok(bodyBytes > 32_768, `the realistic body is above the global cap, as the measured real one was (built ${bodyBytes})`);
		assert.ok(JSON.stringify((body.tools[3] as { parameters: unknown }).parameters).length < 32_000, "the filter schema stays inside the route's per-tool bound");
		assert.ok(JSON.stringify((body.tools[3] as { parameters: unknown }).parameters).length > 22_000, "the filter schema carries the real shape's size");

		const anonymous = await post(port, "/api/ask-ledger/turn", body);
		assert.equal(anonymous.status, 401, "an unauthenticated turn is refused before the body is even read");

		const turn = await post(port, "/api/ask-ledger/turn", body, token);
		const answered = await turn.json() as { ok: boolean; message: string | null };
		assert.equal(turn.status, 200, `a realistic widget-agent turn above the global cap is accepted (got ${turn.status}: ${JSON.stringify(answered)})`);
		assert.equal(answered.ok, true);
		assert.equal(answered.message, "Widget added.", "the envelope came back from the model port");
		const promptBytes = Number((await readFile(join(record, "prompt-bytes"), "utf8")).trim());
		assert.ok(promptBytes > 32_768, `the whole oversized conversation reached the droid run port (${promptBytes} bytes)`);

		// The route keeps its own, larger cap: a body far past it is refused, with a distinct answer
		// from the global cap's, so the caller knows which limit bit.
		const oversized = { messages: [{ id: "m1", role: "tool", toolCallId: "x", content: "r".repeat(300_000) }] };
		const refused = await post(port, "/api/ask-ledger/turn", oversized, token);
		assert.equal(refused.status, 413, "a body past the route's own cap is refused with 413");
		assert.equal(((await refused.json()) as { error: string }).error, "ASK_BODY_TOO_LARGE");

		// The global cap keeps holding on every other route: a 40 KB body there is still the global
		// cap's 400 BAD_REQUEST, never the ask route's 413.
		const elsewhere = await post(port, "/api/session", { handle: "x".repeat(40_000) });
		assert.equal(elsewhere.status, 400, "the global 32 KB cap is unchanged on other routes");
		assert.equal(((await elsewhere.json()) as { error: string }).error, "BAD_REQUEST");
	} finally {
		await stopServer(child);
		await rm(dir, { recursive: true, force: true });
	}
});
