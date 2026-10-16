// Runs PrusaSlicer headless on one STL with one profile and returns the G-code text. The binary is named by
// the caller, so the same code runs against a PATH install in CI and a full path on a workstation.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PrusaSlicer 2.7 has no --version flag. Its --help banner carries the version, and it can exit non-zero.
export function prusaVersion(binary: string): string {
	const help = spawnSync(binary, ["--help"], { encoding: "utf8", stdio: "pipe", timeout: 60_000 });
	const banner = /PrusaSlicer-\S+/.exec(`${help.stdout ?? ""}${help.stderr ?? ""}`);
	if (!banner) throw new Error(`no PrusaSlicer banner from "${binary} --help"`);
	return banner[0];
}

export function slicePrusa(binary: string, profilePath: string, stl: Uint8Array): string {
	const dir = mkdtempSync(join(tmpdir(), "acquit-prusa-"));
	try {
		const model = join(dir, "model.stl");
		const out = join(dir, "model.gcode");
		writeFileSync(model, stl);
		execFileSync(binary, ["--export-gcode", "--load", profilePath, "-o", out, model], {
			stdio: "pipe",
			timeout: 300_000,
		});
		return readFileSync(out, "utf8");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
