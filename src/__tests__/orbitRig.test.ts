import { describe, expect, it } from 'vitest';
import {
  buildLookAtC2W,
  computePinholeK,
  openCvToOpenGlC2W,
} from '../geodesy';
import {
  buildColmapSparseTextFiles,
  buildNerfstudioTransformsJson,
  getOrbitPresetSummary,
  getOrbitRingSpecs,
  openCvC2WToColmapW2C,
  type OrbitPoseForTrainer,
} from '../orbitRig';
import { normalizeSiteManifest } from '../surveyCatalog';

function quatToRot3x3(qw: number, qx: number, qy: number, qz: number): number[][] {
  return [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
    [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
    [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
  ];
}

function projectColmapPixel(
  worldPt: [number, number, number],
  w2c: { qw: number; qx: number; qy: number; qz: number; tx: number; ty: number; tz: number },
  K: { fx: number; fy: number; cx: number; cy: number }
): [number, number] {
  const R = quatToRot3x3(w2c.qw, w2c.qx, w2c.qy, w2c.qz);
  const xc = R[0][0] * worldPt[0] + R[0][1] * worldPt[1] + R[0][2] * worldPt[2] + w2c.tx;
  const yc = R[1][0] * worldPt[0] + R[1][1] * worldPt[1] + R[1][2] * worldPt[2] + w2c.ty;
  const zc = R[2][0] * worldPt[0] + R[2][1] * worldPt[1] + R[2][2] * worldPt[2] + w2c.tz;
  return [(K.fx * xc) / zc + K.cx, (K.fy * yc) / zc + K.cy];
}

function projectOpenGlTransformPixel(
  worldPt: [number, number, number],
  c2wGl: number[][],
  K: { fx: number; fy: number; cx: number; cy: number }
): [number, number] {
  // Invert rigid OpenGL c2w: p_cam_gl = R^T * (p_world - t)
  const dx = worldPt[0] - c2wGl[0][3];
  const dy = worldPt[1] - c2wGl[1][3];
  const dz = worldPt[2] - c2wGl[2][3];
  const xGl = c2wGl[0][0] * dx + c2wGl[1][0] * dy + c2wGl[2][0] * dz;
  const yGl = c2wGl[0][1] * dx + c2wGl[1][1] * dy + c2wGl[2][1] * dz;
  const zGl = c2wGl[0][2] * dx + c2wGl[1][2] * dy + c2wGl[2][2] * dz;
  // Convert OpenGL camera (x right, y up, -z forward) to OpenCV pixel projection
  const xc = xGl;
  const yc = -yGl;
  const zc = -zGl;
  return [(K.fx * xc) / zc + K.cx, (K.fy * yc) / zc + K.cy];
}

describe('Multi-ring orbit rig planner', () => {
  it('generates the exact 317-frame 7-ring site dome + inner 40 deg detail ring', () => {
    const specs = getOrbitRingSpecs(317);
    expect(specs).toHaveLength(7);
    const total = specs.reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(317);
    expect(specs.map((r) => r.count)).toEqual([72, 72, 60, 48, 16, 1, 48]);
    expect(specs.map((r) => r.elevationDeg)).toEqual([20, 35, 50, 65, 80, 89.5, 40]);

    const detailRing = specs.find((r) => r.role === 'detail-ring');
    expect(detailRing).toBeDefined();
    expect(detailRing!.distanceScale).toBeLessThan(0.7);
    expect(getOrbitPresetSummary(317)).toContain('317');
  });

  it('generates exact 150-frame and 72-frame multi-ring presets with detail rings', () => {
    const r150 = getOrbitRingSpecs(150);
    expect(r150.reduce((sum, r) => sum + r.count, 0)).toBe(150);
    expect(r150.some((r) => r.role === 'detail-ring')).toBe(true);

    const r72 = getOrbitRingSpecs(72);
    expect(r72.reduce((sum, r) => sum + r.count, 0)).toBe(72);
    expect(r72.some((r) => r.role === 'detail-ring')).toBe(true);
  });

  it('preserves classic 2-ring + nadir layout for 12 and 24 presets', () => {
    const r12 = getOrbitRingSpecs(12);
    expect(r12.reduce((sum, r) => sum + r.count, 0)).toBe(13);
    const r24 = getOrbitRingSpecs(24);
    expect(r24.reduce((sum, r) => sum + r.count, 0)).toBe(25);
  });
});

describe('Trainer pose consistency: transforms.json (OpenGL) vs COLMAP sparse/0 (OpenCV)', () => {
  it('reprojects arbitrary 3D ENU world points to the exact same pixels across both formats', () => {
    const K = computePinholeK(1280, 720, 42);
    const target: [number, number, number] = [0, 0, 12];
    const camPos: [number, number, number] = [65, -40, 52];
    const c2wOpenCv = buildLookAtC2W(camPos, target, 'opencv');
    const c2wOpenGl = openCvToOpenGlC2W(c2wOpenCv);

    const poses: OrbitPoseForTrainer[] = [
      {
        index: 1,
        fileName: 'frames/view_001.png',
        c2w_enu_zup_rowmajor: c2wOpenCv,
        c2w_enu_zup_opengl_rowmajor: c2wOpenGl,
        K,
      },
    ];

    const transforms = buildNerfstudioTransformsJson(poses, {
      siteName: 'Test Site',
      anchor: { lat: 38.627, lon: -90.199, baseHeightMeters: 140 },
    });
    const colmap = buildColmapSparseTextFiles(poses, {
      widthMeters: 40,
      depthMeters: 30,
      heightMeters: 24,
    });

    expect(transforms.camera_model).toBe('OPENCV');
    expect(transforms.frames).toHaveLength(1);
    expect(colmap.camerasTxt).toContain(`1 PINHOLE ${K.width} ${K.height}`);
    expect(colmap.imagesTxt).toContain('frames/view_001.png');
    expect(colmap.pointCount).toBeGreaterThan(500);

    const w2c = openCvC2WToColmapW2C(c2wOpenCv);
    const testPoints: Array<[number, number, number]> = [
      [0, 0, 12],
      [8.5, -4.2, 18.0],
      [-11.0, 7.5, 2.0],
    ];

    for (const pt of testPoints) {
      const [uCol, vCol] = projectColmapPixel(pt, w2c, K);
      const [uGl, vGl] = projectOpenGlTransformPixel(pt, transforms.frames[0].transform_matrix, K);
      expect(Math.abs(uCol - uGl)).toBeLessThan(1e-3);
      expect(Math.abs(vCol - vGl)).toBeLessThan(1e-3);
    }

    // Target point should land dead-center at principal point (cx, cy)
    const [uCenter, vCenter] = projectColmapPixel(target, w2c, K);
    expect(Math.abs(uCenter - K.cx)).toBeLessThan(1e-3);
    expect(Math.abs(vCenter - K.cy)).toBeLessThan(1e-3);
  });
});

describe('Survey catalog splat alignment persistence', () => {
  it('round-trips originMode and upAxis through normalizeSiteManifest with safe defaults', () => {
    const raw = {
      schemaVersion: '2.0',
      siteId: 'site-test',
      title: 'Test Site',
      surveys: [
        {
          surveyId: '2026-11-24-site-splat',
          capturedAt: '2026-11-24',
          label: 'Site Splat',
          status: 'captured',
          assets: {
            splat: {
              url: 'https://example.com/site.spz',
              originMode: 'enu-origin',
              upAxis: 'z-up',
            },
            tilesets: [],
          },
          bookmarks: [],
          paths: [],
        },
        {
          surveyId: '2026-11-23-object-splat',
          capturedAt: '2026-11-23',
          label: 'Bench Splat',
          status: 'captured',
          assets: {
            splat: {
              url: 'https://example.com/bench.spz',
            },
            tilesets: [],
          },
          bookmarks: [],
          paths: [],
        },
      ],
    };

    const { manifest } = normalizeSiteManifest(raw);
    const siteSurvey = manifest.surveys.find((s) => s.surveyId === '2026-11-24-site-splat');
    const objSurvey = manifest.surveys.find((s) => s.surveyId === '2026-11-23-object-splat');

    expect(siteSurvey?.assets.splat?.originMode).toBe('enu-origin');
    expect(siteSurvey?.assets.splat?.upAxis).toBe('z-up');
    expect(objSurvey?.assets.splat?.originMode).toBe('auto-ground');
    expect(objSurvey?.assets.splat?.upAxis).toBe('y-up');
  });
});
