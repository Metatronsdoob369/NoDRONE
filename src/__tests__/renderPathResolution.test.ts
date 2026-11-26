import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RENDER_RESOLUTION,
  RENDER_RESOLUTION_PRESETS,
  extractPathJsonRenderResolution,
  formatResolutionValue,
  parseResolutionPresetValue,
  parseResolutionTuple,
  resolveEffectiveRenderResolution,
  resolveRenderPathInitialResolution,
} from '../renderPathResolution';

describe('Render Path resolution defaults and overrides', () => {
  it('defaults to 1920x1080 when no path JSON or no render.resolution is provided', () => {
    expect(DEFAULT_RENDER_RESOLUTION).toEqual([1920, 1080]);
    expect(resolveRenderPathInitialResolution()).toEqual([1920, 1080]);
    expect(resolveRenderPathInitialResolution(null)).toEqual([1920, 1080]);
    expect(resolveRenderPathInitialResolution({})).toEqual([1920, 1080]);
    // Ignores viewport-derived fields outside render.resolution
    expect(
      resolveRenderPathInitialResolution({
        sceneContext: { resolution: [1359, 892] },
        resolution: [1359, 892],
        frames: [{ K: { width: 1359, height: 892 } }],
      })
    ).toEqual([1920, 1080]);
  });

  it('uses render.resolution when present and valid in path JSON', () => {
    expect(
      resolveRenderPathInitialResolution({
        schema: 'nodrone-camera-path/1',
        render: { fps: 30, resolution: [1280, 720] },
      })
    ).toEqual([1280, 720]);

    expect(
      resolveRenderPathInitialResolution({
        render: { resolution: [3840, 2160] },
      })
    ).toEqual([3840, 2160]);

    expect(
      extractPathJsonRenderResolution({
        render: { resolution: [2560, 1440] },
      })
    ).toEqual([2560, 1440]);
  });

  it('falls back to 1920x1080 when render.resolution is invalid or out of range', () => {
    expect(resolveRenderPathInitialResolution({ render: { resolution: [0, 0] } })).toEqual([1920, 1080]);
    expect(resolveRenderPathInitialResolution({ render: { resolution: [32, 32] } })).toEqual([1920, 1080]);
    expect(resolveRenderPathInitialResolution({ render: { resolution: [9999, 9999] } })).toEqual([1920, 1080]);
    expect(resolveRenderPathInitialResolution({ render: { resolution: ['bad', null] } })).toEqual([1920, 1080]);
    expect(resolveRenderPathInitialResolution({ render: { resolution: [1920] } })).toEqual([1920, 1080]);
    expect(parseResolutionTuple('1920x1080')).toBeNull();
  });

  it('applies dropdown resolution overrides over both the 1920x1080 default and JSON render.resolution', () => {
    expect(
      resolveEffectiveRenderResolution({
        pathJson: null,
        dropdownOverride: [3840, 2160],
      })
    ).toEqual([3840, 2160]);

    expect(
      resolveEffectiveRenderResolution({
        pathJson: { render: { resolution: [1280, 720] } },
        dropdownOverride: [3840, 2160],
      })
    ).toEqual([3840, 2160]);

    expect(
      resolveEffectiveRenderResolution({
        pathJson: { render: { resolution: [1280, 720] } },
        dropdownOverride: null,
      })
    ).toEqual([1280, 720]);

    expect(
      resolveEffectiveRenderResolution({
        pathJson: { render: {} },
        dropdownOverride: null,
      })
    ).toEqual([1920, 1080]);
  });

  it('exposes the 720p, 1080p, and 4K dropdown presets and parses preset strings cleanly', () => {
    expect(RENDER_RESOLUTION_PRESETS.map((p) => p.value)).toEqual([
      '1280x720',
      '1920x1080',
      '3840x2160',
    ]);
    expect(parseResolutionPresetValue('1280x720')).toEqual([1280, 720]);
    expect(parseResolutionPresetValue('1920x1080')).toEqual([1920, 1080]);
    expect(parseResolutionPresetValue('3840×2160')).toEqual([3840, 2160]);
    expect(parseResolutionPresetValue('invalid')).toBeNull();
    expect(formatResolutionValue([1920, 1080])).toBe('1920x1080');
  });
});
