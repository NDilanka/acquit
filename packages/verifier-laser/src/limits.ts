// The budgets that keep a hostile file from exhausting memory or time. The reader spends the first group while it
// reads, before the work is made. The verifier spends the last one before its quadratic rules start. A file over a
// budget fails the parse rule, so every check runs in bounded time and space.

/** Characters of SVG text the reader will look at. A laser panel is a few hundred kilobytes. */
export const MAX_TEXT_CHARS = 2_000_000;

/** Deepest element nesting. A laser file nests a handful of groups. */
export const MAX_DEPTH = 32;

/** Elements in the file, the root included. */
export const MAX_ELEMENTS = 10_000;

/** Drawn subpaths. A path with several moveto commands counts each subpath. */
export const MAX_SUBPATHS = 2_000;

/** Points made across every drawn path, after flattening. */
export const MAX_POINTS = 200_000;

/** Chords one curve or arc may be flattened into. A circle of radius 1 m at 0.02 mm takes about 15,700. */
export const MAX_CHORDS = 20_000;

/**
 * Segment pairs and point tests the crossing, gap, inside and hidden checks may run. Crossings and gaps cost at most
 * the square of the cut edge count; each engraving point and hidden sample costs one pass over the cut edges.
 */
export const MAX_PAIR_TESTS = 20_000_000;
