// Photograph events: where the camera fires along a mission. Pure: no I/O, no clock, no randomness.
//
// A camera fires at the start of each stretch of flight with triggering on, then every trigger distance along it.
// The phase carries from one stretch into the next, so the next exposure falls where the last one left off. A stretch
// with triggering off resets the phase: the next stretch with triggering on starts with a photograph. Exposures on a
// transit move the phase but earn no credit: only survey flights return photographs.

/** Metres. Positions this close to a boundary count as on it, so float rounding cannot drop an exposure. */
const EPS = 1e-6;

/**
 * A survey line: it runs from along-heading position s0 to s1 at across-heading position t and altitude alt. The
 * photographs are taken in the direction of flight, from s0 towards s1.
 */
export type SurveyLine = { readonly s0: number; readonly s1: number; readonly t: number; readonly alt: number };

/**
 * One stretch of flight: its ground length in metres, the trigger distance in force (null while triggering is off),
 * and the survey line it flies, or null for a transit.
 */
export type Flight = { readonly length: number; readonly trigger: number | null; readonly survey: SurveyLine | null };

/** A photograph on a survey line: its along-heading position s, across-heading position t, altitude, and the flight that took it. */
export type Shot = { readonly flight: number; readonly s: number; readonly t: number; readonly alt: number };

/**
 * The photographs taken on the survey flights, in flight order. Returns null when the flights would take more than
 * `limit` exposures in all, transits included, so the work is bounded before any list is built.
 */
export function photographs(flights: readonly Flight[], limit: number): Shot[] | null {
	const shots: Shot[] = [];
	let exposures = 0;
	// The mission distance at which the next exposure is due, or null while triggering is off.
	let due: number | null = null;
	// The mission distance at which the current flight starts.
	let start = 0;
	for (let index = 0; index < flights.length; index++) {
		const flight = flights[index]!;
		const end = start + flight.length;
		if (flight.trigger === null) {
			due = null;
		} else {
			if (due === null) due = start;
			while (due <= end + EPS) {
				exposures++;
				if (exposures > limit) return null;
				const survey = flight.survey;
				if (survey !== null) {
					const sign = survey.s1 >= survey.s0 ? 1 : -1;
					shots.push({ flight: index, s: survey.s0 + sign * (due - start), t: survey.t, alt: survey.alt });
				}
				due += flight.trigger;
			}
		}
		start = end;
	}
	return shots;
}
