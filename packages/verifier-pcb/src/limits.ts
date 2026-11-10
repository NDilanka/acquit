// Admission and work limits for one check. Each limit is enforced before the work it bounds, so an oversized
// delivery fails the parse with a message that names the limit. It never freezes the caller or exhausts memory.

/** The largest accepted file, in characters. */
export const MAX_INPUT_CHARS = 5_242_880;
/** The deepest accepted list nesting. The outermost list is level 1. */
export const MAX_NESTING = 256;
/** Every parsed list and atom counts once, the outermost list included. */
export const MAX_ELEMENTS = 100_000;
/** Copper items: segments, arc pieces, vias, and pads. Counted before any geometry is built. */
export const MAX_COPPER_ITEMS = 1_000;
/** Outline edges after rectangles are split into sides and arcs into pieces. */
export const MAX_OUTLINE_EDGES = 2_048;
/** Flattened arc pieces from every arc in the file, plus the vertices of each Edge.Cuts circle. */
export const MAX_VERTICES = 16_384;
/** Vertices of one Edge.Cuts circle, as circlePolygon draws it. */
export const CIRCLE_VERTICES = 64;
/** Straight pieces that one arc may flatten to. */
export const MAX_ARC_PIECES = 1_024;
/**
 * Segment-pair evaluations across one verification, shared by every scan. A distance test between two items
 * costs one evaluation per pair of their straight edges: a track is one edge, a pad or via polygon has one per side.
 * A board of a few hundred copper items spread over its area stays far below this; a dense cluster that exceeds
 * it fails the check rather than being partly checked.
 */
export const MAX_SEGMENT_TESTS = 100_000;
