import { useEffect, useId, useState, type FormEvent } from "react";
import { PRIVATE_COPY, START_COPY, startFailure } from "../account";
import { api, ApiError, type SessionUser } from "../api";
import type { DeploymentMode } from "../api-types";
import { errorText } from "../errors";
import { Icon } from "../icons";
import { useRouter } from "../router";
import type { Session } from "../session";
import { useToast } from "../toast";
import { ErrorNote, Modal, Spinner } from "../ui";

type SignedIn = (session: Session) => void;

/** The Try Acquit page. The dev deployment adds the seeded picker under it. */
export function SignIn({ mode, onSignedIn }: { mode: DeploymentMode; onSignedIn: SignedIn }) {
  return (
    <div className="start">
      <StartCard onSignedIn={onSignedIn} staff={mode === "public"} />
      {mode === "dev" && <SeededPicker onSignedIn={onSignedIn} />}
    </div>
  );
}

export type TryState = "ready" | "busy" | "error" | "limit" | "private";

/** Makes an account in one call and lands on My jobs as its client, with the welcome toast. */
export function useTryAcquit(onSignedIn: SignedIn) {
  const [state, setState] = useState<TryState>("ready");
  const [error, setError] = useState<unknown>(null);
  const { navigate } = useRouter();
  const toast = useToast();
  const start = async () => {
    setState("busy");
    setError(null);
    try {
      const made = await api.createAccount();
      navigate("/");
      onSignedIn({ user: made.user, account: made.account });
      toast(START_COPY.made);
    } catch (e) {
      setError(e);
      setState(startFailure(e));
    }
  };
  return { state, setState, error, start };
}

/** The failure above the button, then the green button itself, which reads its busy label while the account is made. */
export function TryAcquit({ state, error, onStart }: { state: TryState; error: unknown; onStart: () => void }) {
  const busy = state === "busy";
  return (
    <>
      {state === "error" && <ErrorNote error={error} message={START_COPY.failed} />}
      {state === "limit" && <ErrorNote error={error} />}
      <button type="button" className="btn green start-action" disabled={busy || state === "limit"} onClick={onStart}>
        {busy && <Spinner />}
        {busy ? START_COPY.busy : START_COPY.action}
      </button>
    </>
  );
}

function StartCard({ onSignedIn, staff }: { onSignedIn: SignedIn; staff: boolean }) {
  const tryAcquit = useTryAcquit(onSignedIn);
  const { setState } = tryAcquit;
  const [staffOpen, setStaffOpen] = useState(false);
  useEffect(() => {
    // A failed check keeps the button. The server still refuses a closed deployment, and that refusal closes it.
    let live = true;
    api
      .demoAccess()
      .then((r) => {
        if (live && !r.open) setState("private");
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [setState]);

  return (
    <section className="card pad start-card" aria-label="Try Acquit">
      {tryAcquit.state === "private" ? (
        <>
          <h2>{PRIVATE_COPY.heading}</h2>
          <p className="start-lead">{PRIVATE_COPY.line}</p>
        </>
      ) : (
        <>
          <p className="start-lead">{START_COPY.lead}</p>
          <ul className="start-points">
            {START_COPY.points.map((point) => (
              <li key={point}>
                <Icon name="check" size={16} />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <TryAcquit state={tryAcquit.state} error={tryAcquit.error} onStart={() => void tryAcquit.start()} />
          <p className="muted start-note">{START_COPY.saved}</p>
        </>
      )}
      {staff && (
        <button type="button" className="start-staff" onClick={() => setStaffOpen(true)}>
          {START_COPY.staff}
        </button>
      )}
      {staffOpen && (
        <Modal title={START_COPY.staff} onClose={() => setStaffOpen(false)}>
          <PlatformKey onSignedIn={onSignedIn} />
        </Modal>
      )}
    </section>
  );
}

function SeededPicker({ onSignedIn }: { onSignedIn: SignedIn }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { navigate } = useRouter();
  const [users, setUsers] = useState<SessionUser[] | null>(null);
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
  const platform = () =>
    run("platform", async () => {
      const session = await api.signIn("platform");
      navigate("/studio");
      return session;
    });

  useEffect(() => {
    api
      .users()
      .then((r) => setUsers(r.users))
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  return (
    <section className="card pad start-card">
      <div className="eyebrow">Dev sign-in</div>
      <h2>Sign in as a seeded user</h2>
      <p className="muted">The skeleton has no passwords. Pick a user; payments run against the PayPal sandbox.</p>
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
      <button className="btn ghost sm signin-quiet" disabled={busy !== null} onClick={() => void platform()}>
        {busy === "platform" ? "Signing in…" : "Platform dashboards"}
      </button>
    </section>
  );
}

function PlatformKey({ onSignedIn }: { onSignedIn: SignedIn }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { navigate } = useRouter();
  const id = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.platformSession(key);
      navigate("/studio");
      onSignedIn({ user: r.user, account: null });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? "Wrong platform key" : errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form platform-key" onSubmit={(e) => void submit(e)}>
      <label htmlFor={`${id}-key`}>
        <span>Platform key</span>
        <input id={`${id}-key`} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} required />
      </label>
      <div className="act">
        {error && <span className="alert">{error}</span>}
        <button className="btn sm" disabled={busy || key === ""}>
          {busy ? "Checking…" : "Open the platform dashboards"}
        </button>
      </div>
    </form>
  );
}
