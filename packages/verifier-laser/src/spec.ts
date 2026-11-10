import { MIN_TOLERANCE_MM } from "./svg.ts";
import type { Checked, FieldError, Spec, SpecHole, SpecRect, SpecSlot, Vec2 } from "./types.ts";

const SPEC_FIELDS = [
	"material",
	"thicknessMm",
	"bedMm",
	"partMm",
	"kerfMm",
	"toleranceMm",
	"minWebMm",
	"cornerRadiusMm",
	"labelRegionMm",
	"minEngraveLengthMm",
	"holes",
	"slots",
];
const HOLE_FIELDS = ["id", "centreMm", "diameterMm", "toleranceMm"];
const SLOT_FIELDS = ["id", "sizeMm", "toleranceMm"];
const RECT_FIELDS = ["originMm", "sizeMm"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isPositive = (value: unknown): value is number => isFiniteNumber(value) && value > 0;
/** A tolerance the fits can judge. A smaller one is refused, never raised. */
const isSupportedTolerance = (value: unknown): value is number => isFiniteNumber(value) && value >= MIN_TOLERANCE_MM;
const TOLERANCE_MESSAGE = `tolerance must be at least ${MIN_TOLERANCE_MM} mm`;

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

/** A feature's own tolerance when it sets one, otherwise the spec's global tolerance. */
function toleranceOf(entry: Record<string, unknown>, path: string, fallback: number, refuse: Refuse): number {
	if (entry.toleranceMm === undefined) return fallback;
	if (isSupportedTolerance(entry.toleranceMm)) return entry.toleranceMm;
	refuse(`${path}.toleranceMm`, TOLERANCE_MESSAGE);
	return fallback;
}

function labelOf(value: unknown, part: Vec2 | null, refuse: Refuse): SpecRect {
	if (!isRecord(value)) {
		refuse("labelRegionMm", "label region must be an object with originMm and sizeMm");
		return { originMm: [0, 0], sizeMm: [0, 0] };
	}
	for (const key of Object.keys(value)) if (!RECT_FIELDS.includes(key)) refuse(`labelRegionMm.${key}`, "unknown field");
	const origin = vec2Of(value.originMm, false);
	const size = vec2Of(value.sizeMm, true);
	if (origin === null) refuse("labelRegionMm.originMm", "origin must be two numbers in mm");
	if (size === null) refuse("labelRegionMm.sizeMm", "size must be two positive numbers in mm");
	if (
		origin !== null &&
		size !== null &&
		part !== null &&
		(origin[0] < 0 || origin[1] < 0 || origin[0] + size[0] > part[0] || origin[1] + size[1] > part[1])
	)
		refuse("labelRegionMm", "label region must lie inside the part");
	return { originMm: origin ?? [0, 0], sizeMm: size ?? [0, 0] };
}

/** Checks the job spec a verifier is given. Unknown fields are refused, so a typo cannot silently drop a rule. */
export function validateSpec(input: unknown): Checked<Spec> {
	if (!isRecord(input)) return { ok: false, errors: [{ path: "", message: "spec must be an object" }] };
	const errors: FieldError[] = [];
	const refuse: Refuse = (path, message) => {
		errors.push({ path, message });
	};

	for (const key of Object.keys(input)) if (!SPEC_FIELDS.includes(key)) refuse(key, "unknown field");

	const { material, thicknessMm, bedMm, partMm, kerfMm, toleranceMm, minWebMm, cornerRadiusMm } = input;
	if (typeof material !== "string" || material.trim() === "") refuse("material", "material is required");
	if (!isPositive(thicknessMm)) refuse("thicknessMm", "thickness must be greater than 0");
	const bed = vec2Of(bedMm, true);
	if (bed === null) refuse("bedMm", "bed must be two positive numbers in mm");
	const part = vec2Of(partMm, true);
	if (part === null) refuse("partMm", "part must be two positive numbers in mm");
	if (!(isFiniteNumber(kerfMm) && kerfMm >= 0 && kerfMm < 1)) refuse("kerfMm", "kerf must be from 0 up to 1 mm");
	if (!isSupportedTolerance(toleranceMm)) refuse("toleranceMm", TOLERANCE_MESSAGE);
	if (!isPositive(minWebMm)) refuse("minWebMm", "minimum web must be greater than 0");
	if (!isFiniteNumber(cornerRadiusMm) || cornerRadiusMm < 0) refuse("cornerRadiusMm", "corner radius must be 0 or more");
	else if (part !== null && cornerRadiusMm * 2 >= Math.min(part[0], part[1]))
		refuse("cornerRadiusMm", "corner radius must be less than half the smaller part side");
	const label = labelOf(input.labelRegionMm, part, refuse);
	const { minEngraveLengthMm } = input;
	if (!isPositive(minEngraveLengthMm)) refuse("minEngraveLengthMm", "minimum engraved length must be greater than 0 mm");

	const globalTolerance = isSupportedTolerance(toleranceMm) ? toleranceMm : 0;
	const seen = new Set<string>();
	const holes: SpecHole[] = [];
	listOf(input.holes, "holes", refuse).forEach((entry, i) => {
		const path = `holes[${i}]`;
		if (!isRecord(entry)) return refuse(path, "hole must be an object");
		for (const key of Object.keys(entry)) if (!HOLE_FIELDS.includes(key)) refuse(`${path}.${key}`, "unknown field");
		const id = idOf(entry, path, seen, refuse);
		const centre = vec2Of(entry.centreMm, false);
		const diameter = entry.diameterMm;
		if (centre === null) refuse(`${path}.centreMm`, "centre must be two numbers in mm");
		if (!isPositive(diameter)) refuse(`${path}.diameterMm`, "diameter must be greater than 0");
		else if (centre !== null && part !== null) {
			const radius = diameter / 2;
			if (centre[0] - radius < 0 || centre[1] - radius < 0 || centre[0] + radius > part[0] || centre[1] + radius > part[1])
				refuse(`${path}.centreMm`, "hole must lie wholly inside the part");
		}
		holes.push({
			id,
			centreMm: centre ?? [0, 0],
			diameterMm: isPositive(diameter) ? diameter : 0,
			toleranceMm: toleranceOf(entry, path, globalTolerance, refuse),
		});
	});

	const slots: SpecSlot[] = [];
	listOf(input.slots, "slots", refuse).forEach((entry, i) => {
		const path = `slots[${i}]`;
		if (!isRecord(entry)) return refuse(path, "slot must be an object");
		for (const key of Object.keys(entry)) if (!SLOT_FIELDS.includes(key)) refuse(`${path}.${key}`, "unknown field");
		const id = idOf(entry, path, seen, refuse);
		const size = vec2Of(entry.sizeMm, true);
		if (size === null) refuse(`${path}.sizeMm`, "size must be two positive numbers in mm");
		else if (part !== null && (size[0] >= part[0] || size[1] >= part[1]))
			refuse(`${path}.sizeMm`, "slot must be smaller than the part in each direction");
		slots.push({ id, sizeMm: size ?? [0, 0], toleranceMm: toleranceOf(entry, path, globalTolerance, refuse) });
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
			cornerRadiusMm: cornerRadiusMm as number,
			labelRegionMm: label,
			minEngraveLengthMm: minEngraveLengthMm as number,
			holes,
			slots,
		},
	};
}
