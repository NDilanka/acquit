import { useEffect, useState } from "react";
import { cardName, markLinkSaved, restoreFailure, roleHome, tokenFromHash, WELCOME_BACK_COPY, welcomeBackToast } from "../account";
import { api } from "../api";
import type { AccountSessionResponse } from "../api-types";
import { Link, useRouter } from "../router";
import type { Session } from "../session";
import { useToast } from "../toast";
import { ErrorNote, Spinner } from "../ui";
import { TryAcquit, useTryAcquit } from "./SignIn";

// React's development double mount runs the restore effect twice, and the token must be sent once.
const restoring = new Map<string, Promise<AccountSessionResponse>>();

function restoreOnce(token: string): Promise<AccountSessionResponse> {
  const known = restoring.get(token);
  if (known) return known;
  const sent = api.restoreAccount(token);
  restoring.set(token, sent);
  const clear = () => restoring.delete(token);
  sent.then(clear, clear);
  return sent;
}

type State = "confirm" | "reading" | "gone" | "error";

/** Opens an account from its saved link: the token is read from the fragment, sent once, and wiped from the address bar. */
export function WelcomeBack({ session, onSignedIn }: { session: Session | null; onSignedIn: (session: Session) => void }) {
  const [token] = useState(() => tokenFromHash(window.location.hash));
  const [state, setState] = useState<State>(token === null ? "gone" : session ? "confirm" : "reading");
  const [error, setError] = useState<unknown>(null);
  const { navigate } = useRouter();
  const toast = useToast();
  const tryAcquit = useTryAcquit(onSignedIn);

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  useEffect(() => {
    if (state !== "reading" || token === null) return;
    let live = true;
    restoreOnce(token).then(
      (r) => {
        if (!live) return;
        // Whoever opened the link holds it, so this browser counts it as saved.
        markLinkSaved(localStorage, r.account.client, true);
        navigate(roleHome(r.user.role), true);
        onSignedIn({ user: r.user, account: r.account });
        toast(welcomeBackToast(r.account));
      },
      (e: unknown) => {
        if (!live) return;
        setError(e);
        setState(restoreFailure(e));
      },
    );
    return () => {
      live = false;
    };
    // navigate, onSignedIn, and toast are new on every render; only a change of state may send the token again.
  }, [state, token]);

  const home = session ? roleHome(session.user.role) : "/";
  return (
    <div className="start">
      <section className="card pad start-card" aria-label="Welcome back">
        {state === "reading" && (
          <p className="start-status" role="status">
            <Spinner />
            {WELCOME_BACK_COPY.reading}
          </p>
        )}
        {state === "confirm" && session && (
          <>
            <p className="start-lead">You are signed in as {cardName(session.user, session.account)}. Open the saved account instead?</p>
            <div className="start-row">
              <button type="button" className="btn secondary" onClick={() => navigate(home, true)}>
                Stay here
              </button>
              <button type="button" className="btn green" onClick={() => setState("reading")}>
                Open saved account
              </button>
            </div>
          </>
        )}
        {state === "gone" && (
          <>
            <p className="start-lead">{WELCOME_BACK_COPY.gone}</p>
            {!session && <TryAcquit state={tryAcquit.state} error={tryAcquit.error} onStart={() => void tryAcquit.start()} />}
            <Link to={home} className="btn secondary start-home">
              {WELCOME_BACK_COPY.home}
            </Link>
          </>
        )}
        {state === "error" && (
          <>
            <ErrorNote error={error} />
            <button type="button" className="btn secondary" onClick={() => setState("reading")}>
              Try again
            </button>
          </>
        )}
      </section>
    </div>
  );
}
