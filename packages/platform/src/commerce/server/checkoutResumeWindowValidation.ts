const DEFAULT_RESUME_WINDOW_MINUTES = 60;
const MAX_RESUME_WINDOW_MINUTES = 2147483647;

/** Validates an explicit resume window (positive 32-bit integer) or returns the default 60 minutes. */
export function resolveResumeWindowMinutes(resumeWindowMinutes?: number): number {
  if (resumeWindowMinutes === undefined) return DEFAULT_RESUME_WINDOW_MINUTES;
  if (
    !Number.isInteger(resumeWindowMinutes)
    || resumeWindowMinutes <= 0
    || resumeWindowMinutes > MAX_RESUME_WINDOW_MINUTES
  ) {
    throw new RangeError(
      `checkout_resume_window_minutes_invalid: expected an integer from 1 to ${MAX_RESUME_WINDOW_MINUTES}`,
    );
  }
  return resumeWindowMinutes;
}
