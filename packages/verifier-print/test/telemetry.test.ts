import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../src/digest.ts";
import { parseGcode } from "../src/gcode.ts";
import { estimateTime } from "../src/estimate.ts";
import { checkTelemetry, newPrinterKeys, signBody } from "../src/telemetry.ts";
import type { FrameBody, TelemetryFrame } from "../src/telemetry.ts";
import { runTwin } from "../src/sim/twin.ts";
import type { ParsedGcode } from "../src/types.ts";
import { squareGcode } from "./square-gcode.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function parsed(text: string): ParsedGcode {
	const result = parseGcode(text);
	if (!result.ok) throw new Error("fixture does not parse");
	return result.value;
}

const HONEST = squareGcode(20, 5, true);
const honest = parsed(HONEST);
const HONEST_SHA = sha256Hex(encode(HONEST));
const keys = newPrinterKeys();
const ESTIMATE_S = estimateTime(honest).totalSeconds;

function run(overrides: Partial<Parameters<typeof runTwin>[0]> = {}): TelemetryFrame[] {
	return runTwin({ printerId: "printer-a", keys, fileHash: HONEST_SHA, gcode: honest, ...overrides }).frames as TelemetryFrame[];
}

function check(frames: readonly TelemetryFrame[], publicKey = keys.publicKey, gcode = honest, sha = HONEST_SHA) {
	return checkTelemetry({ frames, publicKey, gcodeSha256: sha, gcode, estimateSeconds: ESTIMATE_S });
}

test("honest telemetry from the twin passes every check, and its last frame reports the G-code's extrusion", () => {
	const frames = run();
	assert.deepEqual(check(frames), []);
	assert.ok(frames.length >= honest.layers.length + 2, `frames ${frames.length}`);
	assert.ok(Math.abs(frames[frames.length - 1].e - honest.extrudedMm) < 1e-9);
	assert.equal(frames[0].prevHash, null);
});

test("a print of other G-code is rejected with FILE_HASH_MISMATCH on the first frame (swap-gcode)", () => {
	// A 2 mm layer shift keeps the extrusion and the duration, so only the file hash can catch it.
	const other = squareGcode(20, 5, true, { layer: 3, mm: 2 });
	const frames = run({ fileHash: sha256Hex(encode(other)), gcode: parsed(other) });
	assert.deepEqual(check(frames, keys.publicKey, honest, HONEST_SHA), [{ kind: "FILE_HASH_MISMATCH", seq: 0 }]);
});

test("a host that reports 20% less filament fails FILAMENT_MISMATCH against the G-code's extrusion", () => {
	const frames = run({ filamentReportScale: 0.8 });
	const reasons = check(frames);
	assert.equal(reasons.length, 1);
	const [reason] = reasons;
	assert.equal(reason.kind, "FILAMENT_MISMATCH");
	if (reason.kind !== "FILAMENT_MISMATCH") return;
	assert.ok(Math.abs(reason.telemetryMm - 0.8 * reason.gcodeMm) < 0.02, `telemetry ${reason.telemetryMm} vs ${reason.gcodeMm}`);
});

test("a print that finishes in 30% of its estimate fails DURATION_IMPLAUSIBLE", () => {
	const reasons = check(run({ timeScale: 0.3 }));
	assert.equal(reasons.length, 1);
	assert.equal(reasons[0].kind, "DURATION_IMPLAUSIBLE");
});

test("a dropped frame breaks the chain at the frame after the gap and nothing else", () => {
	const frames = run();
	const holed = frames.filter((_, i) => i !== 2);
	assert.deepEqual(check(holed), [{ kind: "TELEMETRY_CHAIN_BROKEN", seq: 3 }]);
});

test("a frame re-signed by another key fails its signature, and the chain breaks at the next frame", () => {
	const frames = run();
	const impostor = newPrinterKeys();
	const { sig: _sig, ...body } = frames[1];
	const forged = signBody(body as FrameBody, impostor.privateKey);
	const tampered = [frames[0], forged, ...frames.slice(2)];
	assert.deepEqual(check(tampered), [
		{ kind: "TELEMETRY_SIGNATURE_INVALID", seq: 1 },
		{ kind: "TELEMETRY_CHAIN_BROKEN", seq: 2 },
	]);
});

test("frames signed by a key that is not the registered printer key all fail the signature", () => {
	const frames = run();
	const registered = newPrinterKeys();
	const reasons = check(frames, registered.publicKey);
	assert.equal(reasons[0].kind, "TELEMETRY_SIGNATURE_INVALID");
	assert.equal(reasons[0].seq, 0);
});

test("a frame reporting a z the G-code does not have fails LAYER_SEQUENCE_MISMATCH, and the chain breaks after it", () => {
	const frames = run();
	const { sig: _sig, ...body } = frames[1];
	const shifted = signBody({ ...body, z: body.z + 0.1 }, keys.privateKey);
	const tampered = [frames[0], shifted, ...frames.slice(2)];
	assert.deepEqual(check(tampered), [
		{ kind: "TELEMETRY_CHAIN_BROKEN", seq: 2 },
		{ kind: "LAYER_SEQUENCE_MISMATCH", seq: 1 },
	]);
});

test("no frames at all is TELEMETRY_MISSING", () => {
	assert.deepEqual(check([]), [{ kind: "TELEMETRY_MISSING" }]);
});
