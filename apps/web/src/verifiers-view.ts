// The verifier registry page's rows and wording. The page reads only this module. The code and print cards
// are the constants CI asserts against the real judges, so no score on the page is typed here.

import { CODE_MANIFEST } from "../../../packages/core/src/code-manifest.ts";
import { PUBLISHED_SCORE_CARD, type ScoreCard } from "../../../packages/core/src/score-card-data.ts";
import { PUBLISHED_PRINT_SCORE_CARD } from "../../../packages/verifier-print/src/score-card.ts";

export type VerifierStatus = "Live" | "Judge built, not open for jobs" | "Next";

/** The nouns a card's sentence uses. The print card says frauds and prints, as its CI log line does. */
export type ScoreWords = { readonly cheats: string; readonly honest: string };

export type VerifierRow = {
  readonly vertical: string;
  readonly title: string;
  readonly status: VerifierStatus;
  readonly version: string | null;
  readonly milestones: readonly { readonly title: string; readonly releaseBps: number }[];
  readonly scoreCard: ScoreCard | null;
  readonly scoreWords: ScoreWords | null;
  readonly scoreNote: string | null;
  readonly simulatedNote: string | null;
  readonly hiddenCheck: string | null;
};

export const PAGE_INTRO = "Acquit judges each kind of work with its own verifier. Each score card below comes from a CI test run. The test runs the real judge on a fixed set of known cheats and honest work, and the build fails when the result changes. A verifier marked Next has no score card yet.";

/** One sentence per milestone: the share of the job's price that the milestone releases. */
export function milestoneLine(milestone: { readonly title: string; readonly releaseBps: number }): string {
  return `${milestone.title} releases ${milestone.releaseBps / 100}% of the price.`;
}

/** The card in two sentences, then its known gaps. The same wording as the receipt's card, with the row's nouns. */
export function scoreLines(card: ScoreCard, words: ScoreWords): readonly string[] {
  return [
    `Caught ${card.cheatsCaught} of ${card.cheatsTotal} ${words.cheats}. Passed ${card.honestPassed} of ${card.honestTotal} ${words.honest}.`,
    card.gaps.length === 0 ? "No known gaps." : `Known gaps: ${card.gaps.join(", ")}.`,
  ];
}

function nextRow(vertical: string, title: string, hiddenCheck: string): VerifierRow {
  return { vertical, title, status: "Next", version: null, milestones: [], scoreCard: null, scoreWords: null, scoreNote: null, simulatedNote: null, hiddenCheck };
}

/** Every way Acquit judges work, in display order. */
export const VERIFIER_ROWS: readonly VerifierRow[] = [
  {
    vertical: CODE_MANIFEST.vertical,
    title: CODE_MANIFEST.title,
    status: "Live",
    version: CODE_MANIFEST.version,
    milestones: CODE_MANIFEST.milestones,
    scoreCard: PUBLISHED_SCORE_CARD,
    scoreWords: { cheats: "known cheats", honest: "honest submissions" },
    scoreNote: "The CI test runs the real code judge on every case. The build fails if the result differs from this card.",
    simulatedNote: null,
    hiddenCheck: null,
  },
  {
    vertical: "print-fdm",
    title: "3D printing (FDM)",
    status: "Judge built, not open for jobs",
    version: null,
    milestones: [],
    scoreCard: PUBLISHED_PRINT_SCORE_CARD,
    scoreWords: { cheats: "known frauds", honest: "honest prints" },
    scoreNote: "The print CI job slices each case with the real PrusaSlicer. The build fails if the result differs from this card. replay-same-file is the known gap. An earlier print of the same file can hand over its frames and photos, and the verifier matches only the file hash, so the replay passes.",
    simulatedNote: "Telemetry and photos are Simulated. Software proves the G-code and the evidence, not the atoms.",
    hiddenCheck: null,
  },
  nextRow("rendering", "Rendering", "A hidden frame is re-rendered and compared with the seller's frame."),
  nextRow("video-captions", "Video captions", "Caption-sync probes run at hidden timestamps."),
  nextRow("translation", "Translation", "Back-translation probes run on hidden sentences."),
  nextRow("data-labeling", "Data labeling", "Hidden gold items are mixed into the batch."),
];
