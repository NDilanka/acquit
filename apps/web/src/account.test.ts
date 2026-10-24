import assert from "node:assert/strict";
import { test } from "node:test";
import {
  afterSwitch,
  canSwitchRole,
  cardName,
  initials,
  linkSaved,
  markLinkSaved,
  PRIVATE_COPY,
  recoveryLink,
  restoreFailure,
  roleHome,
  signOutPrompt,
  START_COPY,
  startFailure,
  switchedToast,
  tokenFromHash,
  welcomeBackToast,
} from "./account.ts";
import { ApiError } from "./api.ts";
import type { AccountView } from "./api-types.ts";
import { errorText } from "./errors.ts";

const account: AccountView = {
  name: "Teal Otter",
  client: "teal-otter",
  operator: "teal-otter-ops",
  roles: ["CLIENT", "OPERATOR"],
  repository: "acquit-forks/teal-otter",
  lasting: true,
  recoveryLinkMade: false,
};
const token = `${"a".repeat(20)}-${"B".repeat(20)}_0`;

function memoryStore(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

test("the saved link carries its token in the fragment of /welcome-back, and only a 43-character token reads back", () => {
  assert.equal(token.length, 43);
  assert.equal(recoveryLink("https://acquit.example", token), `https://acquit.example/welcome-back#${token}`);
  assert.equal(tokenFromHash(`#${token}`), token);
  assert.equal(tokenFromHash(token), token);
  assert.equal(tokenFromHash(""), null);
  assert.equal(tokenFromHash("#"), null);
  assert.equal(tokenFromHash(`#${token}x`), null);
  assert.equal(tokenFromHash(`#${token.slice(1)}`), null);
  assert.equal(tokenFromHash("#AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/abcde"), null);
});

test("each role has its home, and a switch keeps a job page but sends every other page home", () => {
  assert.equal(roleHome("CLIENT"), "/");
  assert.equal(roleHome("OPERATOR"), "/operator");
  assert.equal(roleHome("PLATFORM"), "/studio");
  assert.equal(afterSwitch("/jobs/job_42", "OPERATOR"), "/jobs/job_42");
  assert.equal(afterSwitch("/jobs/job_42", "CLIENT"), "/jobs/job_42");
  assert.equal(afterSwitch("/", "OPERATOR"), "/operator");
  assert.equal(afterSwitch("/jobs/new", "OPERATOR"), "/operator");
  assert.equal(afterSwitch("/operator/bids", "CLIENT"), "/");
});

test("the toasts name the new role and the account", () => {
  assert.equal(switchedToast("OPERATOR"), "You are working as an operator now.");
  assert.equal(switchedToast("CLIENT"), "You are working as a client now.");
  assert.equal(welcomeBackToast(account), "Welcome back, Teal Otter.");
  assert.equal(welcomeBackToast({ ...account, name: null }), "Welcome back, Your account.");
  assert.equal(START_COPY.made, "Welcome to Acquit. Your account is ready.");
});

test("the card shows the account's name, or a seeded user's handle, with two initials", () => {
  assert.equal(cardName({ handle: "teal-otter", role: "CLIENT" }, account), "Teal Otter");
  assert.equal(cardName({ handle: "teal-otter-ops", role: "OPERATOR" }, account), "Teal Otter");
  assert.equal(cardName({ handle: "maya-client", role: "CLIENT" }, null), "maya-client");
  assert.equal(initials("Teal Otter"), "TO");
  assert.equal(initials("maya-client"), "MC");
  assert.equal(initials("platform"), "PL");
});

test("only an account holding both roles gets the role switch", () => {
  assert.equal(canSwitchRole({ handle: "teal-otter", role: "CLIENT" }, account), true);
  assert.equal(canSwitchRole({ handle: "teal-otter-ops", role: "OPERATOR" }, account), true);
  assert.equal(canSwitchRole({ handle: "maya-client", role: "CLIENT" }, null), false);
  assert.equal(canSwitchRole({ handle: "platform", role: "PLATFORM" }, null), false);
  assert.equal(canSwitchRole({ handle: "teal-otter", role: "CLIENT" }, { ...account, roles: ["CLIENT"] }), false);
});

test("the saved flag is kept per account, survives bad storage, and a new link clears it", () => {
  const store = memoryStore();
  assert.equal(linkSaved(store, "teal-otter"), false);
  markLinkSaved(store, "teal-otter", true);
  assert.equal(linkSaved(store, "teal-otter"), true);
  assert.equal(linkSaved(store, "amber-heron"), false);
  assert.equal(store.data.get("acquit.savedLinks"), '{"teal-otter":true}');
  markLinkSaved(store, "teal-otter", false);
  assert.equal(linkSaved(store, "teal-otter"), false);
  store.data.set("acquit.savedLinks", "not json");
  assert.equal(linkSaved(store, "teal-otter"), false);
  const refusing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  assert.doesNotThrow(() => markLinkSaved(refusing, "teal-otter", true));
});

test("signing out asks to save first until the link was copied", () => {
  assert.deepEqual(signOutPrompt(true), {
    title: "Sign out?",
    body: "Your account stays. Open your saved link to come back.",
    confirm: "Sign out",
    cancel: "Back",
    saveFirst: false,
  });
  assert.deepEqual(signOutPrompt(false), {
    title: "Save your account first?",
    body: "You have not copied your account link. Without it, you cannot come back to this account.",
    confirm: "Save your account",
    cancel: "Sign out anyway",
    saveFirst: true,
  });
});

test("Try Acquit tells the day's limit and the private deployment apart from any other failure", () => {
  assert.equal(startFailure(new ApiError(429, "CAP_VISITORS_DAY")), "limit");
  assert.equal(startFailure(new ApiError(403, "DEMO_PRIVATE")), "private");
  assert.equal(startFailure(new ApiError(503, "DEMO_NOT_CONFIGURED")), "error");
  assert.equal(startFailure(new TypeError("Failed to fetch")), "error");
  assert.equal(errorText(new ApiError(429, "CAP_VISITORS_DAY")),
    "Acquit has made as many new accounts as it can today. Try again tomorrow, or open your saved account link.");
  assert.equal(PRIVATE_COPY.heading, "Acquit is private for now");
  assert.equal(PRIVATE_COPY.line, "New accounts open soon. Everything runs on the PayPal sandbox.");
});

test("a link that opens nothing reads as gone, and the rate limit and the network read as errors", () => {
  assert.equal(restoreFailure(new ApiError(404, "NOT_FOUND")), "gone");
  assert.equal(restoreFailure(new ApiError(429, "RESTORE_LIMITED")), "error");
  assert.equal(restoreFailure(new TypeError("Failed to fetch")), "error");
  assert.equal(errorText(new ApiError(429, "RESTORE_LIMITED")), "Too many tries from this network. Wait 15 minutes, then open the link again.");
});

test("no account sentence uses the old demo words", () => {
  const words = [...START_COPY.points, START_COPY.lead, START_COPY.failed, START_COPY.saved, PRIVATE_COPY.heading, PRIVATE_COPY.line,
    errorText(new ApiError(403, "NOT_VISITOR_JOB")), errorText(new ApiError(403, "CAP_VISITOR_JOBS")), errorText(new ApiError(403, "SEEDED_LOGIN_DISABLED"))];
  for (const sentence of words) assert.doesNotMatch(sentence, /demo|visitor|guest|judge/i, sentence);
});
