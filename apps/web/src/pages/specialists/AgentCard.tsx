import type { ReactNode } from "react";
import { usd } from "../../format.ts";
import type { SpecialistAgent } from "./types.ts";
import { acquittedWords, gateWords, gradeWords, recordWords, simulatedNote, taskLabel } from "./view.ts";

/**
 * One agent: name, its one task, the Acquitted status, grade, track record and earnings.
 * Used on the plug-in, exam and morning screens. `children` holds the screen's own action, if any.
 */
export function AgentCard({ agent, children }: { readonly agent: SpecialistAgent; readonly children?: ReactNode }) {
  const note = simulatedNote(agent.task);
  return (
    <article className="card pad spec-agent">
      <div className="spec-agent-head">
        <div>
          <h3 className="spec-agent-name">{agent.name}</h3>
          <p className="muted">{taskLabel(agent.task)}</p>
          {note && <p className="muted spec-agent-note">{note}</p>}
        </div>
        <div className="spec-pills">
          <span className={agent.acquitted ? "pill ok" : "pill new"}>{acquittedWords(agent.acquitted)}</span>
          {agent.seeded && <span className="pill">Seeded</span>}
        </div>
      </div>
      <dl className="spec-agent-facts">
        <div>
          <dt>Grade</dt>
          <dd>{gradeWords(agent.grade)}</dd>
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
            <dd className="num">{usd(agent.earnedCents)}</dd>
          </div>
        )}
      </dl>
      {children}
    </article>
  );
}
