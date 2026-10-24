import { useState } from "react";
import { api, ApiError } from "../api";
import { approveFailure, codeHint, type Copy, type Failure, isCodeFormat, NOT_VALID, signInPrompt } from "../cli";
import { errorText } from "../demo";
import { useRouter } from "../router";
import { useSession } from "../session";

type State = { kind: "ready" } | { kind: "busy" } | { kind: "done" } | { kind: "dead"; failure: Failure };

/** The terminal's sign-in link. One centred card, one state at a time, and the title stays in the top bar. */
export function CliLogin() {
  const { user } = useSession();
  const { location } = useRouter();
  const code = location.search.get("code") ?? "";
  const [state, setState] = useState<State>({ kind: "ready" });
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    setState({ kind: "busy" });
    setError(null);
    try {
      await api.approveCli(code);
      setState({ kind: "done" });
    } catch (e) {
      const failure = e instanceof ApiError ? approveFailure(e.status, e.code) : null;
      if (failure) {
        setState({ kind: "dead", failure });
        return;
      }
      setError(errorText(e));
      setState({ kind: "ready" });
    }
  };

  const refusal = code !== "" && !isCodeFormat(code) ? NOT_VALID : state.kind === "dead" ? state.failure : null;

  return (
    <div className="cli-page">
      <section className="card pad cli-card">
        {!code ? (
          <>
            <h2>No sign-in code</h2>
            <p className="muted">
              This link has no sign-in code. Run <span className="mono">acquit login</span> again.
            </p>
          </>
        ) : refusal ? (
          <>
            <h2>{refusal.title}</h2>
            <p className="muted">
              <CopyLine copy={refusal.body} />
            </p>
          </>
        ) : state.kind === "done" ? (
          <>
            <h2>The CLI is signed in</h2>
            <p>You can go back to your terminal.</p>
          </>
        ) : (
          <>
            <h2>{signInPrompt(user)}</h2>
            <p className="muted">
              Approve only if you just ran <span className="mono">acquit login</span>. Check that the link your terminal
              printed has the same code: <span className="mono">{codeHint(code)}</span>
            </p>
            {error && (
              <div className="alert" role="alert">
                <p className="alert-msg">{error}</p>
              </div>
            )}
            <button type="button" className="btn green cli-approve" disabled={state.kind === "busy"} onClick={() => void approve()}>
              {state.kind === "busy" ? "Approving…" : "Approve"}
            </button>
          </>
        )}
      </section>
    </div>
  );
}

/** Renders CLI copy, drawing each code part as inline code. */
function CopyLine({ copy }: { copy: Copy }) {
  return (
    <>
      {copy.map((part, i) =>
        typeof part === "string" ? part : <span key={i} className="mono">{part.code}</span>,
      )}
    </>
  );
}
