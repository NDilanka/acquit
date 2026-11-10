import { lazy, Suspense, useEffect, useState } from "react";
import { roleHome } from "./account";
import { api } from "./api";
import type { DeploymentMode, FundingMode } from "./api-types";
import { errorText } from "./errors";
import { pageHeading } from "./nav";
import { useRouter } from "./router";
import { isOwnerRoute, match, signedOutPage } from "./route";
import { Shell } from "./shell";
import { SessionContext, useSession, type Session } from "./session";
import { NotFound, SkeletonCard } from "./ui";
import { SignIn } from "./pages/SignIn";
import { WelcomeBack } from "./pages/WelcomeBack";
import { ClientDashboard } from "./pages/ClientDashboard";
import { NewJob } from "./pages/NewJob";
import { JobPage } from "./pages/JobPage";
import { PublicReceiptPage } from "./pages/PublicReceipt";
import { HowWorkIsCheckedPage } from "./pages/HowWorkIsChecked";
import { EarningsPage, FindWorkPage, MyBidsPage, MyWorkPage } from "./pages/operator/OperatorRoutes";
import { CliLogin } from "./pages/CliLogin";
import { JudgeScenarios } from "./pages/JudgeScenarios";
import { PlugInPage } from "./pages/specialists/PlugIn";
import { ExamPage } from "./pages/specialists/Exam";
import { StandingOrdersPage } from "./pages/specialists/StandingOrders";
import { ActivityPage } from "./pages/specialists/Activity";
import { AgentEarningsPage } from "./pages/specialists/AgentEarnings";
import { LeaderboardPage } from "./pages/specialists/Leaderboard";
import { AgentRecordPage } from "./pages/specialists/AgentRecord";
import { OwnerPageSkeleton } from "./pages/specialists/OwnerLoading";

// AG Studio is one multi-megabyte entry, so it loads only when a dashboard route renders.
const StudioPage = lazy(() => import("./studio/StudioPage"));
// The inspector carries the laser checker and, behind it, three.js; neither loads until /inspect renders.
const InspectPage = lazy(() => import("./inspect/InspectPage"));

function Studio({ sample = false }: { sample?: boolean }) {
  return (
    <Suspense fallback={<SkeletonCard lines={4} />}>
      <StudioPage sample={sample} />
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
  if (route.name === "receipt" || route.name === "verifiers" || route.name === "print" || route.name === "inspect" || route.name === "howWorkIsChecked" || route.name === "specialistLeaderboard" || route.name === "agentRecord") {
    return (
      <Shell session={session} heading={heading} onSignOut={signOut} onSession={signedIn}>
        <main id="content" tabIndex={-1} className="wrap">
          {route.name === "agentRecord" ? <AgentRecordPage key={route.agentId} agentId={route.agentId} /> : route.name === "specialistLeaderboard" ? <LeaderboardPage /> : route.name === "receipt" ? (
            <PublicReceiptPage receiptId={route.id} signedIn={Boolean(session)} />
          ) : route.name === "inspect" ? (
            <Suspense fallback={<SkeletonCard lines={4} />}>
              <InspectPage />
            </Suspense>
          ) : (
            <HowWorkIsCheckedPage session={session} onSignedIn={signedIn} />
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
      <main id="content" tabIndex={-1} className={session && (route.name === "studio" || route.name === "studioSample") ? "wrap wrap-full" : "wrap"}>
        {session === undefined ? (
          isOwnerRoute(location.path) ? <OwnerPageSkeleton path={location.path} /> : <SkeletonCard />
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
    case "tour":
      return <JudgeScenarios />;
    case "studio":
      return <Studio />;
    case "studioSample":
      return <Studio sample />;
    case "specialists":
      return <PlugInPage />;
    case "specialistExam":
      return <ExamPage agentId={route.agentId} />;
    case "specialistOrders":
      return <StandingOrdersPage agentId={route.agentId} />;
    case "specialistActivity":
      return <ActivityPage agentId={route.agentId} />;
    case "specialistEarnings":
      return <AgentEarningsPage />;
    case "specialistLeaderboard":
      return <LeaderboardPage />;
    case "agentRecord":
      return <AgentRecordPage key={route.agentId} agentId={route.agentId} />;
    case "howWorkIsChecked":
      return null;
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
