import { createHash } from "node:crypto";
import type { CommitSha, Digest, TestId } from "./ids.ts";
import type { DefinitionOfDone, Glob } from "./verifier.ts";

export const ISSUE = {
	repository: "maya-client/invoice-app",
	issues: [{ number: 12, title: "Totals round wrong for 3-decimal currencies", suite: { commit: "a41c9e2", visible: 48, hidden: 6 } }],
} as const;
export const SEEDED_USERS = [{ handle: "maya-client", role: "CLIENT" }, { handle: "devon-ops", role: "OPERATOR" }] as const;
export function frozenDefinition(): DefinitionOfDone {
	return { issue: { repository: ISSUE.repository, number: 12, title: ISSUE.issues[0].title },
		frozenAt: "a41c9e2" as CommitSha,
		frozenTests: Array.from({ length: 48 }, (_, i) => `visible_${i + 1}` as TestId),
		hiddenTests: Array.from({ length: 6 }, (_, i) => `hidden_${i + 1}` as TestId),
		hiddenManifest: createHash("sha256").update("acquit-skeleton-hidden-suite").digest("hex") as Digest,
		protectedPaths: ["tests/**", ".github/**", "package.json", "package-lock.json"] as Glob[] };
}
