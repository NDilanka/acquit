import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkDelivery } from "../src/checker-cli.ts";
import type { CheckerReply } from "../src/checker-cli.ts";
import { MAX_TEXT_CHARS } from "../src/limits.ts";
import { RULES } from "../src/types.ts";
import type { HiddenSample, Spec } from "../src/types.ts";
import { verify } from "../src/verify.ts";

const sample = (name: string): string => readFileSync(new URL(`../samples/${name}`, import.meta.url), "utf8");
const spec = JSON.parse(sample("enclosure-panel.spec.json")) as Spec;
const honest = sample("honest.svg");
const publicHidden = JSON.parse(sample("enclosure-panel.hidden.json")) as HiddenSample;
const publicRules = RULES.filter(rule => rule !== "hidden-material");
const cliPath = fileURLToPath(new URL("../src/checker-cli.ts", import.meta.url));

function independentChecks(hidden: HiddenSample): HiddenSample[] {
	return [
		...hidden.keepMaterialMm.map(point => ({ keepMaterialMm: [point], clearanceMm: hidden.clearanceMm })),
		...(hidden.voidMm ?? []).map(point => ({ keepMaterialMm: [], voidMm: [point] })),
	];
}

// Coordinates stay outside the repository. CI without the private fixture skips only sealed integration tests.
// Set ACQUIT_LASER_SEALED_FILE to a private fixture path on other machines; it contains no coordinates itself.
function loadSealed(): HiddenSample | undefined {
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	const path = process.env.ACQUIT_LASER_SEALED_FILE ?? resolve(root, "../../acquit/scratch/orchestrate/sealed/laser-cut.sealed.json");
	try {
		return JSON.parse(readFileSync(path, "utf8")) as HiddenSample;
	} catch (error) {
		if (!process.env.ACQUIT_LASER_SEALED_FILE && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error("the private sealed check file could not be loaded");
	}
}

const sealed = loadSealed();
const sealedChecks = sealed === undefined ? [] : independentChecks(sealed);
const sealedOptions = { skip: sealed === undefined ? "private sealed check file is not installed" : false };

function checked(reply: CheckerReply): Extract<CheckerReply, { kind: "checked" }> {
	assert.equal(reply.kind, "checked");
	if (reply.kind !== "checked") throw new Error("expected a checked delivery");
	return reply;
}

test("honest delivery exposes exactly every public rule, all passing", () => {
	const reply = checked(checkDelivery(spec, honest, independentChecks(publicHidden)));
	assert.deepEqual(Object.keys(reply.rules).sort(), [...publicRules].sort());
	assert.ok(Object.values(reply.rules).every(Boolean));
	assert.deepEqual(reply.checks, publicHidden.keepMaterialMm.map(() => true));
});

test("public fraud mapping agrees with every finding, without changing other public rules", () => {
	const artefact = sample("fraud-wrong-colour.svg");
	const reply = checked(checkDelivery(spec, artefact, []));
	const verdict = verify(spec, artefact);
	const expected = Object.fromEntries(publicRules.map(rule => {
		const findings = verdict.findings.filter(finding => finding.rule === rule);
		return [rule, findings.length > 0 && findings.every(finding => finding.ok)];
	}));
	assert.deepEqual(reply.rules, expected);
	assert.equal(reply.rules.colours, false);
	const baseline = checked(checkDelivery(spec, honest, [])).rules;
	for (const rule of publicRules) {
		if (rule !== "colours") assert.equal(reply.rules[rule], baseline[rule], rule);
	}
});

test("no checks means no hidden results", () => {
	assert.deepEqual(checked(checkDelivery(spec, honest, [])).checks, []);
});

test("each hidden check is evaluated independently and keeps its input order", () => {
	const material = publicHidden.keepMaterialMm[0];
	const checks: HiddenSample[] = [
		{ keepMaterialMm: [material] },
		{ keepMaterialMm: [], voidMm: [material] },
		{ keepMaterialMm: [material] },
	];
	const reply = checked(checkDelivery(spec, honest, checks));
	assert.deepEqual(reply.checks, [true, false, true]);
	assert.ok(Object.values(reply.rules).every(Boolean));
});

test("unparseable drawings are refused with the plain parse message", () => {
	const reply = checkDelivery(spec, "not svg", []);
	assert.equal(reply.kind, "refused");
	if (reply.kind !== "refused") throw new Error("expected refusal");
	assert.equal(reply.detail, verify(spec, "not svg").findings[0]?.message);
	assert.ok(reply.detail.length > 0 && reply.detail.length <= 300);
	assert.doesNotMatch(reply.detail, /[\u0000-\u001f\u007f]/);
});

test("over-limit drawings are refused rather than scored", () => {
	assert.equal(checkDelivery(spec, " ".repeat(MAX_TEXT_CHARS + 1), []).kind, "refused");
});

test("a refusal detail is bounded to 300 plain characters", () => {
	const artefact = honest.replace('stroke="#ff0000"', `stroke="${"x".repeat(500)}"`);
	const reply = checkDelivery(spec, artefact, []);
	assert.equal(reply.kind, "refused");
	if (reply.kind !== "refused") throw new Error("expected refusal");
	assert.equal(reply.detail.length, 300);
	assert.equal(reply.detail, verify(spec, artefact).findings[0]?.message.slice(0, 300));
});

test("spec validation remains owned by verify", () => {
	const invalid = { ...spec, thicknessMm: -1 };
	const reply = checkDelivery(invalid, honest, []);
	assert.deepEqual(reply, { kind: "refused", detail: verify(invalid, honest).findings[0]?.message });
});

test("a hidden verification refusal is not mistaken for a passing check", () => {
	assert.equal(checkDelivery(spec, honest, [{ keepMaterialMm: [], clearanceMm: -1 }]).kind, "refused");
});

test("sealed points differ from the public ones and have the requested counts and clearance", sealedOptions, () => {
	assert.ok(sealed !== undefined);
	assert.ok(sealed.keepMaterialMm.length >= 4 && sealed.keepMaterialMm.length <= 6);
	assert.ok((sealed.voidMm?.length ?? 0) >= 1 && (sealed.voidMm?.length ?? 0) <= 2);
	assert.ok((sealed.clearanceMm ?? 0) >= 1 && (sealed.clearanceMm ?? 0) <= 2);
	const publicPoints = new Set(publicHidden.keepMaterialMm.map(point => JSON.stringify(point)));
	for (const point of [...sealed.keepMaterialMm, ...(sealed.voidMm ?? [])]) {
		assert.equal(publicPoints.has(JSON.stringify(point)), false, "sealed points must not reuse public samples");
	}
	assert.ok(sealedChecks.every(check => check.keepMaterialMm.length + (check.voidMm?.length ?? 0) === 1));
});

test("honest drawing passes every public rule and every real sealed check", sealedOptions, () => {
	const reply = checked(checkDelivery(spec, honest, sealedChecks));
	assert.ok(Object.values(reply.rules).every(Boolean));
	assert.deepEqual(reply.checks, sealedChecks.map(() => true));
});

for (const name of ["fraud-hidden-notch.svg", "fraud-thin-web.svg", "fraud-hole-moved.svg"]) {
	test(`real sealed checks catch ${name} and map hidden findings individually`, sealedOptions, () => {
		const artefact = sample(name);
		const reply = checked(checkDelivery(spec, artefact, sealedChecks));
		const expected = sealedChecks.map(check => {
			const findings = verify(spec, artefact, check).findings.filter(finding => finding.rule === "hidden-material");
			return findings.length > 0 && findings.every(finding => finding.ok);
		});
		assert.deepEqual(reply.checks, expected);
		assert.ok(reply.checks.some(ok => !ok));
		if (name === "fraud-hidden-notch.svg") assert.ok(Object.values(reply.rules).every(Boolean));
	});
}

const fraudNames = readdirSync(new URL("../samples/", import.meta.url)).filter(name => /^fraud-.*\.svg$/.test(name)).sort();
// Pinned from the public rules alone. Each named fraud is refused by exactly these public rules.
const publicCatches: Record<string, readonly string[]> = {
	"fraud-chamfered-corner.svg": ["outer-size"],
	"fraud-duplicate-cut.svg": ["no-duplicates"],
	"fraud-hole-moved.svg": ["holes"],
	"fraud-no-kerf.svg": ["outer-size"],
	"fraud-open-path.svg": ["closed-paths"],
	"fraud-order.svg": ["cut-order"],
	"fraud-oversize-bed.svg": ["fits-bed"],
	"fraud-pixel-units.svg": ["units-mm"],
	"fraud-thin-web.svg": ["min-web"],
	"fraud-wrong-colour.svg": ["colours"],
	"fraud-zero-label.svg": ["engrave-inside"],
};

test("every fraud sample is classified, and the public rules alone refuse all but the hidden notch", () => {
	assert.deepEqual(fraudNames.filter(name => !(name in publicCatches)), ["fraud-hidden-notch.svg"]);
	for (const [name, rules] of Object.entries(publicCatches)) {
		const reply = checked(checkDelivery(spec, sample(name), []));
		assert.deepEqual(Object.keys(reply.rules).filter(rule => !reply.rules[rule]).sort(), [...rules].sort(), name);
	}
});

test("the honest drawing passes every public rule with no sealed checks", () => {
	assert.ok(Object.values(checked(checkDelivery(spec, honest, [])).rules).every(Boolean));
});

test("every fraud sample is rejected by a public rule, a sealed check, or both", sealedOptions, () => {
	assert.ok(fraudNames.length >= 6);
	for (const name of fraudNames) {
		const reply = checkDelivery(spec, sample(name), sealedChecks);
		// A refusal is a rejection too: the judge turns it into a plain REJECTED verdict.
		if (reply.kind === "refused") continue;
		assert.ok(Object.values(reply.rules).some(ok => !ok) || reply.checks.some(ok => !ok), `${name} passed every check`);
	}
});

type EntryReply = CheckerReply | { readonly kind: "malformed"; readonly detail: string };

function runChild(input: string): Promise<EntryReply> {
	return new Promise((resolve, reject) => {
		// Match the verifier: no inherited secrets, runtime flags, or spec-file access.
		const child = spawn(process.execPath, [cliPath], {
			env: { PATH: process.env.PATH ?? "" },
			timeout: 20_000,
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
		child.on("error", reject);
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			// An over-limit input can close stdin before the writer has flushed.
			if (error.code !== "EPIPE") reject(error);
		});
		child.on("close", (code, signal) => {
			try {
				assert.equal(signal, null);
				assert.equal(code, 0);
				assert.equal(stderr, "");
				assert.match(stdout, /^[^\r\n]+\n$/);
				resolve(JSON.parse(stdout) as EntryReply);
			} catch (error) {
				reject(error);
			}
		});
		child.stdin.end(input);
	});
}

const validInput = { spec, artefact: honest, checks: independentChecks(publicHidden) };

test("stdin entry runs with only PATH and returns exactly one honest JSON reply", async () => {
	assert.deepEqual(await runChild(JSON.stringify(validInput)), checkDelivery(spec, honest, validInput.checks));
});

test("stdin entry checks the real sealed fixture without secret environment variables", sealedOptions, async () => {
	assert.deepEqual(
		await runChild(JSON.stringify({ spec, artefact: honest, checks: sealedChecks })),
		checkDelivery(spec, honest, sealedChecks),
	);
});

test("stdin entry returns malformed for invalid JSON without echoing input", async () => {
	const reply = await runChild('{"private-marker": invalid}');
	assert.deepEqual(reply, { kind: "malformed", detail: "stdin must contain one JSON document" });
});

test("stdin entry rejects multiple JSON documents", async () => {
	assert.equal((await runChild(`${JSON.stringify(validInput)}\n{}`)).kind, "malformed");
});

const malformedCases: readonly [string, unknown][] = [
	["a non-object input", []],
	["a missing spec", { artefact: honest, checks: [] }],
	["a non-string artefact", { ...validInput, artefact: 12 }],
	["missing checks", { spec, artefact: honest }],
	["more than 512 checks", { ...validInput, checks: Array.from({ length: 513 }, () => ({ keepMaterialMm: [] })) }],
	["a non-object check", { ...validInput, checks: [null] }],
	["missing keepMaterialMm", { ...validInput, checks: [{}] }],
	["a non-pair keep point", { ...validInput, checks: [{ keepMaterialMm: [[1]] }] }],
	["a non-numeric keep point", { ...validInput, checks: [{ keepMaterialMm: [["1", 2]] }] }],
	["an invalid void point", { ...validInput, checks: [{ keepMaterialMm: [], voidMm: [[1, null]] }] }],
	["negative clearance", { ...validInput, checks: [{ keepMaterialMm: [], clearanceMm: -1 }] }],
	["non-numeric clearance", { ...validInput, checks: [{ keepMaterialMm: [], clearanceMm: "1" }] }],
];

for (const [name, input] of malformedCases) {
	test(`stdin entry rejects ${name}`, async () => {
		assert.equal((await runChild(JSON.stringify(input))).kind, "malformed");
	});
}

test("stdin entry rejects non-finite point coordinates and clearance", async () => {
	for (const check of [
		'{"keepMaterialMm":[[1e999,2]]}',
		'{"keepMaterialMm":[],"voidMm":[[1,1e999]]}',
		'{"keepMaterialMm":[],"clearanceMm":1e999}',
	]) {
		const input = `{"spec":${JSON.stringify(spec)},"artefact":${JSON.stringify(honest)},"checks":[${check}]}`;
		assert.equal((await runChild(input)).kind, "malformed");
	}
});

test("stdin entry permits 512 checks and delegates invalid specs to verify", async () => {
	const input = { spec: null, artefact: honest, checks: Array.from({ length: 512 }, () => ({ keepMaterialMm: [] })) };
	const reply = await runChild(JSON.stringify(input));
	assert.equal(reply.kind, "refused");
});

test("stdin limit accepts exactly 4000000 bytes and refuses one byte more", async () => {
	const input = JSON.stringify(validInput);
	const atLimit = input + " ".repeat(4_000_000 - Buffer.byteLength(input));
	assert.equal((await runChild(atLimit)).kind, "checked");
	assert.deepEqual(await runChild(`${atLimit} `), { kind: "malformed", detail: "stdin must be at most 4000000 bytes" });
});

test("stdin limit counts UTF-8 bytes, not characters", async () => {
	const input = JSON.stringify({ ...validInput, padding: "é".repeat(2_000_000) });
	assert.ok(input.length < 4_000_000 && Buffer.byteLength(input) > 4_000_000);
	assert.equal((await runChild(input)).kind, "malformed");
});
