export const TRAINING_MODE_SSE = 2;
export const CAPTURE_SETTLE_TIMEOUT_MS = 60000;
export const TRAINING_MODE_SETTLE_TIMEOUT_MS = CAPTURE_SETTLE_TIMEOUT_MS;
export const DEFAULT_CAPTURE_SETTLE_TIMEOUT_MS = CAPTURE_SETTLE_TIMEOUT_MS;

export interface CaptureSettleResult {
  timedOut: boolean;
  waitMs: number;
  cancelled: boolean;
}

export interface CaptureSettleWithRetryResult extends CaptureSettleResult {
  retried: boolean;
  attempts: number;
}

/**
 * Returns the maximum per-frame/per-view settle timeout (60 s) for all capture modes
 * (Capture Bundle Training ON/OFF, Render Path, and snapshots). Frames that settle
 * faster still resolve immediately once tiles finish loading.
 */
export function getCaptureSettleTimeoutMs(_trainingMode?: boolean): number {
  return CAPTURE_SETTLE_TIMEOUT_MS;
}

/**
 * Places the camera and waits for tiles to settle up to the 60 s maximum timeout.
 * Frames that settle quickly resolve immediately. If the first attempt times out,
 * re-runs `placeCamera` and waits once more.
 */
export async function settleViewWithRetry(options: {
  trainingMode?: boolean;
  placeCamera: () => void;
  waitForSettle: (timeoutMs: number) => Promise<CaptureSettleResult>;
  isCancelled?: () => boolean;
}): Promise<CaptureSettleWithRetryResult> {
  const timeoutMs = getCaptureSettleTimeoutMs(options.trainingMode);

  options.placeCamera();
  const first = await options.waitForSettle(timeoutMs);
  if (first.cancelled || options.isCancelled?.()) {
    return {
      timedOut: false,
      waitMs: first.waitMs,
      cancelled: true,
      retried: false,
      attempts: 1,
    };
  }
  if (!first.timedOut) {
    return {
      timedOut: false,
      waitMs: first.waitMs,
      cancelled: false,
      retried: false,
      attempts: 1,
    };
  }

  // First attempt timed out: retry once (re-run setView + wait)
  options.placeCamera();
  const second = await options.waitForSettle(timeoutMs);
  const cancelled = second.cancelled || Boolean(options.isCancelled?.());
  return {
    timedOut: !cancelled && second.timedOut,
    waitMs: first.waitMs + second.waitMs,
    cancelled,
    retried: true,
    attempts: 2,
  };
}

export function formatTimeoutWarningToast(
  count: number,
  unit: 'frame' | 'view' | 'snapshot'
): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const n = Math.round(count);
  const plural = n === 1 ? '' : 's';
  if (unit === 'snapshot') {
    return `Warning: ${n} snapshot${plural} timed out after retry (tiles may be incomplete).`;
  }
  return `Warning: ${n} ${unit}${plural} timed out after retry (saved; listed in render-log.json).`;
}

export interface TrainingModeSceneSnapshot {
  skyAtmosphereShow: boolean | null;
  fogEnabled: boolean | null;
  sunShow: boolean | null;
  moonShow: boolean | null;
  skyBoxShow: boolean | null;
  globeEnableLighting: boolean | null;
  viewerShadows: boolean | null;
  shadowMapEnabled: boolean | null;
  tilesets: Array<{ tileset: any; maximumScreenSpaceError: number }>;
}

export interface CaptureRenderSettingsDocument {
  schema: 'nodrone-render-settings/1.0';
  date: string;
  cesiumVersion: string;
  resolution: [number, number];
  trainingMode: boolean;
  maximumScreenSpaceError: number;
  tilesetCount: number;
  toggles: {
    skyAtmosphere: boolean;
    fog: boolean;
    sun: boolean;
    moon: boolean;
    skyBox: boolean;
    globeEnableLighting: boolean;
    shadows: boolean;
    msaaSamples: number | null;
    splatOverlayComposited: boolean;
    attributionBar: boolean;
    cleanRender: boolean;
  };
}

function collectUniqueTilesets(viewer: any, extraTilesets: any[] = []): any[] {
  const seen = new Set<any>();
  const addIfTileset = (candidate: any) => {
    if (!candidate || seen.has(candidate)) return;
    if (typeof candidate.maximumScreenSpaceError === 'number') {
      seen.add(candidate);
    }
  };

  for (const ts of extraTilesets) {
    addIfTileset(ts);
  }

  const primitives = viewer?.scene?.primitives;
  if (primitives && typeof primitives.length === 'number' && typeof primitives.get === 'function') {
    for (let i = 0; i < primitives.length; i++) {
      addIfTileset(primitives.get(i));
    }
  } else if (Array.isArray(primitives)) {
    for (const p of primitives) {
      addIfTileset(p);
    }
  }

  return Array.from(seen);
}

/**
 * Applies deterministic training-mode scene overrides for Capture Bundle:
 * turns off skyAtmosphere, fog, sun, moon, skyBox, globe.enableLighting, and shadows;
 * keeps MSAA untouched; sets Google 3D and all loaded tilesets' maximumScreenSpaceError to 2.
 * Returns a snapshot used to restore every single setting in a `finally` block.
 */
export function applyTrainingModeSceneSettings(
  viewer: any,
  extraTilesets: any[] = []
): TrainingModeSceneSnapshot {
  const scene = viewer?.scene;
  const snapshot: TrainingModeSceneSnapshot = {
    skyAtmosphereShow: null,
    fogEnabled: null,
    sunShow: null,
    moonShow: null,
    skyBoxShow: null,
    globeEnableLighting: null,
    viewerShadows: null,
    shadowMapEnabled: null,
    tilesets: [],
  };

  if (scene?.skyAtmosphere && typeof scene.skyAtmosphere.show === 'boolean') {
    snapshot.skyAtmosphereShow = scene.skyAtmosphere.show;
    scene.skyAtmosphere.show = false;
  }
  if (scene?.fog && typeof scene.fog.enabled === 'boolean') {
    snapshot.fogEnabled = scene.fog.enabled;
    scene.fog.enabled = false;
  }
  if (scene?.sun && typeof scene.sun.show === 'boolean') {
    snapshot.sunShow = scene.sun.show;
    scene.sun.show = false;
  }
  if (scene?.moon && typeof scene.moon.show === 'boolean') {
    snapshot.moonShow = scene.moon.show;
    scene.moon.show = false;
  }
  if (scene?.skyBox && typeof scene.skyBox.show === 'boolean') {
    snapshot.skyBoxShow = scene.skyBox.show;
    scene.skyBox.show = false;
  }
  if (scene?.globe && typeof scene.globe.enableLighting === 'boolean') {
    snapshot.globeEnableLighting = scene.globe.enableLighting;
    scene.globe.enableLighting = false;
  }
  if (viewer && typeof viewer.shadows === 'boolean') {
    snapshot.viewerShadows = viewer.shadows;
    viewer.shadows = false;
  }
  if (scene?.shadowMap && typeof scene.shadowMap.enabled === 'boolean') {
    snapshot.shadowMapEnabled = scene.shadowMap.enabled;
    scene.shadowMap.enabled = false;
  }

  const tilesets = collectUniqueTilesets(viewer, extraTilesets);
  for (const tileset of tilesets) {
    snapshot.tilesets.push({
      tileset,
      maximumScreenSpaceError: tileset.maximumScreenSpaceError,
    });
    tileset.maximumScreenSpaceError = TRAINING_MODE_SSE;
  }

  return snapshot;
}

/**
 * Restores every scene toggle and tileset maximumScreenSpaceError saved by
 * `applyTrainingModeSceneSettings`. Never modifies MSAA.
 */
export function restoreTrainingModeSceneSettings(
  viewer: any,
  snapshot: TrainingModeSceneSnapshot | null
): void {
  if (!snapshot) return;
  const scene = viewer?.scene;

  if (snapshot.skyAtmosphereShow !== null && scene?.skyAtmosphere) {
    scene.skyAtmosphere.show = snapshot.skyAtmosphereShow;
  }
  if (snapshot.fogEnabled !== null && scene?.fog) {
    scene.fog.enabled = snapshot.fogEnabled;
  }
  if (snapshot.sunShow !== null && scene?.sun) {
    scene.sun.show = snapshot.sunShow;
  }
  if (snapshot.moonShow !== null && scene?.moon) {
    scene.moon.show = snapshot.moonShow;
  }
  if (snapshot.skyBoxShow !== null && scene?.skyBox) {
    scene.skyBox.show = snapshot.skyBoxShow;
  }
  if (snapshot.globeEnableLighting !== null && scene?.globe) {
    scene.globe.enableLighting = snapshot.globeEnableLighting;
  }
  if (snapshot.viewerShadows !== null && viewer) {
    viewer.shadows = snapshot.viewerShadows;
  }
  if (snapshot.shadowMapEnabled !== null && scene?.shadowMap) {
    scene.shadowMap.enabled = snapshot.shadowMapEnabled;
  }

  for (const entry of snapshot.tilesets) {
    if (entry.tileset && typeof entry.tileset.maximumScreenSpaceError === 'number') {
      entry.tileset.maximumScreenSpaceError = entry.maximumScreenSpaceError;
    }
  }
}

export function buildCaptureRenderSettingsJson(options: {
  viewer: any;
  cesiumVersion: string;
  resolution: [number, number];
  trainingMode: boolean;
  currentSSE: number;
  extraTilesets?: any[];
  date?: string;
}): CaptureRenderSettingsDocument {
  const scene = options.viewer?.scene;
  const tilesets = collectUniqueTilesets(options.viewer, options.extraTilesets ?? []);
  const msaaSamples = typeof scene?.msaaSamples === 'number' ? scene.msaaSamples : null;

  return {
    schema: 'nodrone-render-settings/1.0',
    date: options.date ?? new Date().toISOString(),
    cesiumVersion: options.cesiumVersion || 'unknown',
    resolution: [options.resolution[0], options.resolution[1]],
    trainingMode: options.trainingMode,
    maximumScreenSpaceError: options.trainingMode ? TRAINING_MODE_SSE : options.currentSSE,
    tilesetCount: tilesets.length,
    toggles: {
      skyAtmosphere: Boolean(scene?.skyAtmosphere?.show),
      fog: Boolean(scene?.fog?.enabled),
      sun: Boolean(scene?.sun?.show),
      moon: Boolean(scene?.moon?.show),
      skyBox: Boolean(scene?.skyBox?.show),
      globeEnableLighting: Boolean(scene?.globe?.enableLighting),
      shadows: Boolean(options.viewer?.shadows || scene?.shadowMap?.enabled),
      msaaSamples,
      splatOverlayComposited: !options.trainingMode,
      attributionBar: true,
      cleanRender: true,
    },
  };
}
