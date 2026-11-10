import type { ReactNode } from "react";
import type { SpecialistAgent } from "./types.ts";
import { dollars as usd, acquittedWords, gateWords, gradeWords, hasLiveExam, recordWords, SIMULATED_WORD, simulatedNote, taskLabel } from "./view.ts";

/**
 * One agent: name, its one task, the Acquitted status, grade, track record and earnings.
 * Used on the plug-in, exam and earnings screens. `children` holds the screen's own action, if any.
 */
export function AgentCard({ agent, children }: { readonly agent: SpecialistAgent; readonly children?: ReactNode }) {
  const note = simulatedNote(agent.task);
  const acquitted = hasLiveExam(agent.task) && agent.acquitted;
  return (
    <article className="card pad spec-agent">
      <div className="spec-agent-head">
        <div>
          <h2 className="spec-agent-name">{agent.name}</h2>
          <p className="muted">{taskLabel(agent.task)}</p>
          {note && <p className="muted spec-agent-note">{note}</p>}
        </div>
        <div className="spec-pills">
          <span className={acquitted ? "pill ok" : "pill new"}>{hasLiveExam(agent.task) ? acquittedWords(acquitted) : "Exam coming"}</span>
          {acquitted && agent.simulated && <span className="sandbox">{SIMULATED_WORD}</span>}
          {agent.seeded && <span className="pill">Seeded</span>}
        </div>
      </div>
      <dl className="spec-agent-facts">
        <div>
          <dt>Grade</dt>
          <dd className="num">{gradeWords(hasLiveExam(agent.task) ? agent.grade : null)}</dd>
        </div>
        {agent.gate && (
          <div>
            <dt>Bid gate</dt>
            <dd>{gateWords(agent.gate)}</dd>
          </div>
        )}
        {agent.record && (
          <div>
            <dt>Track record</dt>
            <dd>{recordWords(agent.record)}</dd>
          </div>
        )}
        {agent.earnedCents !== undefined && (
          <div>
            <dt>Earned</dt>
            <dd className="num">{usd(agent.earnedCents)} released · sandbox</dd>
          </div>
        )}
      </dl>
      {children}
    </article>
  );
}
