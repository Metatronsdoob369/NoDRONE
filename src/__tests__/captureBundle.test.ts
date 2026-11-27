import { describe, expect, it } from 'vitest';
import {
  applyCaptureGoogleTilesetCache,
  applyTrainingModeSceneSettings,
  buildCaptureRenderSettingsJson,
  CAPTURE_GOOGLE_CACHE_BYTES,
  CAPTURE_GOOGLE_MAX_CACHE_OVERFLOW_BYTES,
  CAPTURE_NETWORK_IDLE_MS,
  CAPTURE_SETTLE_TIMEOUT_MS,
  DEFAULT_CAPTURE_SETTLE_TIMEOUT_MS,
  formatTimeoutWarningToast,
  getCaptureSettleTimeoutMs,
  parseTrainingModeSSE,
  readCaptureTilesetStats,
  restoreCaptureGoogleTilesetCache,
  restoreTrainingModeSceneSettings,
  settleViewWithRetry,
  TRAINING_MODE_SETTLE_TIMEOUT_MS,
  TRAINING_MODE_SSE,
  TRAINING_MODE_SSE_OPTIONS,
  waitForSceneSettle,
  type SettleReason,
} from '../captureBundleTraining';
import {
  buildLookAtC2W,
  computePinholeK,
  openCvToOpenGlC2W,
  roundTo,
} from '../geodesy';
import {
  angularSeparationDeg,
  buildColmapSparseTextFiles,
  buildNerfstudioTransformsJson,
  DEFAULT_HELDOUT_VIEW_COUNT,
  getHeldOutOrbitViews,
  getTrainingOrbitAngles,
  type OrbitPoseForTrainer,
} from '../orbitRig';
import { resolveEffectiveRenderResolution } from '../renderPathResolution';

function buildSyntheticTrainerPoses(
  angles: Array<{ azimuthDeg: number; elevationDeg: number; distanceScale: number }>,
  resolution: [number, number],
  filePrefix: string,
  fovyDeg = 37.85
): OrbitPoseForTrainer[] {
  const K = computePinholeK(resolution[0], resolution[1], fovyDeg);
  const standoff = 250;
  const target: [number, number, number] = [0, 0, 15];

  return angles.map((a, idx) => {
    const azRad = (a.azimuthDeg * Math.PI) / 180;
    const elRad = (a.elevationDeg * Math.PI) / 180;
    const range = standoff * a.distanceScale;
    const horiz = range * Math.cos(elRad);
    const cam: [number, number, number] = [
      roundTo(horiz * Math.sin(azRad), 6),
      roundTo(horiz * Math.cos(azRad), 6),
      roundTo(15 + range * Math.sin(elRad), 6),
    ];
    const c2wOpenCv = buildLookAtC2W(cam, target, 'opencv').map((v) => roundTo(v, 6));
    const c2wOpenGl = openCvToOpenGlC2W(c2wOpenCv).map((v) => roundTo(v, 6));
    return {
      index: idx + 1,
      fileName: `${filePrefix}view_${String(idx + 1).padStart(3, '0')}.png`,
      c2w_enu_zup_rowmajor: c2wOpenCv,
      c2w_enu_zup_opengl_rowmajor: c2wOpenGl,
      K,
    };
  });
}

function createFakeEvent<T extends any[] = []>() {
  const listeners = new Set<(...args: T) => void>();
  return {
    addEventListener(fn: (...args: T) => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    raise(...args: T) {
      for (const fn of listeners) fn(...args);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

describe('Capture Bundle held-out views', () => {
  const presets = [12, 24, 72, 150, 317];

  for (const preset of presets) {
    it(`generates ${DEFAULT_HELDOUT_VIEW_COUNT} held-out views with >= 3 deg separation from all training views (${preset}-view preset)`, () => {
      const training = getTrainingOrbitAngles(preset);
      const heldOut = getHeldOutOrbitViews(preset, DEFAULT_HELDOUT_VIEW_COUNT);

      expect(heldOut).toHaveLength(DEFAULT_HELDOUT_VIEW_COUNT);

      const minEl = Math.min(...training.map((t) => t.elevationDeg));
      const maxEl = Math.max(...training.map((t) => t.elevationDeg));

      let minSeparationOverall = Infinity;
      for (const hv of heldOut) {
        expect(hv.elevationDeg).toBeGreaterThan(minEl);
        expect(hv.elevationDeg).toBeLessThan(maxEl);

        for (const tv of training) {
          const sep = angularSeparationDeg(
            hv.azimuthDeg,
            hv.elevationDeg,
            tv.azimuthDeg,
            tv.elevationDeg
          );
          if (sep < minSeparationOverall) minSeparationOverall = sep;
          expect(sep).toBeGreaterThanOrEqual(3.0);
        }
      }

      expect(minSeparationOverall).toBeGreaterThanOrEqual(3.0);
    });
  }

  it('keeps held-out views strictly out of training transforms.json and COLMAP images.txt', () => {
    const resolution = resolveEffectiveRenderResolution({ pathJson: null, dropdownOverride: null });
    const trainingAngles = getTrainingOrbitAngles(72);
    const heldOutAngles = getHeldOutOrbitViews(72, DEFAULT_HELDOUT_VIEW_COUNT);

    const trainingPoses = buildSyntheticTrainerPoses(trainingAngles, resolution, 'frames/');
    const heldOutPoses = buildSyntheticTrainerPoses(heldOutAngles, resolution, '');

    const anchor = { lat: 35.9735, lon: -79.9949, baseHeightMeters: 250 };
    const trainingTransforms = buildNerfstudioTransformsJson(trainingPoses, {
      siteName: 'Wanek Center',
      anchor,
    });
    const colmap = buildColmapSparseTextFiles(trainingPoses, {
      widthMeters: 120,
      depthMeters: 90,
      heightMeters: 30,
    });
    const heldOutTransforms = buildNerfstudioTransformsJson(heldOutPoses, {
      siteName: 'Wanek Center',
      anchor,
    });

    expect(trainingTransforms.frames).toHaveLength(72);
    expect(heldOutTransforms.frames).toHaveLength(20);

    for (const frame of trainingTransforms.frames) {
      expect(frame.file_path.startsWith('frames/')).toBe(true);
      expect(frame.file_path).not.toContain('heldout');
    }
    expect(colmap.imagesTxt).not.toContain('heldout');
    const colmapImageLines = colmap.imagesTxt
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    expect(colmapImageLines).toHaveLength(72);

    expect(heldOutTransforms.frames[0].file_path).toBe('view_001.png');
    expect(heldOutTransforms.frames[19].file_path).toBe('view_020.png');
  });
});

describe('Capture Bundle intrinsics match effective Render Path resolution', () => {
  it('matches default 1920x1080 and 3840x2160 override across K, transforms.json, and COLMAP cameras.txt', () => {
    const cases: Array<{ override: [number, number] | null; expected: [number, number] }> = [
      { override: null, expected: [1920, 1080] },
      { override: [3840, 2160], expected: [3840, 2160] },
    ];

    const trainingAngles = getTrainingOrbitAngles(12);
    const anchor = { lat: 35.9735, lon: -79.9949, baseHeightMeters: 250 };

    for (const c of cases) {
      const res = resolveEffectiveRenderResolution({
        pathJson: null,
        dropdownOverride: c.override,
      });
      expect(res).toEqual(c.expected);

      const poses = buildSyntheticTrainerPoses(trainingAngles, res, 'frames/', 39.6);
      const expectedK = computePinholeK(res[0], res[1], 39.6);

      expect(poses[0].K.width).toBe(c.expected[0]);
      expect(poses[0].K.height).toBe(c.expected[1]);
      expect(poses[0].K.cx).toBeCloseTo(c.expected[0] / 2, 6);
      expect(poses[0].K.cy).toBeCloseTo(c.expected[1] / 2, 6);
      expect(poses[0].K.fx).toBeCloseTo(expectedK.fx, 6);
      expect(poses[0].K.fy).toBeCloseTo(expectedK.fy, 6);

      const transforms = buildNerfstudioTransformsJson(poses, {
        siteName: 'Wanek Center',
        anchor,
      });
      expect(transforms.w).toBe(c.expected[0]);
      expect(transforms.h).toBe(c.expected[1]);
      expect(transforms.cx).toBeCloseTo(c.expected[0] / 2, 6);
      expect(transforms.cy).toBeCloseTo(c.expected[1] / 2, 6);
      expect(transforms.fl_x).toBeCloseTo(expectedK.fx, 5);
      expect(transforms.fl_y).toBeCloseTo(expectedK.fy, 5);

      const colmap = buildColmapSparseTextFiles(poses, {
        widthMeters: 100,
        depthMeters: 80,
        heightMeters: 25,
      });
      const camLine = colmap.camerasTxt
        .split('\n')
        .find((line) => line.startsWith('1 PINHOLE '));
      expect(camLine).toBeDefined();
      const parts = camLine!.trim().split(/\s+/);
      expect(Number(parts[2])).toBe(c.expected[0]);
      expect(Number(parts[3])).toBe(c.expected[1]);
      expect(Number(parts[4])).toBeCloseTo(expectedK.fx, 5);
      expect(Number(parts[5])).toBeCloseTo(expectedK.fy, 5);
      expect(Number(parts[6])).toBeCloseTo(c.expected[0] / 2, 5);
      expect(Number(parts[7])).toBeCloseTo(c.expected[1] / 2, 5);
    }
  });
});

describe('Capture Bundle Training mode toggles, SSE dropdown, dynamicScreenSpaceError, and render_settings.json', () => {
  it('defaults Training mode SSE to 4 and supports 2 / 4 / 8 options', () => {
    expect(TRAINING_MODE_SSE).toBe(4);
    expect([...TRAINING_MODE_SSE_OPTIONS]).toEqual([2, 4, 8]);
    expect(parseTrainingModeSSE('2')).toBe(2);
    expect(parseTrainingModeSSE('4')).toBe(4);
    expect(parseTrainingModeSSE('8')).toBe(8);
    expect(parseTrainingModeSSE(undefined)).toBe(4);
    expect(parseTrainingModeSSE('16')).toBe(4);
  });

  it('applies Training mode toggles (fogEnabled=true, fogRenderable=false), raises Google 3D cache limits, enables dynamicScreenSpaceError, leaves MSAA untouched, writes render_settings.json, and restores everything cleanly', () => {
    const googleTileset = {
      name: 'Google 3D',
      maximumScreenSpaceError: 8,
      dynamicScreenSpaceError: false,
      cacheBytes: 512 * 1024 * 1024,
      maximumCacheOverflowBytes: 512 * 1024 * 1024,
    };
    const siteTileset = {
      name: 'Wanek Site',
      maximumScreenSpaceError: 12,
      dynamicScreenSpaceError: false,
    };
    const nonTilesetPrimitive = { name: 'PolylineCollection' };

    const viewer = {
      shadows: true,
      scene: {
        msaaSamples: 4,
        skyAtmosphere: { show: true },
        fog: { enabled: false, renderable: true },
        sun: { show: true },
        moon: { show: true },
        skyBox: { show: true },
        globe: { enableLighting: true },
        shadowMap: { enabled: true },
        primitives: {
          length: 3,
          get(index: number) {
            return [googleTileset, siteTileset, nonTilesetPrimitive][index];
          },
        },
      },
    };

    const cacheSnapshot = applyCaptureGoogleTilesetCache(googleTileset);
    const snapshot = applyTrainingModeSceneSettings(viewer, [googleTileset], {
      google3DTileset: googleTileset,
    });

    // Fog culling stays ON (fog.enabled = true), visible fog rendering turned OFF (fog.renderable = false)
    expect(viewer.scene.fog.enabled).toBe(true);
    expect(viewer.scene.fog.renderable).toBe(false);

    // Other visual toggles are OFF during capture
    expect(viewer.scene.skyAtmosphere.show).toBe(false);
    expect(viewer.scene.sun.show).toBe(false);
    expect(viewer.scene.moon.show).toBe(false);
    expect(viewer.scene.skyBox.show).toBe(false);
    expect(viewer.scene.globe.enableLighting).toBe(false);
    expect(viewer.shadows).toBe(false);
    expect(viewer.scene.shadowMap.enabled).toBe(false);

    // MSAA untouched
    expect(viewer.scene.msaaSamples).toBe(4);

    // Google 3D cache limits raised to 1.5 GB and 1 GB
    expect(googleTileset.cacheBytes).toBe(CAPTURE_GOOGLE_CACHE_BYTES);
    expect(googleTileset.maximumCacheOverflowBytes).toBe(CAPTURE_GOOGLE_MAX_CACHE_OVERFLOW_BYTES);

    // Google 3D and all loaded tilesets set to default SSE = 4; dynamicScreenSpaceError enabled on Google 3D
    expect(googleTileset.maximumScreenSpaceError).toBe(4);
    expect(siteTileset.maximumScreenSpaceError).toBe(4);
    expect(googleTileset.dynamicScreenSpaceError).toBe(true);
    expect(siteTileset.dynamicScreenSpaceError).toBe(false);

    // render_settings.json records fogEnabled/fogRenderable (not "fog"), cache limits, SSE=4, and dynamicScreenSpaceError=true
    const settingsDoc = buildCaptureRenderSettingsJson({
      viewer,
      cesiumVersion: '1.124',
      resolution: [1920, 1080],
      trainingMode: true,
      currentSSE: 8,
      trainingSSE: 4,
      google3DTileset: googleTileset,
      extraTilesets: [googleTileset],
      date: '2026-11-26T00:00:00.000Z',
    });
    expect(settingsDoc.cesiumVersion).toBe('1.124');
    expect(settingsDoc.resolution).toEqual([1920, 1080]);
    expect(settingsDoc.trainingMode).toBe(true);
    expect(settingsDoc.maximumScreenSpaceError).toBe(4);
    expect(settingsDoc.dynamicScreenSpaceError).toBe(true);
    expect(settingsDoc.cacheBytes).toBe(CAPTURE_GOOGLE_CACHE_BYTES);
    expect(settingsDoc.maximumCacheOverflowBytes).toBe(CAPTURE_GOOGLE_MAX_CACHE_OVERFLOW_BYTES);
    expect(settingsDoc.tilesetCount).toBe(2);
    expect(settingsDoc.date).toBe('2026-11-26T00:00:00.000Z');
    expect('fog' in settingsDoc.toggles).toBe(false);
    expect(settingsDoc.toggles).toEqual({
      skyAtmosphere: false,
      fogEnabled: true,
      fogRenderable: false,
      sun: false,
      moon: false,
      skyBox: false,
      globeEnableLighting: false,
      shadows: false,
      dynamicScreenSpaceError: true,
      msaaSamples: 4,
      splatOverlayComposited: false,
      attributionBar: true,
      cleanRender: true,
    });

    // Restore everything after capture (including original fog.enabled=false, fog.renderable=true, and cacheBytes)
    restoreTrainingModeSceneSettings(viewer, snapshot);
    restoreCaptureGoogleTilesetCache(cacheSnapshot);

    expect(viewer.scene.skyAtmosphere.show).toBe(true);
    expect(viewer.scene.fog.enabled).toBe(false);
    expect(viewer.scene.fog.renderable).toBe(true);
    expect(viewer.scene.sun.show).toBe(true);
    expect(viewer.scene.moon.show).toBe(true);
    expect(viewer.scene.skyBox.show).toBe(true);
    expect(viewer.scene.globe.enableLighting).toBe(true);
    expect(viewer.shadows).toBe(true);
    expect(viewer.scene.shadowMap.enabled).toBe(true);
    expect(viewer.scene.msaaSamples).toBe(4);
    expect(googleTileset.maximumScreenSpaceError).toBe(8);
    expect(googleTileset.dynamicScreenSpaceError).toBe(false);
    expect(googleTileset.cacheBytes).toBe(512 * 1024 * 1024);
    expect(googleTileset.maximumCacheOverflowBytes).toBe(512 * 1024 * 1024);
    expect(siteTileset.maximumScreenSpaceError).toBe(12);
  });

  it('reads perViewTileStats (numberOfPendingRequests, numberOfTilesProcessing) across visible unique tilesets', () => {
    const googleTileset = {
      show: true,
      maximumScreenSpaceError: 4,
      statistics: { numberOfPendingRequests: 5, numberOfTilesProcessing: 2 },
    };
    const siteTileset = {
      show: true,
      maximumScreenSpaceError: 4,
      statistics: { numberOfPendingRequests: 3, numberOfTilesProcessing: 1 },
    };
    const hiddenTileset = {
      show: false,
      maximumScreenSpaceError: 4,
      statistics: { numberOfPendingRequests: 99, numberOfTilesProcessing: 44 },
    };
    const viewer = {
      scene: {
        primitives: [googleTileset, siteTileset, hiddenTileset],
      },
    };

    // Passing googleTileset again in extraTilesets must NOT double-count it
    expect(readCaptureTilesetStats(viewer, [googleTileset])).toEqual({
      numberOfPendingRequests: 8,
      numberOfTilesProcessing: 3,
    });
  });

  it('applies custom Training mode SSE=8 from dropdown and records it in render_settings.json', () => {
    const googleTileset = {
      maximumScreenSpaceError: 16,
      dynamicScreenSpaceError: false,
      cacheBytes: 512 * 1024 * 1024,
      maximumCacheOverflowBytes: 512 * 1024 * 1024,
    };
    const viewer = { scene: { msaaSamples: 4, fog: { enabled: true, renderable: true }, primitives: [googleTileset] } };

    const cacheSnap = applyCaptureGoogleTilesetCache(googleTileset);
    const snap = applyTrainingModeSceneSettings(viewer, [googleTileset], {
      maximumScreenSpaceError: 8,
      google3DTileset: googleTileset,
    });
    expect(googleTileset.maximumScreenSpaceError).toBe(8);
    expect(googleTileset.dynamicScreenSpaceError).toBe(true);
    expect(viewer.scene.fog.enabled).toBe(true);
    expect(viewer.scene.fog.renderable).toBe(false);

    const doc = buildCaptureRenderSettingsJson({
      viewer,
      cesiumVersion: '1.124',
      resolution: [1920, 1080],
      trainingMode: true,
      currentSSE: 16,
      trainingSSE: 8,
      google3DTileset: googleTileset,
    });
    expect(doc.maximumScreenSpaceError).toBe(8);
    expect(doc.dynamicScreenSpaceError).toBe(true);
    expect(doc.cacheBytes).toBe(CAPTURE_GOOGLE_CACHE_BYTES);
    expect(doc.maximumCacheOverflowBytes).toBe(CAPTURE_GOOGLE_MAX_CACHE_OVERFLOW_BYTES);
    expect(doc.toggles.fogEnabled).toBe(true);
    expect(doc.toggles.fogRenderable).toBe(false);

    restoreTrainingModeSceneSettings(viewer, snap);
    restoreCaptureGoogleTilesetCache(cacheSnap);
    expect(googleTileset.maximumScreenSpaceError).toBe(16);
    expect(googleTileset.dynamicScreenSpaceError).toBe(false);
    expect(googleTileset.cacheBytes).toBe(512 * 1024 * 1024);
    expect(googleTileset.maximumCacheOverflowBytes).toBe(512 * 1024 * 1024);
    expect(viewer.scene.fog.enabled).toBe(true);
    expect(viewer.scene.fog.renderable).toBe(true);
  });
});

describe('Universal settle rule (tilesLoaded 2x OR 3s network idle OR 60s hard ceiling + retry) & settledBy', () => {
  it('uses 60s max timeout and 3s network idle threshold for ALL capture modes', () => {
    expect(CAPTURE_SETTLE_TIMEOUT_MS).toBe(60000);
    expect(CAPTURE_NETWORK_IDLE_MS).toBe(3000);
    expect(TRAINING_MODE_SETTLE_TIMEOUT_MS).toBe(60000);
    expect(DEFAULT_CAPTURE_SETTLE_TIMEOUT_MS).toBe(60000);
    expect(getCaptureSettleTimeoutMs(true)).toBe(60000);
    expect(getCaptureSettleTimeoutMs(false)).toBe(60000);
    expect(getCaptureSettleTimeoutMs()).toBe(60000);
  });

  it('settles immediately with settledBy="tilesLoaded" when tilesLoaded passes 2 consecutive frames', async () => {
    let clockMs = 0;
    let tick = 0;
    const tileLoad = createFakeEvent();
    const tileset = {
      show: true,
      tileLoad,
      statistics: { numberOfPendingRequests: 0, numberOfTilesProcessing: 0, numberOfLoadedTilesTotal: 10 },
    };

    const result = await waitForSceneSettle({
      now: () => clockMs,
      scheduleNextFrame: (cb) => {
        clockMs += 16;
        queueMicrotask(cb);
      },
      renderFrame: () => {
        tick += 1;
      },
      areTilesLoaded: () => tick >= 2, // frame 1 false, frames 2 & 3 true -> settles at frame 3
      getTilesets: () => [tileset],
    });

    expect(result).toEqual({
      timedOut: false,
      waitMs: 48,
      cancelled: false,
      settledBy: 'tilesLoaded',
    });
    expect(tileLoad.listenerCount).toBe(0); // listeners cleaned up
  });

  it('settles with settledBy="idle" after 3 consecutive seconds with no tile starting or finishing loading, resetting timer on activity', async () => {
    let clockMs = 0;
    const tileLoad = createFakeEvent();
    const loadProgress = createFakeEvent<[number, number]>();
    const tileset = {
      show: true,
      tileLoad,
      loadProgress,
      statistics: { numberOfPendingRequests: 3, numberOfTilesProcessing: 0, numberOfLoadedTilesTotal: 20 },
    };

    const result = await waitForSceneSettle({
      timeoutMs: 60000,
      idleMs: 3000,
      now: () => clockMs,
      scheduleNextFrame: (cb) => {
        clockMs += 500;
        queueMicrotask(cb);
      },
      renderFrame: () => {
        // Tile finishes loading at 1500ms, another starts at 2500ms -> idle timer resets to 2500ms.
        // Repeated identical loadProgress(4, 0) at 4000ms does NOT reset the idle timer.
        if (clockMs === 1500) {
          tileset.statistics.numberOfLoadedTilesTotal = 21;
          tileLoad.raise();
        } else if (clockMs === 2500) {
          tileset.statistics.numberOfPendingRequests = 4;
          loadProgress.raise(4, 0);
        } else if (clockMs === 4000) {
          // Same counts (stalled request) -> no tile started or finished
          loadProgress.raise(4, 0);
        }
      },
      areTilesLoaded: () => false,
      getTilesets: () => [tileset],
    });

    // Last real tile activity was at 2500ms, so 3000ms later = 5500ms
    expect(result).toEqual({
      timedOut: false,
      waitMs: 5500,
      cancelled: false,
      settledBy: 'idle',
    });
    expect(tileLoad.listenerCount).toBe(0);
    expect(loadProgress.listenerCount).toBe(0);
  });

  it('hits settledBy="timeout" at 60s when tiles keep loading continuously without ever idling for 3s', async () => {
    let clockMs = 0;
    const tileLoad = createFakeEvent();
    const tileset = {
      show: true,
      tileLoad,
      statistics: { numberOfPendingRequests: 2, numberOfTilesProcessing: 1, numberOfLoadedTilesTotal: 0 },
    };

    const result = await waitForSceneSettle({
      timeoutMs: 60000,
      idleMs: 3000,
      now: () => clockMs,
      scheduleNextFrame: (cb) => {
        clockMs += 1000;
        queueMicrotask(cb);
      },
      renderFrame: () => {
        // Every 1s a tile finishes, so network never goes idle for 3s, and tilesLoaded stays false
        tileset.statistics.numberOfLoadedTilesTotal += 1;
        tileLoad.raise();
      },
      areTilesLoaded: () => false,
      getTilesets: () => [tileset],
    });

    expect(result).toEqual({
      timedOut: true,
      waitMs: 60000,
      cancelled: false,
      settledBy: 'timeout',
    });
    expect(tileLoad.listenerCount).toBe(0);
  });

  it('does not retry on tilesLoaded or idle, retries once on timeout, and records accurate settledBy and timedOut lists', async () => {
    const viewFiles = [
      'frames/view_001.png', // settles via tilesLoaded
      'frames/view_002.png', // settles via 3s network idle (no retry!)
      'frames/view_003.png', // times out once, then settles via idle on retry
      'frames/view_004.png', // times out twice -> kept & logged in timedOutViews with settledBy="timeout"
      'heldout/view_001.png', // held-out settles via idle
    ];

    const outcomesByView: Record<
      string,
      Array<{ timedOut: boolean; waitMs: number; cancelled: boolean; settledBy: SettleReason }>
    > = {
      'frames/view_001.png': [
        { timedOut: false, waitMs: 180, cancelled: false, settledBy: 'tilesLoaded' },
      ],
      'frames/view_002.png': [
        { timedOut: false, waitMs: 4500, cancelled: false, settledBy: 'idle' },
      ],
      'frames/view_003.png': [
        { timedOut: true, waitMs: 60000, cancelled: false, settledBy: 'timeout' },
        { timedOut: false, waitMs: 7200, cancelled: false, settledBy: 'idle' },
      ],
      'frames/view_004.png': [
        { timedOut: true, waitMs: 60000, cancelled: false, settledBy: 'timeout' },
        { timedOut: true, waitMs: 60000, cancelled: false, settledBy: 'timeout' },
      ],
      'heldout/view_001.png': [
        { timedOut: false, waitMs: 3900, cancelled: false, settledBy: 'idle' },
      ],
    };

    const setViewCallsByView: Record<string, number> = {};
    const observedTimeouts: number[] = [];
    const trainingSettledBy: SettleReason[] = [];
    const trainingTimedOutViews: string[] = [];
    const heldOutSettledBy: SettleReason[] = [];
    const heldOutTimedOutViews: string[] = [];

    for (const fileName of viewFiles) {
      setViewCallsByView[fileName] = 0;
      let attemptIdx = 0;

      const result = await settleViewWithRetry({
        trainingMode: false,
        placeCamera: () => {
          setViewCallsByView[fileName] += 1;
        },
        waitForSettle: async (timeoutMs) => {
          observedTimeouts.push(timeoutMs);
          return outcomesByView[fileName][attemptIdx++];
        },
      });

      if (fileName.startsWith('heldout/')) {
        heldOutSettledBy.push(result.settledBy);
        if (result.timedOut) heldOutTimedOutViews.push(fileName);
      } else {
        trainingSettledBy.push(result.settledBy);
        if (result.timedOut) trainingTimedOutViews.push(fileName);
      }
    }

    expect(observedTimeouts.every((ms) => ms === 60000)).toBe(true);
    expect(setViewCallsByView).toEqual({
      'frames/view_001.png': 1,
      'frames/view_002.png': 1,
      'frames/view_003.png': 2,
      'frames/view_004.png': 2,
      'heldout/view_001.png': 1,
    });
    expect(trainingSettledBy).toEqual(['tilesLoaded', 'idle', 'idle', 'timeout']);
    expect(trainingTimedOutViews).toEqual(['frames/view_004.png']);
    expect(heldOutSettledBy).toEqual(['idle']);
    expect(heldOutTimedOutViews).toEqual([]);
  });

  it('tracks Render Path timedOutFrames and settledBy with 60s timeout + single retry', async () => {
    const frames = ['frame_00001.jpg', 'frame_00002.jpg', 'frame_00003.jpg'];
    const outcomes: Record<
      string,
      Array<{ timedOut: boolean; waitMs: number; cancelled: boolean; settledBy: SettleReason }>
    > = {
      'frame_00001.jpg': [{ timedOut: false, waitMs: 95, cancelled: false, settledBy: 'tilesLoaded' }],
      'frame_00002.jpg': [
        { timedOut: true, waitMs: 60000, cancelled: false, settledBy: 'timeout' },
        { timedOut: false, waitMs: 3200, cancelled: false, settledBy: 'idle' },
      ],
      'frame_00003.jpg': [
        { timedOut: true, waitMs: 60000, cancelled: false, settledBy: 'timeout' },
        { timedOut: true, waitMs: 60000, cancelled: false, settledBy: 'timeout' },
      ],
    };

    const timedOutFrames: string[] = [];
    const settledBy: SettleReason[] = [];

    for (const frameFileName of frames) {
      let attempt = 0;
      const settle = await settleViewWithRetry({
        placeCamera: () => {},
        waitForSettle: async () => outcomes[frameFileName][attempt++],
      });
      settledBy.push(settle.settledBy);
      if (settle.timedOut) timedOutFrames.push(frameFileName);
    }

    expect(settledBy).toEqual(['tilesLoaded', 'idle', 'timeout']);
    expect(timedOutFrames).toEqual(['frame_00003.jpg']);
  });

  it('does not retry when cancelled on the first settle attempt', async () => {
    let placeCalls = 0;
    let waitCalls = 0;

    const result = await settleViewWithRetry({
      trainingMode: false,
      placeCamera: () => {
        placeCalls += 1;
      },
      waitForSettle: async (timeoutMs) => {
        waitCalls += 1;
        expect(timeoutMs).toBe(60000);
        return { timedOut: false, waitMs: 300, cancelled: true, settledBy: 'timeout' };
      },
    });

    expect(placeCalls).toBe(1);
    expect(waitCalls).toBe(1);
    expect(result).toEqual({
      timedOut: false,
      waitMs: 300,
      cancelled: true,
      settledBy: 'timeout',
      retried: false,
      attempts: 1,
    });
  });

  it('formats warning toast messages with counts only when timeouts > 0', () => {
    expect(formatTimeoutWarningToast(0, 'frame')).toBeNull();
    expect(formatTimeoutWarningToast(0, 'view')).toBeNull();
    expect(formatTimeoutWarningToast(1, 'frame')).toBe(
      'Warning: 1 frame timed out after retry (saved; listed in render-log.json).'
    );
    expect(formatTimeoutWarningToast(3, 'frame')).toBe(
      'Warning: 3 frames timed out after retry (saved; listed in render-log.json).'
    );
    expect(formatTimeoutWarningToast(2, 'view')).toBe(
      'Warning: 2 views timed out after retry (saved; listed in render-log.json).'
    );
    expect(formatTimeoutWarningToast(1, 'snapshot')).toBe(
      'Warning: 1 snapshot timed out after retry (tiles may be incomplete).'
    );
  });
});
