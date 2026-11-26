export type RenderResolution = [number, number];

export const DEFAULT_RENDER_RESOLUTION: RenderResolution = [1920, 1080];

export const RENDER_RESOLUTION_PRESETS: ReadonlyArray<{
  value: string;
  label: string;
  resolution: RenderResolution;
}> = [
  { value: '1280x720', label: '1280×720', resolution: [1280, 720] },
  { value: '1920x1080', label: '1920×1080', resolution: [1920, 1080] },
  { value: '3840x2160', label: '3840×2160', resolution: [3840, 2160] },
];

export function parseResolutionTuple(raw: unknown): RenderResolution | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const w = Math.round(Number(raw[0]));
  const h = Math.round(Number(raw[1]));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 64 || h < 64 || w > 7680 || h > 4320) {
    return null;
  }
  return [w, h];
}

export function parseResolutionPresetValue(value: string | null | undefined): RenderResolution | null {
  if (!value) return null;
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(value.trim());
  if (!match) return null;
  return parseResolutionTuple([Number(match[1]), Number(match[2])]);
}

export function formatResolutionValue(res: RenderResolution): string {
  return `${res[0]}x${res[1]}`;
}

export function extractPathJsonRenderResolution(pathJson: unknown): RenderResolution | null {
  if (!pathJson || typeof pathJson !== 'object') return null;
  const renderObj = (pathJson as { render?: unknown }).render;
  if (!renderObj || typeof renderObj !== 'object') return null;
  return parseResolutionTuple((renderObj as { resolution?: unknown }).resolution);
}

/**
 * Resolves a Render Path's base resolution from JSON:
 * uses `pathJson.render.resolution` if valid, otherwise defaults to 1920x1080.
 */
export function resolveRenderPathInitialResolution(pathJson?: unknown): RenderResolution {
  const fromJson = extractPathJsonRenderResolution(pathJson);
  if (fromJson) return fromJson;
  return [DEFAULT_RENDER_RESOLUTION[0], DEFAULT_RENDER_RESOLUTION[1]];
}

/**
 * Resolves the effective Render Path resolution, applying an explicit user
 * dropdown override when present and otherwise falling back to `render.resolution`
 * or the 1920x1080 default.
 */
export function resolveEffectiveRenderResolution(options: {
  pathJson?: unknown;
  dropdownOverride?: RenderResolution | null;
} = {}): RenderResolution {
  if (options.dropdownOverride) {
    const validOverride = parseResolutionTuple(options.dropdownOverride);
    if (validOverride) return validOverride;
  }
  return resolveRenderPathInitialResolution(options.pathJson);
}
