import type { Digest, Instant } from "../../core/src/ids.ts";
import { MATERIALS, mm } from "./types.ts";
import type { Checked, FieldError, Material, PrintSpec } from "./types.ts";

const SPEC_FIELDS = ["modelDigest", "material", "color", "quantity", "toleranceMm", "infillPct", "walls", "maxLayerHeightMm", "printBy", "deliverBy"];
const DIGEST = /^[0-9a-f]{64}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function validateSpec(input: unknown): Checked<PrintSpec> {
	if (!isRecord(input)) return { ok: false, errors: [{ path: "", message: "spec must be an object" }] };
	const errors: FieldError[] = [];
	const refuse = (path: string, message: string) => { errors.push({ path, message }); };

	for (const key of Object.keys(input)) if (!SPEC_FIELDS.includes(key)) refuse(key, "unknown field");

	const { modelDigest, material, color, quantity, toleranceMm, infillPct, walls, maxLayerHeightMm, printBy, deliverBy } = input;

	if (typeof modelDigest !== "string" || !DIGEST.test(modelDigest)) refuse("modelDigest", "model digest must be sha256 hex");
	// Object.hasOwn rather than `in`, because "toString" is on every object and must still be an unknown material.
	if (typeof material !== "string" || !Object.hasOwn(MATERIALS, material)) refuse("material", "unknown material");

	if (!isRecord(color)) refuse("color", "color must be an object");
	const colorName = isRecord(color) ? color.name : undefined;
	const colorHex = isRecord(color) ? color.hex : undefined;
	if (typeof colorName !== "string" || colorName.trim() === "") refuse("color.name", "color name is required");
	if (colorHex !== null && (typeof colorHex !== "string" || !HEX_COLOR.test(colorHex))) refuse("color.hex", "color hex must be #rrggbb or null");

	if (!(typeof quantity === "number" && Number.isInteger(quantity) && quantity >= 1 && quantity <= 10)) refuse("quantity", "quantity must be an integer from 1 to 10");
	if (!(isFiniteNumber(toleranceMm) && toleranceMm > 0)) refuse("toleranceMm", "tolerance must be greater than 0");
	if (!(isFiniteNumber(infillPct) && infillPct >= 0 && infillPct <= 100)) refuse("infillPct", "infill must be between 0 and 100");
	if (!(typeof walls === "number" && Number.isInteger(walls) && walls >= 1)) refuse("walls", "walls must be a positive integer");
	if (!(isFiniteNumber(maxLayerHeightMm) && maxLayerHeightMm > 0)) refuse("maxLayerHeightMm", "max layer height must be greater than 0");

	for (const [path, value] of [["printBy", printBy], ["deliverBy", deliverBy]] as const) {
		if (value === undefined || value === null) refuse(path, "missing deadline");
		else if (typeof value !== "string" || !UTC_INSTANT.test(value) || Number.isNaN(Date.parse(value))) refuse(path, "deadline must be a UTC instant");
	}

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			modelDigest: modelDigest as Digest,
			material: material as Material,
			color: { name: colorName as string, hex: colorHex as string | null },
			quantity: quantity as number,
			toleranceMm: mm(toleranceMm as number),
			infillPct: infillPct as number,
			walls: walls as number,
			maxLayerHeightMm: mm(maxLayerHeightMm as number),
			printBy: printBy as Instant,
			deliverBy: deliverBy as Instant,
		},
	};
}
