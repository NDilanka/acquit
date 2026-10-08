import { useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { VisitorView } from "./api-types";
import { demoEnds, errorText } from "./demo";
import { Link, match, useRouter } from "./router";
import { SessionContext, useSession, type Session } from "./session";
import { SignIn } from "./pages/SignIn";
import { ClientDashboard } from "./pages/ClientDashboard";
import { NewJob } from "./pages/NewJob";
import { JobPage } from "./pages/JobPage";
import { OperatorHome } from "./pages/OperatorHome";
import { CliLogin } from "./pages/CliLogin";

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .session()
      .then((r) => setSession(r.user ? { user: r.user, visitor: r.visitor } : null))
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? e.message : `Cannot reach the API: ${String(e)}`);
        setSession(null);
      });
  }, []);

  const { navigate } = useRouter();
  const signOut = () => {
    // A demo has no way back in: Start my demo makes a new visitor, which counts against the day's caps.
    if (session?.visitor && !window.confirm("Leave this demo? You cannot return to it. Start my demo makes a new one.")) return;
    void api.signOut().finally(() => {
      setSession(null);
      navigate("/");
    });
  };

  if (session === undefined) return <div className="wrap muted">Loading…</div>;

  return (
    <>
      <TopBar session={session} onSignOut={signOut} />
      {session?.visitor && <DemoBar session={session} visitor={session.visitor} onSwitched={setSession} />}
      <main className="wrap">
        {error && !session && <div className="alert">{error}</div>}
        {session ? (
          <SessionContext.Provider value={{ ...session, signOut }}>
            {/* Keyed on the handle so a client/operator switch remounts the page and reloads it as the new principal. */}
            <Routes key={session.user.handle} />
          </SessionContext.Provider>
        ) : (
          <SignIn onSignedIn={(s) => { setError(null); setSession(s); }} />
        )}
      </main>
    </>
  );
}

function DemoBar({ session, visitor, onSwitched }: { session: Session; visitor: VisitorView; onSwitched: (s: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = session.user.role;
  const doSwitch = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.switchDemo();
      onSwitched({ user: r.user, visitor: r.visitor });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const roles = [
    { role: "CLIENT", label: "Act as client", handle: visitor.client },
    { role: "OPERATOR", label: "Act as operator", handle: visitor.operator },
  ] as const;
  return (
    <div className="demobar">
      <div className="wrap">
        <b>Your demo</b>
        <div className="seg" role="group" aria-label="Demo account">
          {roles.map((r) => (
            <button
              key={r.role}
              className={active === r.role ? "on" : ""}
              aria-pressed={active === r.role}
              disabled={busy || active === r.role}
              title={r.handle}
              onClick={() => void doSwitch()}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="muted">
          Signed in as <b className="mono">{session.user.handle}</b>
        </span>
        <span className="muted">
          Repository{" "}
          {visitor.repository ? (
            <a className="mono" href={`https://github.com/${visitor.repository}`} target="_blank" rel="noreferrer">
              {visitor.repository}
            </a>
          ) : (
            "the deployment's shared repository"
          )}
        </span>
        <span className="muted" title={visitor.expiresAt}>{demoEnds(visitor.expiresAt, Date.now())}</span>
        {error && <span className="alert">{error}</span>}
      </div>
    </div>
  );
}

function Routes() {
  const { location } = useRouter();
  const route = match(location.path);
  switch (route.name) {
    case "home":
      return <Home />;
    case "newJob":
      return <NewJob />;
    case "job":
      return <JobPage key={route.id} id={route.id} />;
    case "operator":
      return <OperatorHome />;
    case "cli":
      return <CliLogin />;
    case "notFound":
      return (
        <div className="card pad">
          <h2>Page not found</h2>
          <p className="muted">
            <Link to="/">Back to the dashboard</Link>
          </p>
        </div>
      );
  }
}

function Home() {
  const { user } = useSession();
  return user.role === "OPERATOR" ? <OperatorHome /> : <ClientDashboard />;
}

function TopBar({ session, onSignOut }: { session: Session | null; onSignOut: () => void }) {
  const user = session?.user ?? null;
  const { location } = useRouter();
  const on = (p: string) => (location.path === p ? "on" : "");
  return (
    <header className="top">
      <Link to="/" className="brand">
        <span className="mark">A</span>
        Acquit <em>Cleared, then paid</em>
      </Link>
      {user?.role === "CLIENT" && (
        <nav className="nav">
          <Link to="/" className={on("/")}>Jobs</Link>
          <Link to="/jobs/new" className={on("/jobs/new")}>New job</Link>
        </nav>
      )}
      {user?.role === "OPERATOR" && (
        <nav className="nav">
          <Link to="/operator" className={on("/operator") || on("/")}>Open jobs</Link>
        </nav>
      )}
      <span className="sp" />
      <span className="sandbox" title="PayPal sandbox. No real money moves.">Sandbox</span>
      {user && (
        <>
          <span className="avatar">
            <i>{user.handle.slice(0, 2).toUpperCase()}</i>
            {user.handle}
            <small className="muted">{user.role === "CLIENT" ? "client" : "operator"}</small>
          </span>
          <button className="btn ghost sm" onClick={onSignOut}>{session?.visitor ? "Leave demo" : "Sign out"}</button>
        </>
      )}
    </header>
  );
}
