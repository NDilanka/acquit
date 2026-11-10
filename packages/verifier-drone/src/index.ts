// The public API of the drone survey checker.

export { verify, gsdCm, acrossM, alongM } from "./verify.ts";
export { parseSpec, parseHiddenSample, PUBLIC_RULES, HIDDEN_RULES, LIMITS } from "./spec.ts";
export { parsePlan, CMD_TAKEOFF, CMD_WAYPOINT, CMD_LAND, CMD_RETURN_TO_LAUNCH, CMD_CHANGE_SPEED, CMD_SET_CAM_TRIGGER_DIST } from "./plan.ts";
export type { MissionEvent, Plan, Waypoint } from "./plan.ts";
export { tallyDrones, formatDroneScoreCard } from "./score-card.ts";
export type { CaseResult, ScoreCard } from "./score-card.ts";
export type { Camera, Finding, HiddenSample, LatLon, Scene, ScenePath, Spec, Vec2, Vec3, Verdict, Zone } from "./types.ts";
