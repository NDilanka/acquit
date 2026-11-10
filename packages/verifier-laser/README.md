# verifier-laser

A pure TypeScript checker for laser-cut panel SVG files. It reads the drawing, works out the finished part the laser
leaves, and checks that part against a spec. It never reads files, never uses the clock or randomness, and never
throws: an input it cannot check fails the `parse` rule with a plain message.

## Usage

```ts
import { verify, validateSpec, RULES } from "verifier-laser";

const spec = validateSpec(specJson); // { ok: true, value } or { ok: false, errors }
const verdict = verify(spec.value, svgText, hiddenSample); // optional hidden samples
verdict.pass; // true only when every rule passes
verdict.findings; // one finding per rule in RULES order; a single parse finding when nothing can be checked
```

A hidden sample has `keepMaterialMm` (points that must be finished material), optionally `voidMm` (points that must be
finished void) and `clearanceMm` (a minimum distance from each keep point to any finished edge).

A hidden-material finding never prints the hidden data. Its message is fixed text that names no sample, count,
clearance or coordinate, and `measured` carries no hidden figure.

## Resolution

The reader flattens every curve (paths, arcs, circles, ellipses and rounded rectangles) into straight chords. The
approximation constant is `FLATTEN_TOL_MM` in `src/svg.ts`:

- **FLATTEN_TOL_MM = 0.02 mm.** Each chord stays within 0.02 mm of the curve it came from, measured in mm after the
  drawing's transforms.

That error is an uncertainty, not a tolerance. A decision about a point, a segment or a label region is made as if
the drawn line could sit up to 0.02 mm away from the chords the reader sees:

- **Finished material** needs the point to be more than kerf/2 + 0.02 mm from every drawn line, inside the outer cut
  and outside every inner cut. A point nearer than that fails, whichever side it is on.
- **Clearance** is a lower bound: the nearest drawn line less kerf/2 and less 0.02 mm. It must reach the spec's
  clearance for a hidden keep point to pass.
- **Expected voids** need the point more than 0.02 mm inside an inner cut, or within kerf/2 − 0.02 mm of its line.
- **Engraving** must lie inside the label region by more than 0.02 mm on each side, and every engraved segment must
  stay more than kerf/2 + 0.04 mm from every outer and inner edge. A path that measures 0.02 mm or less, such as a
  zero-length line or a path scaled to a point, engraves nothing and does not hold. The engraved length in total,
  summed over the paths, must reach the spec's `minEngraveLengthMm`.
- **Minimum web** subtracts 2 × 0.02 mm from the drawn gap, so the reported web is a lower bound too.
- **Tolerance** must be at least 0.04 mm, twice the flattening error. A smaller tolerance, on the spec or on a hole or
  slot, fails `parse`. The checker never raises a tolerance to a floor.

The chord count for a curve is bounded by the limits in `src/limits.ts`. A curve that needs more chords than
`MAX_CHORDS` fails the `parse` rule.

A round hole is checked against its true circle, not a polygon. A closed cut fits the hole when its loop is simple, runs
once round the centre and encloses an area the tolerance allows, and every point of it lies within the tolerance of that
circle. That part is exact for a polyline: distance from the centre is convex along each straight edge, so the vertices
bound the outside and a centre-clear test bounds the inside. Running once round the centre inside that band also covers
every direction of the circle within the tolerance, and an explicit guard refuses any arc of the circle left uncut for
longer than twice the tolerance. A polygon with the right vertices but straight sides fails. A C-shaped loop whose arcs
lie within the tolerance of the circle but do not run round the centre fails.

The outer cut and the slots fit the declared rounded rectangle by a two-way sampled distance check at a quarter of the
tolerance. Every drawn edge is sampled, and each sample must lie within the tolerance of the exact outline: straight
sides and quarter-circle corners at the declared radius, measured on the box the cut spans. The exact outline is
sampled at the same spacing, each sample must lie within the tolerance of the drawn cut, and the cut must run once
round the centre. Straight chords standing off a true arc fail, a rounded rectangle with the wrong radius fails, and a
contour that stays within the tolerance band but leaves a stretch of the ideal outline uncut — a stepped or shortcut
corner — fails too. The samples a fit needs are counted from the geometry before any is taken, and a shape too large
to check at the requested tolerance fails the `parse` rule.

## Rules

The verdict reports these rule ids, in this order (`RULES` in `src/types.ts`):

`parse`, `units-mm`, `colours`, `closed-paths`, `no-duplicates`, `fits-bed`, `outer-size`, `holes`, `cutouts`,
`engrave-inside`, `min-web`, `cut-order`, `no-self-intersection`, `hidden-material`.

## Colours and kinds

Red `#ff0000` is a cut; the red outer cut is the outline. Blue `#0000ff` is an engraving. A path with no colour is
travel and is not cut or engraved. The stroke colour is the layer.

## Layout

- `src/` is pure: no `node:` imports, no dependencies, no I/O, no randomness, no dates. Everything is mm as plain numbers.
- `samples/` holds the honest panel, one hidden sample set and one file per known fraud. `src/samples.ts` is generated
  from them by `tools/generate-samples.ts`; regenerate it after any sample change.
- `tools/render-samples.ts` holds the text renderer that `tools/generate-samples.ts` uses to write `src/samples.ts`.
- `test/` holds the tests. Run them from the repository root with `node --test packages/verifier-laser/test/*.test.ts`.

## What is not verified

The verifier checks the file. It does not run a machine. Cut and engrave times use planning values (10 mm/s cut,
100 mm/s engrave, 0.5 s per cut path), and the verdict reports the run as simulated. A label's text, orientation and
mirroring are not checked: the spec gives only a region.
