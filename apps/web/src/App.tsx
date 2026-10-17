import { lazy, Suspense, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { DeploymentMode, FundingMode, VisitorView } from "./api-types";
import { demoEnds, errorText } from "./demo";
import { Link, match, useRouter } from "./router";
import { SessionContext, useSession, type Session } from "./session";
import { NotFound, RepoLink } from "./ui";
import { SignIn } from "./pages/SignIn";
import { ClientDashboard } from "./pages/ClientDashboard";
import { NewJob } from "./pages/NewJob";
import { JobPage } from "./pages/JobPage";
import { PublicReceiptPage } from "./pages/PublicReceipt";
import { OperatorHome } from "./pages/OperatorHome";
import { CliLogin } from "./pages/CliLogin";

// AG Studio is one multi-megabyte entry, so it loads only when a dashboard route renders.
const StudioPage = lazy(() => import("./studio/StudioPage"));

function Studio() {
  return (
    <Suspense fallback={<p className="muted">Loading the dashboards…</p>}>
      <StudioPage />
    </Suspense>
  );
}

const ROLE_CAPTION = { CLIENT: "client", OPERATOR: "operator", PLATFORM: "platform" } as const;

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [mode, setMode] = useState<DeploymentMode | null>(null);
  const [fundingMode, setFundingMode] = useState<FundingMode>("checkout");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .session()
      .then((r) => {
        setMode(r.mode);
        setFundingMode(r.fundingMode);
        setSession(r.user ? { user: r.user, visitor: r.visitor } : null);
      })
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? e.message : `Cannot reach the API: ${String(e)}`);
        setSession(null);
      });
  }, []);

  const { navigate, location } = useRouter();
  const signOut = () => {
    // A demo has no way back in: Start my demo makes a new visitor, which counts against the day's caps.
    if (session?.visitor && !window.confirm("Leave this demo? You cannot return to it. Start my demo makes a new one.")) return;
    void api.signOut().finally(() => {
      setSession(null);
      navigate("/");
    });
  };

  // A seller's receipt link is public: it renders with or without a session, so it never waits behind the sign-in picker.
  const publicRoute = match(location.path);
  if (publicRoute.name === "receipt") {
    return (
      <>
        <TopBar session={session ?? null} onSignOut={signOut} />
        <main className="wrap">
          <PublicReceiptPage receiptId={publicRoute.id} />
        </main>
      </>
    );
  }

  if (session === undefined) return <div className="wrap muted">Loading…</div>;

  return (
    <>
      <TopBar session={session} onSignOut={signOut} />
      {session?.visitor && <DemoBar session={session} visitor={session.visitor} onSwitched={setSession} />}
      <main className="wrap">
        {error && !session && <div className="alert">{error}</div>}
        {session ? (
          <SessionContext.Provider value={{ ...session, signOut, fundingMode }}>
            {/* Keyed on the handle so a client/operator switch remounts the page and reloads it as the new principal. */}
            <Routes key={session.user.handle} />
          </SessionContext.Provider>
        ) : (
          mode && (match(location.path).name === "notFound"
            ? <NotFound action={{ to: "/", label: "Sign in" }} />
            : <SignIn mode={mode} onSignedIn={(s) => { setError(null); setSession(s); }} />)
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
          Repository <RepoLink repository={visitor.repository} />
        </span>
        <span className="muted" title={visitor.expiresAt}>{demoEnds(visitor.expiresAt, Date.now())}</span>
        {error && <span className="alert">{error}</span>}
      </div>
    </div>
  );
}

function Routes() {
  const { location } = useRouter();
  const { user } = useSession();
  const route = match(location.path);
  switch (route.name) {
    case "home":
      return <Home />;
    case "newJob":
      return user.role === "CLIENT" ? (
        <NewJob />
      ) : (
        <NotFound title="Clients post jobs" message={`You are signed in as ${user.handle} (${user.role.toLowerCase()}). Operators bid on open jobs.`} action={{ to: "/", label: "Back to the dashboard" }} />
      );
    case "job":
      return <JobPage key={route.id} id={route.id} />;
    case "operator":
      return <OperatorHome />;
    case "cli":
      return <CliLogin />;
    case "studio":
      return <Studio />;
    case "notFound":
      return <NotFound action={{ to: "/", label: "Back to the dashboard" }} />;
  }
}

function Home() {
  const { user } = useSession();
  switch (user.role) {
    case "OPERATOR":
      return <OperatorHome />;
    case "PLATFORM":
      return <Studio />;
    case "CLIENT":
      return <ClientDashboard />;
  }
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
          <Link to="/studio" className={on("/studio")}>Dashboards</Link>
        </nav>
      )}
      {user?.role === "PLATFORM" && (
        <nav className="nav">
          <Link to="/studio" className={on("/studio") || on("/")}>Dashboards</Link>
        </nav>
      )}
      <span className="sp" />
      <span className="sandbox" title="PayPal sandbox. No real money moves.">Sandbox</span>
      {user && (
        <>
          <span className="avatar">
            <i>{user.handle.slice(0, 2).toUpperCase()}</i>
            {user.handle}
            <small className="muted">{ROLE_CAPTION[user.role]}</small>
          </span>
          <button className="btn ghost sm" onClick={onSignOut}>{session?.visitor ? "Leave demo" : "Sign out"}</button>
        </>
      )}
    </header>
  );
}
