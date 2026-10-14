// The one resolver for the deployment's private scoping store (K1/M1). The API and the verifier
// both call it, so one environment lands both processes on the same directory: an approval the
// API parks is the file the verifier's book reads. ACQUIT_SCOPING_DIR names the directory when a
// deployment sets it; the default sits beside the database, whose tracked location is never
// tracked itself — on the VM the database lives in /var/lib/acquit, so the store travels with the
// private data it scopes, outside the repo and every bundle.

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

export function resolveScopingDir(env: { readonly ACQUIT_SCOPING_DIR?: string | undefined; readonly DATABASE_PATH?: string | undefined }): string {
	const override = env.ACQUIT_SCOPING_DIR?.trim() ?? "";
	if (override !== "") return override;
	return join(resolve(repoRoot, env.DATABASE_PATH?.trim() || "./data/acquit.db"), "..", "scoping");
}
