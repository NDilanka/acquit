// Public entry point of the PCB checker. Everything here is pure: no file or network I/O.

export { verify } from "./verify.ts";
export { validateSpec, validateHidden } from "./spec.ts";
export { parseSexprs } from "./sexpr.ts";
export { readBoard } from "./board.ts";
export { runPcbScoreCard, formatPcbScoreCard } from "./score-card.ts";
export type { PcbCaseResult, PcbScoreCard } from "./score-card.ts";
export type { SpecResult, HiddenResult } from "./spec.ts";
export type { Board } from "./board.ts";
export type {
	Finding,
	HiddenSample,
	PadRef,
	PadSpec,
	PartSpec,
	Scene,
	ScenePath,
	Spec,
	Verdict,
	Vec2,
} from "./types.ts";
export {
	SAMPLE_FRAUD_RULES,
	SAMPLE_FRAUDS,
	SAMPLE_HIDDEN_JSON,
	SAMPLE_HONEST_PCB,
	SAMPLE_SPEC_JSON,
} from "./samples.ts";
