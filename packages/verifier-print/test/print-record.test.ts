import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import type { Instant } from "../../core/src/ids.ts";
import { FRAUDS } from "../src/catalog.ts";
import { recomputeHiddenDigest } from "../src/receipt.ts";
import { runPrintDemo } from "../src/run.ts";
import type { PrintDemoRun } from "../src/run.ts";
import type { FarmMode } from "../src/sim/farm.ts";

const SEED = new Uint8Array(32).fill(7);
const AT = "2026-10-23T09:00:00Z" as Instant;
/** The most a serialized run may weigh. The honest run is about 124 KB; the limit leaves room for a larger plate. */
const RECORD_LIMIT_BYTES = 200_000;

function runOf(mode: FarmMode): Promise<PrintDemoRun> {
	return runPrintDemo({ mode, seed: SEED, at: AT });
}

// The honest run's sampled layers, and the digest those layers and the job's salt commit to. The salt and digest
// were computed outside the verifier from the documented rules (sha256 of "print-salt" and the job seed, then SHA-256
// of the canonical JSON), so these literals check the code against that rule.
const SAMPLED = [2, 18, 27, 30, 31, 32, 37, 40];
const SALT = "a00cc48230e123bde90b3d7a002ad38da7b6f4c74987873ad0e3ff90cc15eaf0";
const HIDDEN_DIGEST = "537ea60d733f73891bc22e0409d7cb6bdf35cae7cbda046ce6221c42f1334bea";
const CHANGED_DIGEST = "8a0674873f0c8719f4cd0e9b6aabdf88876d385bcb653767c0bd79b81c57d296";

const MODES: readonly FarmMode[] = ["honest", ...FRAUDS.map(item => `fraud:${item.id}` as FarmMode)];

for (const mode of MODES) {
	test(`the ${mode} run record stays under ${RECORD_LIMIT_BYTES} bytes once serialized`, async () => {
		const run = await runOf(mode);
		const bytes = Buffer.byteLength(JSON.stringify(run));
		assert.ok(bytes < RECORD_LIMIT_BYTES, `${mode} record is ${bytes} bytes`);
		assert.ok(run.print?.timeline.layers.length, "a printing farm has a timeline");
	});
}

test("the honest timeline has one row per sampled layer, every row passes, and each picture is 185 by 90 pixels", async () => {
	const run = await runOf("honest");
	const timeline = run.print?.timeline;
	assert.ok(timeline);
	assert.deepEqual(timeline.layers.map(row => row.layer), SAMPLED);
	assert.ok(timeline.layers.every(row => row.pass && row.readable), JSON.stringify(timeline.layers.map(row => [row.layer, row.iou])));
	assert.ok(timeline.layers.every(row => row.iou >= timeline.iouMin));
	assert.ok(timeline.layers.every(row => row.distance === null), "the honest print archives no photo");
	for (const row of timeline.layers) {
		assert.deepEqual([row.reference.cols, row.reference.rows, row.photo.cols, row.photo.rows], [185, 90, 185, 90]);
	}
	assert.equal(timeline.imageScale, 4);
});

test("the reused-photo timeline fails every row on the reuse flag, with each distance inside the reuse limit", async () => {
	const run = await runOf("fraud:reused-photo");
	const timeline = run.print?.timeline;
	assert.ok(timeline);
	assert.ok(timeline.layers.every(row => !row.pass), "a reused photo fails its own row");
	for (const row of timeline.layers) {
		assert.ok(row.distance !== null && row.distance >= 0 && row.distance <= timeline.reuseMaxDistance, `layer ${row.layer} distance ${row.distance}`);
	}
	assert.deepEqual(run.print?.reasons.map(reason => reason.kind), SAMPLED.map(() => "PHOTO_REUSED"));
});

test("the honest receipt reveals the sampled layers and salt, and the reveal rebuilds the digest committed at open", async () => {
	const run = await runOf("honest");
	const receipt = run.print?.receipt;
	assert.ok(receipt);
	assert.deepEqual(receipt.reveal.hidden.sampleLayers, SAMPLED);
	assert.equal(receipt.reveal.salt, SALT);
	assert.equal(receipt.hiddenDigest, HIDDEN_DIGEST);
	assert.equal(receipt.digestMatches, true);
	assert.equal(recomputeHiddenDigest(receipt.reveal), HIDDEN_DIGEST);
	assert.equal(receipt.verdict, "VERIFIED");
	assert.deepEqual(receipt.reasonKinds, []);
	assert.equal(receipt.telemetry.frames, run.print?.evidence.frames);
	assert.match(receipt.gcodeSha256, /^[0-9a-f]{64}$/);
	assert.match(receipt.telemetry.chainHead ?? "", /^[0-9a-f]{64}$/);
	assert.match(receipt.telemetry.printerKeySha256, /^[0-9a-f]{64}$/);
	assert.equal(receipt.certificateDigest, run.certificate?.digest);
});

test("a reveal with one sampled layer altered does not rebuild the committed digest", async () => {
	const run = await runOf("honest");
	const receipt = run.print?.receipt;
	assert.ok(receipt);
	const altered = { hidden: { sampleLayers: SAMPLED.map(layer => (layer === 40 ? 41 : layer)) }, salt: receipt.reveal.salt };
	assert.equal(recomputeHiddenDigest(altered), CHANGED_DIGEST);
	assert.notEqual(recomputeHiddenDigest(altered), receipt.hiddenDigest);
});
