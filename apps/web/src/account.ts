import type { AccountView, SessionUser } from "./api-types";
import { ApiError } from "./api.ts";

type Role = SessionUser["role"];

/** The words of the Try Acquit card and the toast after it. */
export const START_COPY = {
  lead: "One click makes your own Acquit account. You can post jobs as a client and run agents as an operator. There is no sign-up form.",
  points: [
    "Your workspace is private. House agents and House clients trade with you, so every step is real.",
    "Payments use PayPal's sandbox. No real money moves.",
    "Save your account link to come back from any browser.",
  ],
  action: "Try Acquit",
  busy: "Making your account…",
  failed: "We could not make your account. Try again in a moment.",
  saved: "Already have an account? Open your saved account link.",
  staff: "Platform staff sign in",
  made: "Welcome to Acquit. Your account is ready.",
} as const;

/** The closed state, shown when the deployment keeps Try Acquit to a list of addresses. It names no date and promises nothing. */
export const PRIVATE_COPY = {
  heading: "Acquit is private for now",
  line: "New accounts open soon. Everything runs on the PayPal sandbox.",
} as const;

export const SAVE_COPY = {
  title: "Save your account",
  body: "Open this link in any browser to come back to this account.",
  label: "Your account link",
  warning: "Anyone with this link can use your account. Keep it private.",
  earlier: "You made a link for this account before, and Acquit shows a link only once. Make a new link to see one here. The old link then stops working.",
  copied: "Link copied.",
  renewed: "New link made. The old link no longer works.",
  confirmTitle: "Make a new link?",
  confirmBody: "The old link stops working. Save the new one.",
  renew: "Make a new link",
} as const;

export const WELCOME_BACK_COPY = {
  reading: "Opening your account…",
  gone: "This link no longer works. It may have been replaced by a newer link.",
  home: "Go to the home page",
} as const;

/** How Try Acquit failed: the day's account limit, the private deployment, or anything else. */
export function startFailure(e: unknown): "limit" | "private" | "error" {
  if (e instanceof ApiError && e.code === "CAP_VISITORS_DAY") return "limit";
  if (e instanceof ApiError && e.code === "DEMO_PRIVATE") return "private";
  return "error";
}

/** How opening a saved link failed. The API answers 404 for every token that opens nothing, whatever the reason. */
export function restoreFailure(e: unknown): "gone" | "error" {
  return e instanceof ApiError && e.status === 404 ? "gone" : "error";
}

/** A recovery token is 32 random bytes in base64url: 43 characters, no padding. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const WELCOME_BACK_PATH = "/welcome-back";

/** The saved account link. The token rides in the fragment, which a browser never sends in a request. */
export function recoveryLink(origin: string, token: string): string {
  return `${origin}${WELCOME_BACK_PATH}#${token}`;
}

/** The token in an address fragment, or null when the fragment holds none. */
export function tokenFromHash(hash: string): string | null {
  const token = hash.startsWith("#") ? hash.slice(1) : hash;
  return TOKEN.test(token) ? token : null;
}

export function roleHome(role: Role): string {
  return role === "OPERATOR" ? "/operator" : role === "PLATFORM" ? "/studio" : "/";
}

/** Where a role switch lands: a job page stays put and reloads as the new role, and any other page goes to the role's home. */
export function afterSwitch(path: string, role: Role): string {
  return /^\/jobs\/[^/]+\/?$/.test(path) && path !== "/jobs/new" ? path : roleHome(role);
}

export function switchedToast(role: Role): string {
  return role === "OPERATOR" ? "You are working as an operator now." : "You are working as a client now.";
}

export function welcomeBackToast(account: AccountView): string {
  return `Welcome back, ${accountName(account)}.`;
}

/** An account made before accounts had names has none, so it reads as "Your account". */
export function accountName(account: AccountView): string {
  return account.name ?? "Your account";
}

/** The name the account card shows: the account's name, or the handle of a seeded or platform session. */
export function cardName(user: SessionUser, account: AccountView | null): string {
  return account ? accountName(account) : user.handle;
}

export function initials(name: string): string {
  const words = name.split(/[\s-]+/).filter(Boolean);
  const letters = words.length > 1 ? (words[0]?.[0] ?? "") + (words[1]?.[0] ?? "") : name.slice(0, 2);
  return letters.toUpperCase();
}

export const ROLE_CAPTION: Readonly<Record<Role, string>> = { CLIENT: "Client", OPERATOR: "Operator", PLATFORM: "Platform" };

/** Only an account holding both roles gets the switch; seeded single-role users and the platform do not. */
export function canSwitchRole(user: SessionUser, account: AccountView | null): boolean {
  return account !== null && user.role !== "PLATFORM" && account.roles.includes("CLIENT") && account.roles.includes("OPERATOR");
}

type Store = Pick<Storage, "getItem" | "setItem">;

const SAVED_KEY = "acquit.savedLinks";

function readSaved(store: Store): Record<string, boolean> {
  try {
    const raw = store.getItem(SAVED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** Whether this browser copied the account's current link, keyed by the account's client handle. */
export function linkSaved(store: Store, client: string): boolean {
  return readSaved(store)[client] === true;
}

export function markLinkSaved(store: Store, client: string, saved: boolean): void {
  const all = readSaved(store);
  all[client] = saved;
  try {
    store.setItem(SAVED_KEY, JSON.stringify(all));
  } catch {
    // Storage that refuses a write only costs the reminder dot; the account itself is unaffected.
  }
}

export type SignOutPrompt = {
  readonly title: string;
  readonly body: string;
  readonly confirm: string;
  readonly cancel: string;
  /** True when the dialog's green action saves the link instead of signing out. */
  readonly saveFirst: boolean;
};

export function signOutPrompt(saved: boolean): SignOutPrompt {
  return saved
    ? { title: "Sign out?", body: "Your account stays. Open your saved link to come back.", confirm: "Sign out", cancel: "Back", saveFirst: false }
    : {
        title: "Save your account first?",
        body: "You have not copied your account link. Without it, you cannot come back to this account.",
        confirm: "Save your account",
        cancel: "Sign out anyway",
        saveFirst: true,
      };
}
