import { SAMPLE_TEXT, validateSpec, verify } from "../../../../packages/verifier-laser/src/index.ts";
import type { HiddenSample, Spec } from "../../../../packages/verifier-laser/src/index.ts";
import type { Delivery } from "./contract.ts";

// Each delivery is named by what the file does, in plain words. The rule it breaks is not written here: the checker
// finds it, and the test reads it back from the checker.
const LASER_FILES: readonly { readonly file: string; readonly title: string; readonly blurb: string }[] = [
  { file: "honest.svg", title: "Honest delivery", blurb: "The panel drawn as the job asks: kerf allowed for, holes in place, label inside its box." },
  {
    file: "fraud-hidden-notch.svg",
    title: "Passes every public rule, fails a hidden one",
    blurb: "The window is the right size and clear of every edge, but it sits where the buyer needs solid material. Only a sealed check knows where that is.",
  },
  { file: "fraud-no-kerf.svg", title: "Skipped kerf compensation", blurb: "The outline is drawn at the finished size, so the beam's width eats into the part." },
  { file: "fraud-hole-moved.svg", title: "Mounting hole moved 1 mm", blurb: "One of the four mounting holes is drawn 1 mm off its position." },
  { file: "fraud-open-path.svg", title: "A cut that never closes", blurb: "A stray open line in cut red: the laser would slice a slit into the panel instead of cutting a shape out." },
  { file: "fraud-pixel-units.svg", title: "Drawn in pixels, not millimetres", blurb: "The drawing gives its size in pixels, so a machine could scale it wrong." },
  { file: "fraud-duplicate-cut.svg", title: "Window cut twice", blurb: "The window is drawn twice on top of itself, so the beam burns the same edge two times." },
  { file: "fraud-oversize-bed.svg", title: "Runs off the laser bed", blurb: "The panel is placed so part of it hangs past the edge of the sheet." },
  { file: "fraud-order.svg", title: "Outline cut first", blurb: "The outer cut comes first, so the part could drop or shift before its holes are cut." },
  { file: "fraud-thin-web.svg", title: "Wall too thin to hold", blurb: "The window is moved so close to the edge that the strip of material between them is too thin to be strong." },
  { file: "fraud-wrong-colour.svg", title: "A line with no laser colour", blurb: "A green guide line is left in the file. The laser has no instruction for it." },
  { file: "fraud-chamfered-corner.svg", title: "Corner cut off", blurb: "One corner has a small step cut out of it where the job asks for a square corner." },
  { file: "fraud-zero-label.svg", title: "A label with no length", blurb: "The engraved label is a single point, a token mark that engraves nothing." },
];

let job: { spec: Spec; hidden: HiddenSample } | null = null;

function laserJob(): { spec: Spec; hidden: HiddenSample } {
  if (job) return job;
  const checked = validateSpec(JSON.parse(SAMPLE_TEXT["enclosure-panel.spec.json"] ?? "null"));
  if (!checked.ok) throw new Error(`the sample spec is invalid: ${checked.errors.map((e) => e.message).join("; ")}`);
  job = { spec: checked.value, hidden: JSON.parse(SAMPLE_TEXT["enclosure-panel.hidden.json"] ?? "null") as HiddenSample };
  return job;
}

export const LASER_DELIVERIES: readonly Delivery[] = LASER_FILES.map(({ file, title, blurb }) => {
  const text = SAMPLE_TEXT[file] ?? "";
  return {
    id: file.replace(/\.svg$/, ""),
    title,
    blurb,
    cheat: file !== "honest.svg",
    fileName: file,
    text,
    run: () => {
      const { spec, hidden } = laserJob();
      return verify(spec, text, hidden);
    },
  };
});

/** The job the laser deliveries answer, in words: shown above the picker so a visitor knows what was asked. */
export function laserJobSummary(): string {
  const { spec } = laserJob();
  return `A ${spec.partMm[0]} x ${spec.partMm[1]} mm ${spec.material} panel, ${spec.thicknessMm} mm thick, with ${spec.holes.length} mounting holes, ${spec.slots.length === 1 ? "a window" : `${spec.slots.length} windows`} and an engraved label.`;
}

/** Every SVG sample the laser checker ships, so a test can prove the picker misses none. */
export const LASER_SAMPLE_FILES: readonly string[] = Object.keys(SAMPLE_TEXT).filter((name) => name.endsWith(".svg"));
