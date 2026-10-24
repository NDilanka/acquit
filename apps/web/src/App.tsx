import { lazy, Suspense, useEffect, useState } from "react";
import { roleHome } from "./account";
import { api } from "./api";
import type { DeploymentMode, FundingMode } from "./api-types";
import { errorText } from "./errors";
import { pageHeading } from "./nav";
import { useRouter } from "./router";
import { match, signedOutPage } from "./route";
import { Shell } from "./shell";
import { SessionContext, useSession, type Session } from "./session";
import { NotFound, SkeletonCard } from "./ui";
import { SignIn } from "./pages/SignIn";
import { WelcomeBack } from "./pages/WelcomeBack";
import { ClientDashboard } from "./pages/ClientDashboard";
import { NewJob } from "./pages/NewJob";
import { JobPage } from "./pages/JobPage";
import { PublicReceiptPage } from "./pages/PublicReceipt";
import { VerifiersPage } from "./pages/Verifiers";
import { PrintDemoPage } from "./pages/PrintDemo";
import { EarningsPage, FindWorkPage, MyBidsPage, MyWorkPage } from "./pages/operator/OperatorRoutes";
import { CliLogin } from "./pages/CliLogin";

// AG Studio is one multi-megabyte entry, so it loads only when a dashboard route renders.
const StudioPage = lazy(() => import("./studio/StudioPage"));

function Studio() {
  return (
    <Suspense fallback={<SkeletonCard lines={4} />}>
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
        setSession(r.user ? { user: r.user, account: r.account } : null);
      })
      .catch((e: unknown) => {
        setError(errorText(e));
        setSession(null);
      });
  }, []);

  const { navigate, location } = useRouter();
  // The account menu asks before this runs; a seeded or platform session signs out at once.
  const signOut = () => {
    void api.signOut().finally(() => {
      setSession(null);
      navigate("/");
    });
  };
  const signedIn = (s: Session) => {
    setError(null);
    setSession(s);
  };

  // A seller's receipt link is public: it renders with or without a session, so it never waits behind the sign-in picker.
  // The verifier registry and the print verifier are public for the same reason. A print run makes its own account.
  const route = match(location.path);
  const heading = pageHeading(route, session?.user.role ?? null);
  if (route.name === "receipt" || route.name === "verifiers" || route.name === "print") {
    return (
      <Shell session={session} heading={heading} onSignOut={signOut} onSession={signedIn}>
        <main id="content" tabIndex={-1} className="wrap">
          {route.name === "receipt" ? (
            <PublicReceiptPage receiptId={route.id} signedIn={Boolean(session)} />
          ) : route.name === "verifiers" ? (
            <VerifiersPage />
          ) : (
            <PrintDemoPage session={session} onSignedIn={signedIn} />
          )}
        </main>
      </Shell>
    );
  }

  const signedOutView = signedOutPage(route);
  // The landing is its own entry with its own CSS, so it renders without the shell.
  if (session === null && signedOutView === "landing") return <LandingReload />;

  return (
    <Shell session={session} heading={heading} onSignOut={signOut} onSession={signedIn}>
      {/* The dashboards take the viewport's full width; every other route keeps the reading column. */}
      <main id="content" tabIndex={-1} className={session && route.name === "studio" ? "wrap wrap-full" : "wrap"}>
        {session === undefined ? (
          <SkeletonCard />
        ) : route.name === "welcomeBack" ? (
          <WelcomeBack session={session} onSignedIn={signedIn} />
        ) : session ? (
          <SessionContext.Provider value={{ ...session, signOut, fundingMode }}>
            {/* Keyed on the handle so a client/operator switch remounts the page and reloads it as the new principal. */}
            <Routes key={session.user.handle} />
          </SessionContext.Provider>
        ) : (
          <>
            {error && <div className="alert">{error}</div>}
            {signedOutView === "notFound" ? (
              <NotFound signedIn={false} />
            ) : signedOutView === "toStart" ? (
              <Redirect to="/start" />
            ) : (
              mode && <SignIn mode={mode} onSignedIn={signedIn} />
            )}
          </>
        )}
      </main>
    </Shell>
  );
}

// The landing is its own entry with its own CSS, so a signed-out "/" reloads the page to get it.
function LandingReload() {
  useEffect(() => window.location.assign("/"), []);
  return null;
}

/** Replaces the address, so Back does not return to a page that only moves on. */
function Redirect({ to }: { to: string }) {
  const { navigate } = useRouter();
  useEffect(() => navigate(to, true), [to]);
  return null;
}

function Routes() {
  const { location } = useRouter();
  const { user } = useSession();
  const route = match(location.path);
  switch (route.name) {
    case "home":
      return <Home />;
    case "demo":
    case "start":
      return <Redirect to={roleHome(user.role)} />;
    case "newJob":
      return user.role === "CLIENT" ? (
        <NewJob />
      ) : (
        <NotFound signedIn title="Clients post jobs" message={`Only clients can post jobs, and you are signed in as ${user.handle} (${user.role.toLowerCase()}).`} />
      );
    case "job":
      return <JobPage key={route.id} id={route.id} />;
    case "operator":
      return <FindWorkPage />;
    case "operatorBids":
      return <MyBidsPage />;
    case "operatorWork":
      return <MyWorkPage />;
    case "operatorEarnings":
      return <EarningsPage />;
    case "cli":
      return <CliLogin />;
    case "studio":
      return <Studio />;
    case "welcomeBack":
    case "notFound":
      return <NotFound signedIn />;
  }
}

function Home() {
  const { user } = useSession();
  switch (user.role) {
    case "OPERATOR":
      return <FindWorkPage />;
    case "PLATFORM":
      return <Studio />;
    case "CLIENT":
      return <ClientDashboard />;
  }
}
