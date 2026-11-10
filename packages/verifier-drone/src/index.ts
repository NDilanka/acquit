// The public API of the drone survey checker.

export { verify, gsdCm, acrossM, alongM } from "./verify.ts";
export { parseSpec, PUBLIC_RULES, HIDDEN_RULES } from "./spec.ts";
export { parsePlan, CMD_WAYPOINT, CMD_SET_CAM_TRIGGER_DIST } from "./plan.ts";
export type { Plan, Waypoint } from "./plan.ts";
export { tallyDrones, formatDroneScoreCard } from "./score-card.ts";
export type { CaseResult, ScoreCard } from "./score-card.ts";
export type { Camera, Finding, HiddenSample, Scene, ScenePath, Spec, Vec2, Vec3, Verdict, Zone } from "./types.ts";
