// The plain words the ask tools answer with, in place of the codes the book stores, so the model has no code to repeat.
// Kept equal to the Studio's own words (apps/web/src/job-status.ts, verdict-grid.ts, receipt-view.ts): the API cannot
// import the web program. A code a table does not name passes through as the server sent it.

type Words = Partial<Record<string, string>>;

const word = (table: Words, code: string): string => table[code] ?? code;

const JOB_STATUS: Words = {
	OPEN: "Open for bids",
	IN_PROGRESS: "In progress",
	VERIFIED: "Verified, awaiting release",
	PAID: "Paid",
	REFUNDED: "Refunded",
	CLOSED: "Closed",
};

const ESCROW: Words = { NONE: "Not funded", HELD: "Held", RELEASED: "Released", REFUNDED: "Refunded" };

const ATTEMPT_RESULT: Words = { VERIFIED: "Verified", REJECTED: "Rejected" };

const LEDGER_KIND: Words = { HELD: "Held", RELEASED: "Released", FEE: "Fee", REFUND: "Refunded" };

const PAYPAL_CHECK: Words = { NOT_CHECKED: "Not checked against PayPal" };

/** The reason codes the sample book carries, in the words a seller reads. */
const REASON: Words = {
	"TESTS_FAILED:frozen": "Visible tests failed",
	"TESTS_FAILED:hidden": "Hidden tests failed",
	PROTECTED_PATH_MODIFIED: "A protected test file was changed",
};

export const statusWord = (status: string): string => word(JOB_STATUS, status);
export const escrowWord = (escrow: string): string => word(ESCROW, escrow);
export const attemptResultWord = (result: string): string => word(ATTEMPT_RESULT, result);
export const ledgerKindWord = (kind: string): string => word(LEDGER_KIND, kind);
export const paypalCheckWord = (status: string): string => word(PAYPAL_CHECK, status);
export const reasonWord = (code: string): string => word(REASON, code);
