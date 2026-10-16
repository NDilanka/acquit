// Commit, then reveal, for a job's per-job hidden cases. Freeze publishes a salted digest of the
// approved set on the job's manifest. Once the job closes (PAID, REFUNDED, or CLOSED), the cases and
// the salt open that digest, so anyone can recompute it. Only AI-drafted per-job cases can be sealed:
// PerJobHiddenCase is branded and perJobCaseOf is its one constructor, so a curated fixture case (a
// plain HiddenCase loaded from a fixture file) cannot reach a reveal.

import { createHash, randomBytes } from "node:crypto";
import type { Digest } from "./ids.ts";
import type { JobStatus } from "./job.ts";
import { hiddenCaseOf } from "./scoping.ts";
import type { ScopeCandidate } from "./scoping.ts";
import type { HiddenCase, SealedHiddenCases } from "./verifier.ts";

declare const perJobBrand: unique symbol;
/** A hidden case one job's client approved from AI scoping. perJobCaseOf is the only way to make one. */
export type PerJobHiddenCase = HiddenCase & { readonly [perJobBrand]: true };

/** The set a closed job publishes: the approved cases, the salt that opened the seal, and the digest they recompute to. */
export type RevealedHiddenCases = { readonly cases: readonly PerJobHiddenCase[]; readonly salt: string; readonly digest: Digest };

export type RevealOutcome =
	| { readonly kind: "REVEALED"; readonly value: RevealedHiddenCases }
	| { readonly kind: "NOT_CLOSED" }
	| { readonly kind: "NOT_SEALED" }
	| { readonly kind: "DIGEST_MISMATCH" };

/** The statuses a job reaches only by closing. Before one of these, the cases and the salt stay private. */
export const CLOSED_STATUSES: readonly JobStatus[] = ["PAID", "REFUNDED", "CLOSED"];

const SALT_HEX = /^[0-9a-f]{64}$/;

/** The approval's own mapping of a kept candidate. The citation is review prose and never enters a case. */
export function perJobCaseOf(candidate: ScopeCandidate): PerJobHiddenCase {
	return hiddenCaseOf(candidate) as PerJobHiddenCase;
}

/** Object keys sort in UTF-16 code-unit order. Default sort, not localeCompare: the order must not vary by host locale. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/** sha256 over the salt, a newline, and the canonical JSON of the cases. The salt is fixed-length hex, so the newline cannot be ambiguous. */
export function digestOfHiddenCases(cases: readonly HiddenCase[], salt: string): Digest {
	if (!SALT_HEX.test(salt)) throw new Error("A hidden-case salt is 32 bytes of lowercase hex.");
	return createHash("sha256").update(`${salt}\n${canonicalJson(cases)}`).digest("hex") as Digest;
}

/** Freeze: draws a fresh salt and seals the approved set under it. The caller stores `sealed` on the manifest and keeps `salt` private until close. */
export function sealHiddenCases(cases: readonly PerJobHiddenCase[]): { readonly sealed: SealedHiddenCases; readonly salt: string } {
	const salt = randomBytes(32).toString("hex");
	return { sealed: { digest: digestOfHiddenCases(cases, salt) }, salt };
}

/** Close: the cases and the salt open the frozen digest, or the reveal refuses by name. */
export function revealHiddenCases(status: JobStatus, sealed: SealedHiddenCases | null, cases: readonly PerJobHiddenCase[], salt: string): RevealOutcome {
	if (!CLOSED_STATUSES.includes(status)) return { kind: "NOT_CLOSED" };
	if (sealed === null) return { kind: "NOT_SEALED" };
	const digest = digestOfHiddenCases(cases, salt);
	if (digest !== sealed.digest) return { kind: "DIGEST_MISMATCH" };
	return { kind: "REVEALED", value: { cases, salt, digest } };
}
