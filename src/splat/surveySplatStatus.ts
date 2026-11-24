import type { SurveySplatLoadError, SurveyStatus } from '../types';

/**
 * Outcome of one attempt to load a survey's .ply / .spz / .splat reference.
 * `processed` is applied only when `ok` is true. Failures keep the prior status.
 */
export interface SplatLoadOutcome {
  ok: boolean;
  /** URL or filename shown with the error in the survey UI. */
  source: string;
  message?: string;
}

export interface SplatStatusSnapshot {
  status: SurveyStatus;
  splatLoadError: SurveySplatLoadError | null;
}

/**
 * Status rule for a survey splat load.
 *
 * Success sets `processed` and clears any previous load error. A second success
 * stays `processed` with no error (idempotent). Failure keeps the prior status,
 * including `processed`, and records the message plus the URL or filename.
 */
export function applySplatLoadOutcome(
  survey: { status: SurveyStatus; splatLoadError?: SurveySplatLoadError | null },
  outcome: SplatLoadOutcome
): SplatStatusSnapshot {
  if (outcome.ok) {
    return {
      status: 'processed',
      splatLoadError: null,
    };
  }

  const message = outcome.message?.trim() || 'Splat failed to load';
  const source = outcome.source.trim() || 'splat';
  return {
    status: survey.status,
    splatLoadError: { message, source },
  };
}
