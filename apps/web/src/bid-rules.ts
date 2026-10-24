/**
 * The pitch rule, as apps/api/src/server.ts applies it: `text(command.pitch, "pitch", 2000)` (line 450), which
 * refuses a value that is not a string, a value that is blank after trimming, and a value longer than 2000
 * characters (`value.length`, UTF-16 code units). The form checks the same things, so the server never sees a
 * pitch the form let through.
 */
export const PITCH_MAX = 2000;

/** Why a pitch cannot be sent, or null when the server takes it. */
export function pitchProblem(pitch: string): string | null {
  if (pitch.trim() === "") return "Write a pitch: one sentence on how the work will be done.";
  if (pitch.length > PITCH_MAX) return `The pitch is ${pitch.length - PITCH_MAX} characters too long. The limit is ${PITCH_MAX}.`;
  return null;
}
