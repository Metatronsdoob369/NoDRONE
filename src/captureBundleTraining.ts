export const TRAINING_MODE_SSE = 4;
export const TRAINING_MODE_SSE_OPTIONS = [2, 4, 8] as const;
export type TrainingModeSSE = (typeof TRAINING_MODE_SSE_OPTIONS)[number];

export const CAPTURE_SETTLE_TIMEOUT_MS = 60000;
export const CAPTURE_NETWORK_IDLE_MS = 3000;
export const TRAINING_MODE_SETTLE_TIMEOUT_MS = CAPTURE_SETTLE_TIMEOUT_MS;
export const DEFAULT_CAPTURE_SETTLE_TIMEOUT_MS = CAPTURE_SETTLE_TIMEOUT_MS;

/** Raised Google 3D tileset cache limits applied during captures (1.5 GiB cache, 1 GiB overflow). */
export const CAPTURE_GOOGLE_CACHE_BYTES = 1536 * 1024 * 1024;
export const CAPTURE_GOOGLE_MAX_CACHE_OVERFLOW_BYTES = 1024 * 1024 * 1024;

export interface CaptureTilesetCacheSnapshot {
  tileset: any;
  cacheBytes: number | null;
  maximumCacheOverflowBytes: number | null;
}

export interface ViewTileStatsSnapshot {
  numberOfPendingRequests: number;
  numberOfTilesProcessing: number;
}

export type SettleReason = 'tilesLoaded' | 'idle' | 'timeout';

export interface CaptureSettleResult {
  timedOut: boolean;
  waitMs: number;
  cancelled: boolean;
  settledBy: SettleReason;
}

export interface CaptureSettleWithRetryResult extends CaptureSettleResult {
  retried: boolean;
  attempts: number;
}

export function parseTrainingModeSSE(raw: string | number | null | undefined): TrainingModeSSE {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (n === 2 || n === 4 || n === 8) return n;
  return TRAINING_MODE_SSE;
}

/**
 * Returns the maximum per-frame/per-view settle timeout (60 s) for all capture modes
 * (Capture Bundle Training ON/OFF, Render Path, and snapshots). Frames that settle
 * faster still resolve immediately once tiles finish loading or network goes idle.
 */
export function getCaptureSettleTimeoutMs(_trainingMode?: boolean): number {
  return CAPTURE_SETTLE_TIMEOUT_MS;
}

/**
 * Waits for a scene frame to settle using the unified rule across ALL captures:
 * - Settled by `'tilesLoaded'` when `areTilesLoaded()` passes 2 frames in a row.
 * - Settled by `'idle'` when no tile has started or finished loading for `idleMs` (default 3 s).
 * - Hard ceiling `'timeout'` at `timeoutMs` (default 60 s).
 */
export function waitForSceneSettle(options: {
  timeoutMs?: number;
  idleMs?: number;
  now?: () => number;
  scheduleNextFrame?: (cb: () => void) => void;
  renderFrame?: () => void;
  areTilesLoaded: () => boolean;
  isCancelled?: () => boolean;
  getTilesets?: () => any[];
  globe?: any;
}): Promise<CaptureSettleResult> {
  const timeoutMs = options.timeoutMs ?? CAPTURE_SETTLE_TIMEOUT_MS;
  const idleMs = options.idleMs ?? CAPTURE_NETWORK_IDLE_MS;
  const now = options.now ?? (() => performance.now());
  const scheduleNextFrame =
    options.scheduleNextFrame ?? ((cb: () => void) => window.requestAnimationFrame(cb));

  return new Promise((resolve) => {
    const startMs = now();
    let lastActivityMs = startMs;
    let consecutiveReady = 0;
    let finished = false;
    const removers: Array<() => void> = [];

    const markActivity = () => {
      lastActivityMs = now();
    };

    const tilesetTrackers = new Map<
      any,
      {
        pending: number | null;
        processing: number | null;
        loadedTotal: number | null;
      }
    >();

    const attachTileset = (ts: any) => {
      if (!ts || tilesetTrackers.has(ts)) return;
      const stats = ts.statistics;
      const tracker = {
        pending: typeof stats?.numberOfPendingRequests === 'number' ? stats.numberOfPendingRequests : null,
        processing:
          typeof stats?.numberOfTilesProcessing === 'number' ? stats.numberOfTilesProcessing : null,
        loadedTotal:
          typeof stats?.numberOfLoadedTilesTotal === 'number' ? stats.numberOfLoadedTilesTotal : null,
      };
      tilesetTrackers.set(ts, tracker);

      if (ts.tileLoad && typeof ts.tileLoad.addEventListener === 'function') {
        const remove = ts.tileLoad.addEventListener(() => {
          markActivity();
        });
        if (typeof remove === 'function') removers.push(remove);
      }
      if (ts.tileFailed && typeof ts.tileFailed.addEventListener === 'function') {
        const remove = ts.tileFailed.addEventListener(() => {
          markActivity();
        });
        if (typeof remove === 'function') removers.push(remove);
      }
      if (ts.loadProgress && typeof ts.loadProgress.addEventListener === 'function') {
        const remove = ts.loadProgress.addEventListener((pending: number, processing: number) => {
          if (pending !== tracker.pending || processing !== tracker.processing) {
            tracker.pending = pending;
            tracker.processing = processing;
            markActivity();
          }
        });
        if (typeof remove === 'function') removers.push(remove);
      }
    };

    const syncTilesetsAndPollStats = () => {
      const list = options.getTilesets?.() ?? [];
      for (const ts of list) {
        if (!ts || ts.show === false) continue;
        attachTileset(ts);
        const tracker = tilesetTrackers.get(ts);
        const stats = ts.statistics;
        if (tracker && stats) {
          const p =
            typeof stats.numberOfPendingRequests === 'number'
              ? stats.numberOfPendingRequests
              : tracker.pending;
          const proc =
            typeof stats.numberOfTilesProcessing === 'number'
              ? stats.numberOfTilesProcessing
              : tracker.processing;
          const loaded =
            typeof stats.numberOfLoadedTilesTotal === 'number'
              ? stats.numberOfLoadedTilesTotal
              : tracker.loadedTotal;
          if (p !== tracker.pending || proc !== tracker.processing || loaded !== tracker.loadedTotal) {
            tracker.pending = p;
            tracker.processing = proc;
            tracker.loadedTotal = loaded;
            markActivity();
          }
        }
      }
    };

    // Attach initial tileset listeners and globe tileLoadProgressEvent listener
    syncTilesetsAndPollStats();

    let lastGlobeQueued: number | null = null;
    const globe = options.globe;
    if (
      globe &&
      globe.show !== false &&
      globe.tileLoadProgressEvent &&
      typeof globe.tileLoadProgressEvent.addEventListener === 'function'
    ) {
      const remove = globe.tileLoadProgressEvent.addEventListener((queuedCount: number) => {
        if (queuedCount !== lastGlobeQueued) {
          lastGlobeQueued = queuedCount;
          markActivity();
        }
      });
      if (typeof remove === 'function') removers.push(remove);
    }

    const finish = (result: CaptureSettleResult) => {
      if (finished) return;
      finished = true;
      for (const remove of removers) {
        try {
          remove();
        } catch {
          // ignore cleanup error
        }
      }
      removers.length = 0;
      resolve(result);
    };

    const step = () => {
      if (finished) return;
      const currentMs = now();
      if (options.isCancelled?.()) {
        finish({
          timedOut: false,
          waitMs: Math.max(0, Math.round(currentMs - startMs)),
          cancelled: true,
          settledBy: 'timeout',
        });
        return;
      }

      try {
        options.renderFrame?.();
      } catch {
        // ignore transient render warning and retry next rAF
      }

      syncTilesetsAndPollStats();

      if (options.areTilesLoaded()) {
        consecutiveReady += 1;
      } else {
        consecutiveReady = 0;
      }

      const afterRenderMs = now();
      const elapsed = Math.max(0, afterRenderMs - startMs);
      const idleElapsed = Math.max(0, afterRenderMs - lastActivityMs);

      if (consecutiveReady >= 2) {
        finish({
          timedOut: false,
          waitMs: Math.round(elapsed),
          cancelled: false,
          settledBy: 'tilesLoaded',
        });
        return;
      }

      if (idleElapsed >= idleMs) {
        finish({
          timedOut: false,
          waitMs: Math.round(elapsed),
          cancelled: false,
          settledBy: 'idle',
        });
        return;
      }

      if (elapsed >= timeoutMs) {
        finish({
          timedOut: true,
          waitMs: Math.round(elapsed),
          cancelled: false,
          settledBy: 'timeout',
        });
        return;
      }

      scheduleNextFrame(step);
    };

    scheduleNextFrame(step);
  });
}

/**
 * Places the camera and waits for tiles to settle up to the 60 s maximum timeout
 * (settling early on 2x `tilesLoaded` or 3 s network idle). If the first attempt
 * times out, re-runs `placeCamera` and waits once more.
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
      settledBy: first.settledBy,
      retried: false,
      attempts: 1,
    };
  }
  if (!first.timedOut) {
    return {
      timedOut: false,
      waitMs: first.waitMs,
      cancelled: false,
      settledBy: first.settledBy,
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
    settledBy: second.settledBy,
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
  fogRenderable: boolean | null;
  sunShow: boolean | null;
  moonShow: boolean | null;
  skyBoxShow: boolean | null;
  globeEnableLighting: boolean | null;
  viewerShadows: boolean | null;
  shadowMapEnabled: boolean | null;
  googleDynamicScreenSpaceError: { tileset: any; value: boolean } | null;
  tilesets: Array<{ tileset: any; maximumScreenSpaceError: number }>;
}

export interface CaptureRenderSettingsDocument {
  schema: 'nodrone-render-settings/1.0';
  date: string;
  cesiumVersion: string;
  resolution: [number, number];
  trainingMode: boolean;
  maximumScreenSpaceError: number;
  dynamicScreenSpaceError: boolean;
  cacheBytes: number | null;
  maximumCacheOverflowBytes: number | null;
  tilesetCount: number;
  toggles: {
    skyAtmosphere: boolean;
    fogEnabled: boolean;
    fogRenderable: boolean;
    sun: boolean;
    moon: boolean;
    skyBox: boolean;
    globeEnableLighting: boolean;
    shadows: boolean;
    dynamicScreenSpaceError: boolean;
    msaaSamples: number | null;
    splatOverlayComposited: boolean;
    attributionBar: boolean;
    cleanRender: boolean;
  };
}

export function collectUniqueTilesets(viewer: any, extraTilesets: any[] = []): any[] {
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
 * Raises the Google 3D tileset cache limits during captures (`cacheBytes` to 1.5 GB,
 * `maximumCacheOverflowBytes` to 1 GB) to prevent cache eviction thrashing while
 * streaming high-detail views. Returns a snapshot used to restore both values in `finally`.
 */
export function applyCaptureGoogleTilesetCache(
  google3DTileset: any
): CaptureTilesetCacheSnapshot | null {
  if (!google3DTileset || typeof google3DTileset !== 'object') return null;

  const snapshot: CaptureTilesetCacheSnapshot = {
    tileset: google3DTileset,
    cacheBytes:
      typeof google3DTileset.cacheBytes === 'number' ? google3DTileset.cacheBytes : null,
    maximumCacheOverflowBytes:
      typeof google3DTileset.maximumCacheOverflowBytes === 'number'
        ? google3DTileset.maximumCacheOverflowBytes
        : null,
  };

  if (snapshot.cacheBytes !== null) {
    google3DTileset.cacheBytes = Math.max(snapshot.cacheBytes, CAPTURE_GOOGLE_CACHE_BYTES);
  } else {
    google3DTileset.cacheBytes = CAPTURE_GOOGLE_CACHE_BYTES;
  }

  if (snapshot.maximumCacheOverflowBytes !== null) {
    google3DTileset.maximumCacheOverflowBytes = Math.max(
      snapshot.maximumCacheOverflowBytes,
      CAPTURE_GOOGLE_MAX_CACHE_OVERFLOW_BYTES
    );
  } else {
    google3DTileset.maximumCacheOverflowBytes = CAPTURE_GOOGLE_MAX_CACHE_OVERFLOW_BYTES;
  }

  return snapshot;
}

/**
 * Restores `cacheBytes` and `maximumCacheOverflowBytes` saved by
 * `applyCaptureGoogleTilesetCache`.
 */
export function restoreCaptureGoogleTilesetCache(
  snapshot: CaptureTilesetCacheSnapshot | null
): void {
  if (!snapshot?.tileset) return;
  if (snapshot.cacheBytes !== null) {
    snapshot.tileset.cacheBytes = snapshot.cacheBytes;
  }
  if (snapshot.maximumCacheOverflowBytes !== null) {
    snapshot.tileset.maximumCacheOverflowBytes = snapshot.maximumCacheOverflowBytes;
  }
}

/**
 * Reads aggregate tileset streaming statistics (`numberOfPendingRequests`,
 * `numberOfTilesProcessing`) across all visible unique tilesets at capture time.
 */
export function readCaptureTilesetStats(
  viewer: any,
  extraTilesets: any[] = []
): ViewTileStatsSnapshot {
  const tilesets = collectUniqueTilesets(viewer, extraTilesets);
  let numberOfPendingRequests = 0;
  let numberOfTilesProcessing = 0;
  for (const ts of tilesets) {
    if (!ts || ts.show === false) continue;
    const stats = ts.statistics;
    if (!stats) continue;
    if (
      typeof stats.numberOfPendingRequests === 'number' &&
      Number.isFinite(stats.numberOfPendingRequests)
    ) {
      numberOfPendingRequests += stats.numberOfPendingRequests;
    }
    if (
      typeof stats.numberOfTilesProcessing === 'number' &&
      Number.isFinite(stats.numberOfTilesProcessing)
    ) {
      numberOfTilesProcessing += stats.numberOfTilesProcessing;
    }
  }
  return { numberOfPendingRequests, numberOfTilesProcessing };
}

/**
 * Applies deterministic training-mode scene overrides for Capture Bundle:
 * keeps `scene.fog.enabled = true` (so Cesium's fog-based distant tile culling and
 * SSE reduction stay active) while setting `scene.fog.renderable = false` (no visible
 * fog in pixels); turns off skyAtmosphere, sun, moon, skyBox, globe.enableLighting,
 * and shadows; keeps MSAA untouched; sets Google 3D and all loaded tilesets'
 * maximumScreenSpaceError to `maximumScreenSpaceError` (default 4); enables
 * `dynamicScreenSpaceError` on the Google 3D tileset.
 * Returns a snapshot used to restore every single setting in a `finally` block.
 */
export function applyTrainingModeSceneSettings(
  viewer: any,
  extraTilesets: any[] = [],
  options?: {
    maximumScreenSpaceError?: number;
    google3DTileset?: any;
  }
): TrainingModeSceneSnapshot {
  const scene = viewer?.scene;
  const targetSSE = parseTrainingModeSSE(options?.maximumScreenSpaceError ?? TRAINING_MODE_SSE);
  const snapshot: TrainingModeSceneSnapshot = {
    skyAtmosphereShow: null,
    fogEnabled: null,
    fogRenderable: null,
    sunShow: null,
    moonShow: null,
    skyBoxShow: null,
    globeEnableLighting: null,
    viewerShadows: null,
    shadowMapEnabled: null,
    googleDynamicScreenSpaceError: null,
    tilesets: [],
  };

  if (scene?.skyAtmosphere && typeof scene.skyAtmosphere.show === 'boolean') {
    snapshot.skyAtmosphereShow = scene.skyAtmosphere.show;
    scene.skyAtmosphere.show = false;
  }
  if (scene?.fog) {
    if (typeof scene.fog.enabled === 'boolean') {
      snapshot.fogEnabled = scene.fog.enabled;
      scene.fog.enabled = true;
    }
    if (typeof scene.fog.renderable === 'boolean') {
      snapshot.fogRenderable = scene.fog.renderable;
      scene.fog.renderable = false;
    } else {
      snapshot.fogRenderable = true;
      scene.fog.renderable = false;
    }
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

  const googleTs = options?.google3DTileset ?? null;
  if (googleTs && typeof googleTs === 'object') {
    snapshot.googleDynamicScreenSpaceError = {
      tileset: googleTs,
      value: Boolean(googleTs.dynamicScreenSpaceError),
    };
    googleTs.dynamicScreenSpaceError = true;
  }

  const allExtra = googleTs ? [googleTs, ...extraTilesets] : extraTilesets;
  const tilesets = collectUniqueTilesets(viewer, allExtra);
  for (const tileset of tilesets) {
    snapshot.tilesets.push({
      tileset,
      maximumScreenSpaceError: tileset.maximumScreenSpaceError,
    });
    tileset.maximumScreenSpaceError = targetSSE;
  }

  return snapshot;
}

/**
 * Restores every scene toggle, fog.enabled / fog.renderable, Google 3D
 * `dynamicScreenSpaceError`, and tileset `maximumScreenSpaceError` saved by
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
  if (snapshot.fogRenderable !== null && scene?.fog) {
    scene.fog.renderable = snapshot.fogRenderable;
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
  if (snapshot.googleDynamicScreenSpaceError?.tileset) {
    snapshot.googleDynamicScreenSpaceError.tileset.dynamicScreenSpaceError =
      snapshot.googleDynamicScreenSpaceError.value;
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
  trainingSSE?: number;
  google3DTileset?: any;
  extraTilesets?: any[];
  date?: string;
}): CaptureRenderSettingsDocument {
  const scene = options.viewer?.scene;
  const extra = options.google3DTileset
    ? [options.google3DTileset, ...(options.extraTilesets ?? [])]
    : (options.extraTilesets ?? []);
  const tilesets = collectUniqueTilesets(options.viewer, extra);
  const msaaSamples = typeof scene?.msaaSamples === 'number' ? scene.msaaSamples : null;
  const effectiveTrainingSSE = parseTrainingModeSSE(options.trainingSSE ?? TRAINING_MODE_SSE);
  const dynamicSSE = Boolean(options.google3DTileset?.dynamicScreenSpaceError);
  const cacheBytes =
    typeof options.google3DTileset?.cacheBytes === 'number'
      ? options.google3DTileset.cacheBytes
      : null;
  const maximumCacheOverflowBytes =
    typeof options.google3DTileset?.maximumCacheOverflowBytes === 'number'
      ? options.google3DTileset.maximumCacheOverflowBytes
      : null;
  const fogEnabled = Boolean(scene?.fog?.enabled);
  const fogRenderable = scene?.fog
    ? typeof scene.fog.renderable === 'boolean'
      ? scene.fog.renderable
      : true
    : false;

  return {
    schema: 'nodrone-render-settings/1.0',
    date: options.date ?? new Date().toISOString(),
    cesiumVersion: options.cesiumVersion || 'unknown',
    resolution: [options.resolution[0], options.resolution[1]],
    trainingMode: options.trainingMode,
    maximumScreenSpaceError: options.trainingMode ? effectiveTrainingSSE : options.currentSSE,
    dynamicScreenSpaceError: dynamicSSE,
    cacheBytes,
    maximumCacheOverflowBytes,
    tilesetCount: tilesets.length,
    toggles: {
      skyAtmosphere: Boolean(scene?.skyAtmosphere?.show),
      fogEnabled,
      fogRenderable,
      sun: Boolean(scene?.sun?.show),
      moon: Boolean(scene?.moon?.show),
      skyBox: Boolean(scene?.skyBox?.show),
      globeEnableLighting: Boolean(scene?.globe?.enableLighting),
      shadows: Boolean(options.viewer?.shadows || scene?.shadowMap?.enabled),
      dynamicScreenSpaceError: dynamicSSE,
      msaaSamples,
      splatOverlayComposited: !options.trainingMode,
      attributionBar: true,
      cleanRender: true,
    },
  };
}
