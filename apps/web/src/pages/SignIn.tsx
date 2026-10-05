import { useEffect, useState } from "react";
import { api, ApiError, type SessionUser } from "../api";

export function SignIn({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
  const [users, setUsers] = useState<SessionUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .users()
      .then((r) => setUsers(r.users))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : `Cannot reach the API: ${String(e)}`));
  }, []);

  const pick = async (handle: string) => {
    setBusy(handle);
    setError(null);
    try {
      const r = await api.signIn(handle);
      onSignedIn(r.user);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="signin card">
      <div className="eyebrow">Dev sign-in</div>
      <h1>Sign in as a seeded user</h1>
      <p className="muted">
        The skeleton has no passwords. Pick a user; payments run against the PayPal sandbox.
      </p>
      {error && <div className="alert">{error}</div>}
      {!users && !error && <p className="muted">Loading users…</p>}
      <div className="userlist">
        {users?.map((u) => (
          <button key={u.handle} className="userpick" disabled={busy !== null} onClick={() => void pick(u.handle)}>
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
