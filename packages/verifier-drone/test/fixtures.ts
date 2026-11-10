// Shared fixtures for the drone regression tests. The historical names s, h, base, fresh, run and wp keep the
// original bypass probes reproducible after the shipped samples are regenerated. This file is not a test; the
// test runner only picks up *.test.ts.

import { HIDDEN_EXAMPLE, ORIGIN, SPEC, buildSamples } from "../samples/build.ts";
import { toLatLon } from "../src/geo.ts";
import { parseSpec } from "../src/spec.ts";
import { verify } from "../src/verify.ts";
import type { Spec, Verdict } from "../src/types.ts";

export type Item = Record<string, unknown>;
export type Doc = { fileType: string; mission: { cruiseSpeed: number; plannedHomePosition?: unknown; items: unknown[] } };

function parsedSpec(): Spec {
	const parsed = parseSpec(SPEC);
	if (typeof parsed === "string") throw new Error(parsed);
	return parsed;
}

/** The parsed shipped job spec. */
export const s: Spec = parsedSpec();
/** The shipped hidden example. */
export const h = HIDDEN_EXAMPLE;
/** The shipped honest plan as an object. */
export const base = JSON.parse(buildSamples()["honest.plan"]!) as Doc;
/** A fresh deep copy of the honest plan, safe to mutate. */
export const fresh = (): Doc => structuredClone(base);

/** Verifies a plan (object or text) against the spec and hidden sample; the spec and hidden arguments may be unknown. */
export function run(plan: unknown, spec: unknown = SPEC, hidden: unknown = h): Verdict {
	return verify(spec, typeof plan === "string" ? plan : JSON.stringify(plan), hidden);
}

/** The rule identifiers of the findings that failed. */
export function failed(verdict: Verdict): string[] {
	return verdict.findings.filter(item => !item.ok).map(item => item.rule);
}

/** A survey waypoint (command 16, frame 3: altitude above home) at local metres x, y. */
export function wp(x: number, y: number, alt = 40): Item {
	const [lat, lon] = toLatLon(ORIGIN, x, y);
	return { type: "SimpleItem", command: 16, frame: 3, autoContinue: true, params: [0, 0, 0, 0, lat, lon, alt] };
}

/** A camera trigger distance setting (command 206). Zero switches triggering off. */
export function trigger(metres: number): Item {
	return { type: "SimpleItem", command: 206, frame: 2, autoContinue: true, params: [metres, 0, 0, 0, 0, 0, 0] };
}

/** A takeoff (command 22) from home at the origin, climbing to the given height above home. Ground waypoints earn no photographs. */
export function takeoff(alt = 40): Item {
	const [lat, lon] = ORIGIN;
	return { type: "SimpleItem", command: 22, frame: 3, autoContinue: true, params: [0, 0, 0, 0, lat, lon, alt] };
}

/** A land (command 21) in place. */
export function land(): Item {
	return { type: "SimpleItem", command: 21, frame: 3, autoContinue: true, params: [0, 0, 0, 0, 0, 0, 0] };
}

/** Return to launch (command 20). */
export function rtl(): Item {
	return { type: "SimpleItem", command: 20, frame: 2, autoContinue: true, params: [0, 0, 0, 0, 0, 0, 0] };
}

/** The items of one command, in mission order. */
export function commands(doc: Doc, command: number): Item[] {
	return doc.mission.items.filter((item): item is Item => typeof item === "object" && item !== null && (item as Item).command === command);
}

/** A complete QGroundControl document around the given items, with home at the origin. */
export function planDoc(items: unknown[], cruiseSpeed = 14): Doc {
	return { fileType: "Plan", mission: { cruiseSpeed, plannedHomePosition: [ORIGIN[0], ORIGIN[1], 0], items } };
}
