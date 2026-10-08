import { useEffect, useState } from "react";
import { api, ApiError, type SessionUser } from "./api";
import { Link, match, useRouter } from "./router";
import { SessionContext, useSession } from "./session";
import { SignIn } from "./pages/SignIn";
import { ClientDashboard } from "./pages/ClientDashboard";
import { NewJob } from "./pages/NewJob";
import { JobPage } from "./pages/JobPage";
import { OperatorHome } from "./pages/OperatorHome";
import { CliLogin } from "./pages/CliLogin";

export function App() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .session()
      .then((r) => setUser(r.user))
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? e.message : `Cannot reach the API: ${String(e)}`);
        setUser(null);
      });
  }, []);

  const { navigate } = useRouter();
  const signOut = () => {
    void api.signOut().finally(() => {
      setUser(null);
      navigate("/");
    });
  };

  if (user === undefined) return <div className="wrap muted">Loading…</div>;

  return (
    <>
      <TopBar user={user} onSignOut={signOut} />
      <main className="wrap">
        {error && !user && <div className="alert">{error}</div>}
        {user ? (
          <SessionContext.Provider value={{ user, signOut }}>
            <Routes />
          </SessionContext.Provider>
        ) : (
          <SignIn onSignedIn={(u) => { setError(null); setUser(u); }} />
        )}
      </main>
    </>
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

function TopBar({ user, onSignOut }: { user: SessionUser | null; onSignOut: () => void }) {
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
          <button className="btn ghost sm" onClick={onSignOut}>Sign out</button>
        </>
      )}
    </header>
  );
}
