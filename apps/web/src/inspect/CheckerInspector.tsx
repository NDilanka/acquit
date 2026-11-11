import { Inspector } from "./Inspector.tsx";
import { checkerFor, DEFAULT_WORKFLOW } from "./registry.ts";

export type CheckerInspectorProps = {
  /** Which checker to show, by its Verdict workflow. Laser cutting when absent. */
  readonly workflow?: string;
  /** The id of the delivery to open on, for example "fraud-hidden-notch". */
  readonly delivery?: string;
  /** Draw the flat view even where WebGL works. */
  readonly flat?: boolean;
};

/**
 * The "try to cheat the checker" inspector, with no dependency on the page around it: no router, session or shell.
 * It renders inside any container, using only the design tokens and the shared button and card classes.
 */
export function CheckerInspector({ workflow = DEFAULT_WORKFLOW, delivery, flat }: CheckerInspectorProps) {
  const checker = checkerFor(workflow);
  if (!checker) return <p className="muted">There is no inspector for the {workflow} checker yet.</p>;
  return <Inspector key={checker.workflow} checker={checker} delivery={delivery} flat={flat} />;
}

export default CheckerInspector;
