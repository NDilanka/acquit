// The receipt: what the demo job froze, revealed once the verdict is out. The hidden terms and their salt rebuild the
// digest committed at open, so anyone can check the reveal against the commitment. The digest is a plain SHA-256 over
// canonical JSON, which the page recomputes in the browser with WebCrypto.

import type { KeyObject } from "node:crypto";
import { createHash } from "node:crypto";
import type { Digest, JobId } from "../../core/src/ids.ts";
import { hiddenDigest, reveal as revealTerms } from "./contract.ts";
import type { Reveal } from "./contract.ts";
import { digestOf } from "./digest.ts";
import type { QualificationCertificate } from "./qualify.ts";
import { frameDigest } from "./telemetry.ts";
import type { TelemetryFrame } from "./telemetry.ts";
import type { PrintVerdict } from "./verify.ts";
import type { FrozenPrintContract } from "./types.ts";

export type Receipt = {
	readonly jobId: JobId;
	/** A digest over the public terms: the spec, the mesh, the layer grid, and the marker. */
	readonly contractDigest: Digest;
	/** The commitment made at open. The reveal below must rebuild it. */
	readonly hiddenDigest: Digest;
	readonly reveal: Reveal;
	/** True when the reveal rebuilds hiddenDigest, as the server computes it. The page computes it again in the browser. */
	readonly digestMatches: boolean;
	readonly gcodeSha256: string;
	readonly telemetry: {
		readonly frames: number;
		/** The digest of the last frame, sig included. Null when there are no frames. */
		readonly chainHead: string | null;
		/** SHA-256 of the printer's public key, in DER. */
		readonly printerKeySha256: string;
	};
	readonly certificateDigest: Digest;
	readonly verdict: PrintVerdict["result"];
	readonly reasonKinds: readonly string[];
	readonly openedAt: string;
};

/** The digest the reveal names, rebuilt from the reveal alone. Used by receiptOf and tested against a changed reveal. */
export function recomputeHiddenDigest(reveal: Reveal): Digest {
	return hiddenDigest(reveal.hidden, reveal.salt);
}

export function receiptOf(input: {
	readonly contract: FrozenPrintContract;
	readonly seed: Uint8Array;
	readonly gcode: string;
	readonly frames: readonly TelemetryFrame[];
	readonly publicKey: KeyObject;
	readonly certificate: QualificationCertificate;
	readonly verdict: PrintVerdict;
}): Receipt {
	const { contract } = input;
	const revealed = revealTerms(contract, input.seed);
	const last = input.frames[input.frames.length - 1];
	return {
		jobId: contract.jobId,
		contractDigest: digestOf({ jobId: contract.jobId, publicTerms: contract.publicTerms }),
		hiddenDigest: contract.hiddenDigest,
		reveal: revealed,
		digestMatches: recomputeHiddenDigest(revealed) === contract.hiddenDigest,
		gcodeSha256: createHash("sha256").update(new TextEncoder().encode(input.gcode)).digest("hex"),
		telemetry: {
			frames: input.frames.length,
			chainHead: last === undefined ? null : frameDigest(last),
			printerKeySha256: createHash("sha256").update(input.publicKey.export({ type: "spki", format: "der" })).digest("hex"),
		},
		certificateDigest: input.certificate.digest,
		verdict: input.verdict.result,
		reasonKinds: input.verdict.reasons.map(reason => reason.kind),
		openedAt: contract.frozenAt,
	};
}
