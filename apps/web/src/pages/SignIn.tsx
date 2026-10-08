import { useEffect, useState } from "react";
import { api, ApiError, type SessionUser } from "../api";
import { errorText } from "../demo";
import type { Session } from "../session";

/** Dev mode serves the seeded picker; public mode answers the unauthenticated user list with 401. */
type Mode = { kind: "loading" } | { kind: "picker"; users: SessionUser[] } | { kind: "demo" };

export function SignIn({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .users()
      .then((r) => setMode({ kind: "picker", users: r.users }))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setMode({ kind: "demo" });
        else setError(errorText(e));
      });
  }, []);

  const run = async (label: string, start: () => Promise<Session>) => {
    setBusy(label);
    setError(null);
    try {
      onSignedIn(await start());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (mode.kind === "demo") {
    return (
      <div className="signin card">
        <div className="eyebrow">Judge mode</div>
        <h1>Try Acquit with your own demo</h1>
        <p className="muted">
          You get a client and an operator of your own and a fresh copy of the demo repository. Nobody else sees your jobs. Payments
          run against the PayPal sandbox, and the demo ends after 24 hours.
        </p>
        {error && <div className="alert">{error}</div>}
        <button className="btn green" disabled={busy !== null} onClick={() => void run("demo", () => api.startDemo())}>
          {busy ? "Starting your demo…" : "Start my demo"}
        </button>
      </div>
    );
  }

  return (
    <div className="signin card">
      <div className="eyebrow">Dev sign-in</div>
      <h1>Sign in as a seeded user</h1>
      <p className="muted">
        The skeleton has no passwords. Pick a user; payments run against the PayPal sandbox.
      </p>
      {error && <div className="alert">{error}</div>}
      {mode.kind === "loading" && !error && <p className="muted">Loading users…</p>}
      <div className="userlist">
        {mode.kind === "picker" &&
          mode.users.map((u) => (
            <button key={u.handle} className="userpick" disabled={busy !== null} onClick={() => void run(u.handle, () => api.signIn(u.handle))}>
              <i>{u.handle.slice(0, 2).toUpperCase()}</i>
              <span>
                <b>{u.handle}</b>
                <small>{u.role === "CLIENT" ? "Client: I want work done" : "Operator: I deliver work"}</small>
              </span>
              {busy === u.handle && <small className="muted">Signing in…</small>}
            </button>
          ))}
      </div>
    </div>
  );
}
