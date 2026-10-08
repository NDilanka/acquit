import { useEffect, useState } from "react";
import { api, type SessionUser } from "../api";
import type { DeploymentMode } from "../api-types";
import { errorText } from "../demo";
import type { Session } from "../session";

type SignedIn = (session: Session) => void;

export function SignIn({ mode, onSignedIn }: { mode: DeploymentMode; onSignedIn: SignedIn }) {
  return mode === "public" ? <StartDemo onSignedIn={onSignedIn} /> : <SeededPicker onSignedIn={onSignedIn} />;
}

function useSignIn(onSignedIn: SignedIn) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
  return { error, setError, busy, run };
}

function StartDemo({ onSignedIn }: { onSignedIn: SignedIn }) {
  const { error, busy, run } = useSignIn(onSignedIn);
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

function SeededPicker({ onSignedIn }: { onSignedIn: SignedIn }) {
  const { error, setError, busy, run } = useSignIn(onSignedIn);
  const [users, setUsers] = useState<SessionUser[] | null>(null);

  useEffect(() => {
    api
      .users()
      .then((r) => setUsers(r.users))
      .catch((e: unknown) => setError(errorText(e)));
  }, [setError]);

  return (
    <div className="signin card">
      <div className="eyebrow">Dev sign-in</div>
      <h1>Sign in as a seeded user</h1>
      <p className="muted">
        The skeleton has no passwords. Pick a user; payments run against the PayPal sandbox.
      </p>
      {error && <div className="alert">{error}</div>}
      {users === null && !error && <p className="muted">Loading users…</p>}
      <div className="userlist">
        {users?.map((u) => (
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
