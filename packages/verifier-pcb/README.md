# verifier-pcb

A pure TypeScript checker. It reads a KiCad `.kicad_pcb` file as text, checks it against a job spec, and returns a
verdict: design-rule checks plus a simulated flying-probe test. It does no file or network I/O, needs no KiCad
install, and never throws. A file it cannot model returns a failed `parse` finding.

## Entry points

- `verify(spec, artefact, hidden?)` in `src/verify.ts` returns a `Verdict`. `hidden` is the verifier-only sample.
- `validateSpec`, `validateHidden` (`src/spec.ts`) check the untrusted job and hidden-sample shapes.
- `readBoard`, `parseSexprs` (`src/board.ts`, `src/sexpr.ts`) read the file into the modelled board.
- `runPcbScoreCard` (`src/score-card.ts`) runs the bundled honest board and 11 fraud boards.

Public rule ids: `parse`, `no-zones`, `outline`, `parts-placed`, `inside-board`, `pad-nets`, `connected`,
`no-shorts`, `clearance`, `track-width`, `power-width`, `via-rules`, `pad-rules`, `keepouts`, `mounting-holes`.
Hidden rule ids (`hidden: true`, no location): `hidden-probe`, `hidden-clearance`.

## Modelled subset

Supported:

- one `kicad_pcb` board with one closed Edge.Cuts outline (lines, rectangles, arcs, circles);
- front-side footprints (`(layer "F.Cu")`) with `rect`, `circle`, and `oval` pads of type `smd`, `thru_hole`,
  and `np_thru_hole`;
- F.Cu and B.Cu straight tracks, and through vias that span F.Cu to B.Cu;
- non-plated holes that are round bores exactly the size of their drill, with no copper beyond the bore;
- a 1.6 mm board, from the default (no thickness recorded) or an explicit 1.6 mm stackup (see Stackup).

Refused with a failed `parse` (`unsupported construct` or `malformed record`):

- footprints on the back side (`footprint on layer B.Cu`);
- pads other than `rect`, `circle`, and `oval`, such as `roundrect` (refused, not drawn square) and custom pads;
- vias with any span other than F.Cu to B.Cu: blind, buried, inner, or micro;
- non-plated holes that are not round bores of their drill, such as slots or holes with copper around them;
- thicknesses other than 1.6 mm, and stackups other than the modelled two-copper 1.6 mm board;
- collinear arcs, overlapping Edge.Cuts edges, and inputs over the limits in `src/limits.ts`.

Refused as a failed rule, not a parse failure: a copper zone fails `no-zones` ("The file has a copper zone,
which this checker does not model.").

## Vias and plated drills

A via or plated pad drill removes copper on both layers, so any other copper that reaches into its bore is a parse
failure, whatever its net. The drilled item's own copper is exempt. These cases are allowed (`src/verify.ts`):

- a track that ends at the drill's centre, within 0.0001 mm, and runs out past the drill (`wiredThrough`);
- for a via only: a straight track of the via's own net that runs across the bore, with both of its ends outside
  the bore (`crossesOwnVia`). A net named `""` or `"0"` never counts as the via's own.

Still refused:

- via-in-pad: a small via inside an SMD land is refused even when most of the land remains;
- a track that reaches into a bore without these shapes, including a rounded copper tip that touches the bore wall;
- any track that reaches into a plated pad's own drill, unless it ends at the centre.

Every refusal is conservative: it prevents a false pass, at the cost of rejecting some valid layouts.

## Clearance to a non-plated hole (boundary)

A non-plated hole is modelled as a 64-sided polygon inscribed in its true circle. The worst-case shortfall of that
polygon is `r * (1 - cos(pi / 64))`, which for a 1 mm bore (r = 0.5 mm) is about 0.000602 mm.

The check computes the modelled gap `g` between the copper and the bore polygon. Because the polygon lies inside
the true circle, `g` is never smaller than the true gap. The check subtracts the shortfall and fails when

    g - 0.000602 mm < minimum clearance - 0.0001 mm

The 0.0001 mm allowance (`EPS`) absorbs float noise only. It is not widened to pass borderline geometry.

Worked example: a 1 mm non-plated hole, a 0.25 mm straight track, and a 0.2 mm minimum clearance.

| True edge-to-edge gap | Result |
| --- | --- |
| 0.1999 mm and below | fails clearance |
| 0.2 mm and 0.2001 mm | fails clearance (conservative; the true gap is at the minimum) |
| 0.201 mm | passes |

At the cardinal direction, where the polygon vertex lies on the true circle, the cutoff is a true gap of about
0.2005 mm. A design that sits exactly on the minimum fails. Target at least 0.201 mm for a 1 mm bore at a 0.2 mm
minimum.

Limitation: the clearance message rounds the measured and required values to two decimals, so it can read
"0.20 mm is below 0.20 mm". The fix is more precision in the message, or stating the approximation. That is not
done yet.

## Stackup

A `(setup (stackup ...))` record is accepted only when it describes the modelled board:

- exactly two copper layers, F.Cu and B.Cu;
- exactly one core, stacked between them, in the order F.Cu, core, B.Cu;
- total thickness within 0.01 mm of 1.6 mm, either as copper plus core, or as the whole stack including mask,
  silkscreen, and paste layers.

Any other copper layer, second core, other order, other total, or unknown stackup record fails parse. Repeating
the stackup record also fails. The total convention was chosen to match common KiCad defaults. It has not been
checked against KiCad output.

## Not verified

- KiCad import, save, or round-trip. The package reads text, and its samples are generated by `samples/generate.ts`.
- Physical fabrication, manufacturer rules, and general KiCad 8 compatibility. Only the subset above is modelled.
- Behaviour outside the 2-layer, 1.6 mm model. Those inputs are refused, not approximated.

## Tests

From the repository root, run one file or the package suite with a bounded heap:

    node --max-old-space-size=256 --test --test-concurrency=1 packages/verifier-pcb/test/<file>.test.ts
    npx tsc -p . --noEmit
