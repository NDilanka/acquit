import { lazy, Suspense, useEffect, useState } from "react";
import { api } from "./api";
import type { DeploymentMode, FundingMode, VisitorView } from "./api-types";
import { demoEnds, errorText } from "./demo";
import { pageHeading } from "./nav";
import { useRouter } from "./router";
import { match, signedOutPage } from "./route";
import { Shell } from "./shell";
import { SessionContext, useSession, type Session } from "./session";
import { ConfirmDialog, NotFound, RepoLink } from "./ui";
import { SignIn } from "./pages/SignIn";
import { ClientDashboard } from "./pages/ClientDashboard";
import { NewJob } from "./pages/NewJob";
import { JobPage } from "./pages/JobPage";
import { PublicReceiptPage } from "./pages/PublicReceipt";
import { VerifiersPage } from "./pages/Verifiers";
import { PrintDemoPage } from "./pages/PrintDemo";
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
        setError(errorText(e));
        setSession(null);
      });
  }, []);

  const { navigate, location } = useRouter();
  const [leaving, setLeaving] = useState(false);
  const endSession = () => {
    void api.signOut().finally(() => {
      setLeaving(false);
      setSession(null);
      navigate("/");
    });
  };
  // A demo has no way back in, so leaving it asks first; signing out of a seeded session does not.
  const signOut = () => {
    if (session?.visitor) setLeaving(true);
    else endSession();
  };
  const leaveDialog = leaving ? (
    <ConfirmDialog
      title="Leave this demo?"
      body="You cannot return to this demo. Start my demo makes a new one, and it counts against the day's limits."
      confirmLabel="Leave demo"
      danger
      onConfirm={endSession}
      onCancel={() => setLeaving(false)}
    />
  ) : null;

  // A seller's receipt link is public: it renders with or without a session, so it never waits behind the sign-in picker.
  // The verifier registry and the print demo are public for the same reason. A print run starts its own demo.
  const route = match(location.path);
  const heading = pageHeading(route, session?.user.role ?? null);
  if (route.name === "receipt" || route.name === "verifiers" || route.name === "print") {
    return (
      <Shell session={session} heading={heading} onSignOut={signOut}>
        <main className="wrap">
          {route.name === "receipt" ? (
            <PublicReceiptPage receiptId={route.id} signedIn={Boolean(session)} />
          ) : route.name === "verifiers" ? (
            <VerifiersPage />
          ) : (
            <PrintDemoPage session={session} onSignedIn={(s) => { setError(null); setSession(s); }} />
          )}
        </main>
        {leaveDialog}
      </Shell>
    );
  }

  const signedOutView = signedOutPage(route);
  // The landing is its own entry with its own CSS, so it renders without the shell.
  if (session === null && signedOutView === "landing") return <LandingReload />;

  return (
    <Shell session={session} heading={heading} onSignOut={signOut}>
      {session === undefined ? (
        <main className="wrap muted">Loading…</main>
      ) : (
        <>
          {session?.visitor && <DemoBar session={session} visitor={session.visitor} onSwitched={setSession} />}
          {/* The dashboards take the viewport's full width; every other route keeps the reading column. */}
          <main className={session && route.name === "studio" ? "wrap wrap-full" : "wrap"}>
            {error && !session && <div className="alert">{error}</div>}
            {session ? (
              <SessionContext.Provider value={{ ...session, signOut, fundingMode }}>
                {/* Keyed on the handle so a client/operator switch remounts the page and reloads it as the new principal. */}
                <Routes key={session.user.handle} />
              </SessionContext.Provider>
            ) : signedOutView === "notFound" ? (
              <NotFound signedIn={false} />
            ) : (
              mode && <SignIn mode={mode} onSignedIn={(s) => { setError(null); setSession(s); }} />
            )}
          </main>
          {leaveDialog}
        </>
      )}
    </Shell>
  );
}

// The landing is its own entry with its own CSS, so a signed-out "/" reloads the page to get it.
function LandingReload() {
  useEffect(() => window.location.assign("/"), []);
  return null;
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
        <span className="muted demo-extra">
          Repository <RepoLink repository={visitor.repository} />
        </span>
        <span className="muted demo-extra" title={visitor.expiresAt}>{demoEnds(visitor.expiresAt, Date.now())}</span>
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
    case "demo":
      return <Home />;
    case "newJob":
      return user.role === "CLIENT" ? (
        <NewJob />
      ) : (
        <NotFound signedIn title="Clients post jobs" message={`Only clients can post jobs, and you are signed in as ${user.handle} (${user.role.toLowerCase()}).`} />
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
      return <NotFound signedIn />;
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
