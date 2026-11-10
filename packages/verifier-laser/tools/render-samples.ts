import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_DIR = fileURLToPath(new URL("../samples/", import.meta.url));
export const SAMPLES_MODULE = fileURLToPath(new URL("../src/samples.ts", import.meta.url));

/** Every file in samples/, keyed by file name, read as the exact text the browser will receive. */
export function readSampleFiles(dir: string = SAMPLE_DIR): Record<string, string> {
	const files: Record<string, string> = {};
	for (const name of readdirSync(dir).sort()) files[name] = readFileSync(join(dir, name), "utf8");
	return files;
}

/** Renders the generated module. JSON string literals keep every character of each file. */
export function renderSamples(files: Readonly<Record<string, string>>): string {
	const entries = Object.keys(files)
		.sort()
		.map(name => `\t${JSON.stringify(name)}: ${JSON.stringify(files[name])},`);
	return [
		"// Generated from samples/ by tools/generate-samples.ts. Do not edit by hand.",
		"export const SAMPLE_TEXT: Readonly<Record<string, string>> = {",
		...entries,
		"};",
		"",
	].join("\n");
}
