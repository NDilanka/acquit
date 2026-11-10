import type { Checked, FieldError, Spec, SpecHole, SpecSlot, Vec2 } from "./types.ts";

const SPEC_FIELDS = ["material", "thicknessMm", "bedMm", "partMm", "kerfMm", "toleranceMm", "minWebMm", "holes", "slots"];
const HOLE_FIELDS = ["id", "centreMm", "diameterMm"];
const SLOT_FIELDS = ["id", "sizeMm"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isPositive = (value: unknown): value is number => isFiniteNumber(value) && value > 0;

type Refuse = (path: string, message: string) => void;

function vec2Of(value: unknown, positive: boolean): Vec2 | null {
	if (!Array.isArray(value) || value.length !== 2) return null;
	const [x, y] = value as unknown[];
	if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
	if (positive && (x <= 0 || y <= 0)) return null;
	return [x, y];
}

function listOf(value: unknown, path: string, refuse: Refuse): readonly unknown[] {
	if (Array.isArray(value)) return value as unknown[];
	refuse(path, "must be a list");
	return [];
}

function idOf(entry: Record<string, unknown>, path: string, seen: Set<string>, refuse: Refuse): string {
	const { id } = entry;
	if (typeof id !== "string" || id.trim() === "") refuse(`${path}.id`, "id is required");
	else if (seen.has(id)) refuse(`${path}.id`, "id must be unique across holes and slots");
	else seen.add(id);
	return typeof id === "string" ? id : "";
}

/** Checks the job spec a verifier is given. Unknown fields are refused, so a typo cannot silently drop a rule. */
export function validateSpec(input: unknown): Checked<Spec> {
	if (!isRecord(input)) return { ok: false, errors: [{ path: "", message: "spec must be an object" }] };
	const errors: FieldError[] = [];
	const refuse: Refuse = (path, message) => {
		errors.push({ path, message });
	};

	for (const key of Object.keys(input)) if (!SPEC_FIELDS.includes(key)) refuse(key, "unknown field");

	const { material, thicknessMm, bedMm, partMm, kerfMm, toleranceMm, minWebMm } = input;
	if (typeof material !== "string" || material.trim() === "") refuse("material", "material is required");
	if (!isPositive(thicknessMm)) refuse("thicknessMm", "thickness must be greater than 0");
	const bed = vec2Of(bedMm, true);
	if (bed === null) refuse("bedMm", "bed must be two positive numbers in mm");
	const part = vec2Of(partMm, true);
	if (part === null) refuse("partMm", "part must be two positive numbers in mm");
	if (!(isFiniteNumber(kerfMm) && kerfMm >= 0 && kerfMm < 1)) refuse("kerfMm", "kerf must be from 0 up to 1 mm");
	if (!isPositive(toleranceMm)) refuse("toleranceMm", "tolerance must be greater than 0");
	if (!isPositive(minWebMm)) refuse("minWebMm", "minimum web must be greater than 0");

	const seen = new Set<string>();
	const holes: SpecHole[] = [];
	listOf(input.holes, "holes", refuse).forEach((entry, i) => {
		const path = `holes[${i}]`;
		if (!isRecord(entry)) return refuse(path, "hole must be an object");
		for (const key of Object.keys(entry)) if (!HOLE_FIELDS.includes(key)) refuse(`${path}.${key}`, "unknown field");
		const id = idOf(entry, path, seen, refuse);
		const centre = vec2Of(entry.centreMm, false);
		if (centre === null) refuse(`${path}.centreMm`, "centre must be two numbers in mm");
		else if (part !== null && (centre[0] < 0 || centre[1] < 0 || centre[0] > part[0] || centre[1] > part[1]))
			refuse(`${path}.centreMm`, "centre must lie within the part");
		if (!isPositive(entry.diameterMm)) refuse(`${path}.diameterMm`, "diameter must be greater than 0");
		holes.push({ id, centreMm: centre ?? [0, 0], diameterMm: entry.diameterMm as number });
	});

	const slots: SpecSlot[] = [];
	listOf(input.slots, "slots", refuse).forEach((entry, i) => {
		const path = `slots[${i}]`;
		if (!isRecord(entry)) return refuse(path, "slot must be an object");
		for (const key of Object.keys(entry)) if (!SLOT_FIELDS.includes(key)) refuse(`${path}.${key}`, "unknown field");
		const id = idOf(entry, path, seen, refuse);
		const size = vec2Of(entry.sizeMm, true);
		if (size === null) refuse(`${path}.sizeMm`, "size must be two positive numbers in mm");
		slots.push({ id, sizeMm: size ?? [0, 0] });
	});

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			material: material as string,
			thicknessMm: thicknessMm as number,
			bedMm: bed as Vec2,
			partMm: part as Vec2,
			kerfMm: kerfMm as number,
			toleranceMm: toleranceMm as number,
			minWebMm: minWebMm as number,
			holes,
			slots,
		},
	};
}
