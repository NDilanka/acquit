// The seeded handles and the demo repository name, declared once. The fixture data a job's manifest
// freezes (the frozen commit, the frozen test path, the protected paths, the issue) lives in the
// deployment's fixture registry; the hidden cases live in its private store. Nothing here builds a
// contract: OpenJob freezes one per job from the registry.

/** The demo repository name, for configuration defaults and error text. A deployment that names ACQUIT_CLIENT_REPOSITORY replaces it. */
export const DEMO_CLIENT_REPOSITORY = "maya-client/invoice-app";

export const SEEDED_USERS = [{ handle: "maya-client", role: "CLIENT" }, { handle: "devon-ops", role: "OPERATOR" }] as const;
