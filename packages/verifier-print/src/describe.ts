// Plain wording for each print reason, for the demo page and the run record. The reason's kind stays the
// machine name the score card and the tests match on. These sentences only read the reason's own numbers.

import type { PrintRejectReason } from "./types.ts";

export function describePrintReason(reason: PrintRejectReason): string {
	switch (reason.kind) {
		case "MESH_NOT_MANIFOLD":
			return "The part mesh is not closed, so it cannot be printed as one solid.";
		case "GCODE_UNPARSEABLE":
			return `The G-code does not parse at line ${reason.line}.`;
		case "INFILL_BELOW_CONTRACT":
			return `Infill ${reason.pct}% on layer ${reason.layer}, below the contract's ${reason.contractPct}%.`;
		case "FOOTPRINT_MISMATCH":
			return `Layer ${reason.layer} does not match the part's footprint (overlap ${reason.iou.toFixed(2)}).`;
		case "OUTSIDE_MATERIAL":
			return `${reason.pct}% of layer ${reason.layer} lies outside the part.`;
		case "BED_OUT_OF_BOUNDS":
			return `The ${reason.axis} path reaches ${reason.gcodeMm} mm, past the bed's ${reason.boundMm} mm.`;
		case "SCALE_OUT_OF_TOLERANCE":
			return `The ${reason.axis} size is ${reason.gcodeMm} mm in the G-code and ${reason.meshMm} mm in the part.`;
		case "UNIT_COUNT_MISMATCH":
			return `Layer shows ${reason.found} parts; the contract has ${reason.expected}.`;
		case "COUPON_MISSING":
			return "The coupon is missing from the plate.";
		case "COUPON_IOU_LOW":
			return `The coupon does not match the contract's coupon (overlap ${reason.iou.toFixed(2)}).`;
		case "COUPON_MARKER_MISMATCH":
			return `The coupon marker reads ${reason.found}; the contract names ${reason.expected}.`;
		case "PHOTO_UNREADABLE":
			return `The photo of layer ${reason.layer} cannot be read against the contract.`;
		case "PHOTO_MISSING":
			return `No photo of layer ${reason.layer} was sent, and the contract samples that layer.`;
		case "GEOMETRY_MISMATCH":
			return `The photo of layer ${reason.layer} does not match the part (overlap ${reason.iou.toFixed(2)}).`;
		case "PHOTO_REUSED":
			return `The photo of layer ${reason.layer} matches a photo from an earlier job.`;
		case "TELEMETRY_MISSING":
			return "No printer telemetry was sent.";
		case "TELEMETRY_SIGNATURE_INVALID":
			return `Telemetry frame ${reason.seq} is not signed by this printer.`;
		case "TELEMETRY_CHAIN_BROKEN":
			return `Telemetry frame ${reason.seq} breaks the hash chain.`;
		case "FILE_HASH_MISMATCH":
			return `Telemetry frame ${reason.seq} is for a different G-code file.`;
		case "LAYER_SEQUENCE_MISMATCH":
			return `Telemetry frame ${reason.seq} does not follow the G-code's layers or time.`;
		case "FILAMENT_MISMATCH":
			return `The printer reports ${reason.telemetryMm} mm of filament; the G-code asks for ${reason.gcodeMm} mm.`;
		case "DURATION_IMPLAUSIBLE":
			return `The printer reports ${reason.telemetryS} s; the estimate is ${reason.estimateS} s.`;
	}
}
