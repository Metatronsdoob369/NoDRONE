import { describe, expect, it } from 'vitest';
import { applySplatLoadOutcome } from './surveySplatStatus';

const success = { ok: true as const, source: 'https://example.com/site/scene.ply' };

describe('applySplatLoadOutcome', () => {
  it('sets processed when the splat load succeeds', () => {
    const prior = { status: 'planned' as const, splatLoadError: null };
    const next = applySplatLoadOutcome(prior, success);

    expect(next.status).toBe('processed');
    expect(next.splatLoadError).toBeNull();
    expect(prior.status).toBe('planned');

    const fromCaptured = applySplatLoadOutcome({ status: 'captured', splatLoadError: null }, {
      ok: true,
      source: 'roof.spz',
    });
    expect(fromCaptured).toEqual({ status: 'processed', splatLoadError: null });
  });

  it('keeps the prior status and records the load error on failure', () => {
    const prior = { status: 'captured' as const, splatLoadError: null };
    const next = applySplatLoadOutcome(prior, {
      ok: false,
      source: 'https://cdn.example.com/surveys/roof.splat',
      message: 'HTTP 404 while fetching splat',
    });

    expect(next.status).toBe('captured');
    expect(next.splatLoadError).toEqual({
      message: 'HTTP 404 while fetching splat',
      source: 'https://cdn.example.com/surveys/roof.splat',
    });
    expect(prior.splatLoadError).toBeNull();

    const fromPlanned = applySplatLoadOutcome({ status: 'planned', splatLoadError: null }, {
      ok: false,
      source: 'missing.ply',
      message: 'PLY file is missing an end_header marker',
    });
    expect(fromPlanned.status).toBe('planned');
    expect(fromPlanned.splatLoadError?.source).toBe('missing.ply');
  });

  it('treats a duplicate success as idempotent', () => {
    const once = applySplatLoadOutcome({ status: 'planned', splatLoadError: null }, success);
    const twice = applySplatLoadOutcome(once, success);
    const third = applySplatLoadOutcome(twice, {
      ok: true,
      source: 'scene.ply',
    });

    expect(once).toEqual({ status: 'processed', splatLoadError: null });
    expect(twice).toEqual(once);
    expect(third).toEqual({ status: 'processed', splatLoadError: null });
  });

  it('never downgrades a survey that is already processed', () => {
    const processed = applySplatLoadOutcome({ status: 'captured', splatLoadError: null }, success);
    const reloaded = applySplatLoadOutcome(processed, {
      ok: false,
      source: 'scene.ply',
      message: 'Local splat file "scene.ply" is not loaded in this session',
    });

    expect(processed.status).toBe('processed');
    expect(reloaded.status).toBe('processed');
    expect(reloaded.splatLoadError).toEqual({
      message: 'Local splat file "scene.ply" is not loaded in this session',
      source: 'scene.ply',
    });

    const stillProcessed = applySplatLoadOutcome(reloaded, success);
    expect(stillProcessed.status).toBe('processed');
    expect(stillProcessed.splatLoadError).toBeNull();
  });
});
