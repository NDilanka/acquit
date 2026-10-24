// A Try Acquit account's recovery link. The token is 32 random bytes, handed to the account once; the row keeps
// only its SHA-256, so a copy of the database restores nobody. Making a new token replaces the digest, which is
// what ends the old link.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Instant, VisitorId } from "./ids.ts";
import { principalOf, readVisitor } from "./visitors.ts";
import type { VisitorRow } from "./visitors.ts";

/** A recovery token as it travels: 32 bytes in unpadded base64url. */
const RECOVERY_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Whether a visitor is a lasting account that is ready to use: no expiry, and provisioned. */
export function isLastingAccount(visitor: VisitorRow): boolean {
	return visitor.expiresAt === null && visitor.state === "ACTIVE";
}

/**
 * Makes the account's recovery token, replacing any earlier one, and returns it. Null when the visitor is not a
 * lasting account: a scenario visitor or an expiring one has nothing to come back to.
 */
export function makeRecoveryToken(db: DatabaseSync, id: VisitorId, now: Instant): string | null {
	const token = randomBytes(32).toString("base64url");
	const changed = db.prepare(`UPDATE visitors SET recovery_digest = ?, recovery_made_at = ?
		WHERE id = ? AND expires_at IS NULL AND state = 'ACTIVE'`).run(digestOf(token), now, id).changes;
	return changed === 1 ? token : null;
}

/** Whether the account has a live recovery token. */
export function recoveryLinkMade(db: DatabaseSync, id: VisitorId): boolean {
	return db.prepare("SELECT 1 FROM visitors WHERE id = ? AND recovery_digest IS NOT NULL").get(id) !== undefined;
}

/**
 * The account a recovery token opens, or null for any token that does not open one. The lookup is by digest, so
 * the stored value an attacker could time against is a hash of their own guess; the found digest is compared again
 * in constant time. Only a lasting, active account answers, and only through its own client principal, so no token
 * can reach a seeded handle, the platform, or another visitor's row.
 */
export function accountForRecoveryToken(db: DatabaseSync, token: string): VisitorRow | null {
	if (!RECOVERY_TOKEN.test(token)) return null;
	const digest = digestOf(token);
	const found = db.prepare(`SELECT id, recovery_digest FROM visitors
		WHERE recovery_digest = ? AND expires_at IS NULL AND state = 'ACTIVE'`).get(digest);
	if (!found) return null;
	const stored = Buffer.from(String(found.recovery_digest), "hex");
	const offered = Buffer.from(digest, "hex");
	if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) return null;
	const visitor = readVisitor(db, String(found.id) as VisitorId);
	if (visitor === null || !isLastingAccount(visitor)) return null;
	const principal = principalOf(db, visitor.clientHandle);
	if (principal === null || principal.role !== "CLIENT" || principal.visitorId !== visitor.id) return null;
	return visitor;
}
