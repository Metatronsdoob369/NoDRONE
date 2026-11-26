import { describe, expect, it } from 'vitest';
import {
  applyTrainingModeSceneSettings,
  buildCaptureRenderSettingsJson,
  restoreTrainingModeSceneSettings,
  TRAINING_MODE_SSE,
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

    // Held-out transforms reference heldout-local view filenames
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

      // camera_matrices.json intrinsics
      expect(poses[0].K.width).toBe(c.expected[0]);
      expect(poses[0].K.height).toBe(c.expected[1]);
      expect(poses[0].K.cx).toBeCloseTo(c.expected[0] / 2, 6);
      expect(poses[0].K.cy).toBeCloseTo(c.expected[1] / 2, 6);
      expect(poses[0].K.fx).toBeCloseTo(expectedK.fx, 6);
      expect(poses[0].K.fy).toBeCloseTo(expectedK.fy, 6);

      // transforms.json intrinsics
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

      // COLMAP sparse/0/cameras.txt intrinsics
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

describe('Capture Bundle Training mode toggles and render_settings.json', () => {
  it('applies Training mode toggles, leaves MSAA untouched, writes render_settings.json, and restores everything cleanly', () => {
    const googleTileset = { name: 'Google 3D', maximumScreenSpaceError: 8 };
    const siteTileset = { name: 'Wanek Site', maximumScreenSpaceError: 12 };
    const nonTilesetPrimitive = { name: 'PolylineCollection' };

    const viewer = {
      shadows: true,
      scene: {
        msaaSamples: 4,
        skyAtmosphere: { show: true },
        fog: { enabled: true },
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

    const snapshot = applyTrainingModeSceneSettings(viewer, [googleTileset]);

    // Every training-mode toggle is OFF during capture
    expect(viewer.scene.skyAtmosphere.show).toBe(false);
    expect(viewer.scene.fog.enabled).toBe(false);
    expect(viewer.scene.sun.show).toBe(false);
    expect(viewer.scene.moon.show).toBe(false);
    expect(viewer.scene.skyBox.show).toBe(false);
    expect(viewer.scene.globe.enableLighting).toBe(false);
    expect(viewer.shadows).toBe(false);
    expect(viewer.scene.shadowMap.enabled).toBe(false);

    // MSAA untouched
    expect(viewer.scene.msaaSamples).toBe(4);

    // Google 3D and all loaded tilesets set to SSE = 2
    expect(googleTileset.maximumScreenSpaceError).toBe(TRAINING_MODE_SSE);
    expect(siteTileset.maximumScreenSpaceError).toBe(TRAINING_MODE_SSE);

    // render_settings.json reflects active capture state accurately
    const settingsDoc = buildCaptureRenderSettingsJson({
      viewer,
      cesiumVersion: '1.124',
      resolution: [1920, 1080],
      trainingMode: true,
      currentSSE: 8,
      extraTilesets: [googleTileset],
      date: '2026-11-26T00:00:00.000Z',
    });
    expect(settingsDoc.cesiumVersion).toBe('1.124');
    expect(settingsDoc.resolution).toEqual([1920, 1080]);
    expect(settingsDoc.trainingMode).toBe(true);
    expect(settingsDoc.maximumScreenSpaceError).toBe(2);
    expect(settingsDoc.tilesetCount).toBe(2);
    expect(settingsDoc.date).toBe('2026-11-26T00:00:00.000Z');
    expect(settingsDoc.toggles).toEqual({
      skyAtmosphere: false,
      fog: false,
      sun: false,
      moon: false,
      skyBox: false,
      globeEnableLighting: false,
      shadows: false,
      msaaSamples: 4,
      splatOverlayComposited: false,
      attributionBar: true,
      cleanRender: true,
    });

    // Restore everything after capture
    restoreTrainingModeSceneSettings(viewer, snapshot);

    expect(viewer.scene.skyAtmosphere.show).toBe(true);
    expect(viewer.scene.fog.enabled).toBe(true);
    expect(viewer.scene.sun.show).toBe(true);
    expect(viewer.scene.moon.show).toBe(true);
    expect(viewer.scene.skyBox.show).toBe(true);
    expect(viewer.scene.globe.enableLighting).toBe(true);
    expect(viewer.shadows).toBe(true);
    expect(viewer.scene.shadowMap.enabled).toBe(true);
    expect(viewer.scene.msaaSamples).toBe(4);
    expect(googleTileset.maximumScreenSpaceError).toBe(8);
    expect(siteTileset.maximumScreenSpaceError).toBe(12);
  });
});
