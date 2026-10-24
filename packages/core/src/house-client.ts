// The House client: Acquit's own client inside each lasting account's private workspace. It posts the starter jobs
// the account's operator side can win, accepts a bid on them, and approves the verified work, always through the
// same commands a person sends. It is never a principal: no session, saved link, or sign-in can act as it.

import type { Actor } from "./acquit.ts";
import type { ClientId, VisitorId } from "./ids.ts";

export const HOUSE_CLIENT_ID = "house-client" as ClientId;

/** The name every view shows for the House client. */
export const HOUSE_CLIENT_LABEL = "House client";

/** The actor the House client sends its commands as, inside one account's workspace and on that account's fork. */
export function houseClientActor(tenant: VisitorId, repository: string | null): Actor {
	return { role: "CLIENT", clientId: HOUSE_CLIENT_ID, tenant, ...(repository === null ? {} : { repository }) };
}

export function isHouseClient(actor: Actor | { readonly role: string }): boolean {
	return actor.role === "CLIENT" && "clientId" in actor && actor.clientId === HOUSE_CLIENT_ID;
}

/** A starter job is one the House client opened. The job row's own client says so, so nothing else has to agree. */
export function isStarterJob(row: { readonly client: ClientId }): boolean {
	return row.client === HOUSE_CLIENT_ID;
}
