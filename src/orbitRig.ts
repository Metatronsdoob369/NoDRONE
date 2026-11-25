/**
 * Multi-Ring Site Orbit Planner & Drop-In 3DGS Trainer Exporters for NoDRONE.
 *
 * Pure TypeScript (zero DOM / Cesium runtime dependencies) so it can be verified
 * directly under Vitest with sub-pixel reprojection checks.
 *
 * - Supports quick preview rigs (12 / 24 + nadir) and dense multi-ring + close
 *   detail-ring site domes (72 / 150 / 317 frames matching orbit-plan-preview).
 * - Exports Nerfstudio / gsplat / Brush `transforms.json` (OpenGL c2w) and
 *   COLMAP `sparse/0/{cameras.txt, images.txt, points3D.txt}` (OpenCV w2c)
 *   from the exact same known ENU poses so COLMAP SfM can be skipped completely.
 */

import {
  extractRotation3x3,
  rotationMatrixToQuaternion,
  roundTo,
  type PinholeIntrinsics,
} from './geodesy';
import type { SurveySplatAnchor } from './types';

export type OrbitRingRole =
  | 'low-oblique'
  | 'mid-oblique'
  | 'high-oblique'
  | 'steep-oblique'
  | 'near-nadir'
  | 'nadir'
  | 'detail-ring';

export interface OrbitRingSpec {
  id: string;
  role: OrbitRingRole;
  elevationDeg: number;
  count: number;
  /** Multiplier applied to base standoff radius (e.g. 0.62 for close detail pass) */
  distanceScale: number;
  /** Azimuthal stagger in degrees so adjacent rings interleave cleanly */
  phaseOffsetDeg: number;
}

export interface OrbitPoseForTrainer {
  index: number;
  fileName: string;
  c2w_enu_zup_rowmajor: number[];
  c2w_enu_zup_opengl_rowmajor: number[];
  K: PinholeIntrinsics;
}

export interface NerfstudioTransformsFrame {
  file_path: string;
  transform_matrix: [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ];
}

export interface NerfstudioTransformsDocument {
  camera_model: 'OPENCV';
  w: number;
  h: number;
  fl_x: number;
  fl_y: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
  p1: number;
  p2: number;
  camera_angle_x: number;
  camera_angle_y: number;
  applied_scale: number;
  nodrone_meta: {
    site: string;
    world_frame: 'ENU_meters_Z_up';
    camera_convention: 'OpenGL_c2w';
    anchor_wgs84: SurveySplatAnchor;
    recommended_ns_train_flags: string;
  };
  frames: NerfstudioTransformsFrame[];
}

export interface ColmapSparseTextFiles {
  camerasTxt: string;
  imagesTxt: string;
  points3DTxt: string;
  pointCount: number;
}

/**
 * Returns the ring plan for a requested Geo-Box capture view preset.
 *
 * - `317`: Full 7-ring site dome + inner 40° detail ring (72 + 72 + 60 + 48 + 16 + 1 + 48 = 317)
 * - `150`: Medium 6-ring site dome + inner 40° detail ring (36 + 36 + 30 + 15 + 1 + 32 = 150)
 * - `72`:  Compact 5-ring site dome + inner 38° detail ring (24 + 20 + 11 + 1 + 16 = 72)
 * - `12` / `24` (or custom <= 36): Classic 2-ring oblique + 1 nadir (`count + 1` views)
 */
export function getOrbitRingSpecs(presetViews: number): OrbitRingSpec[] {
  const n = Math.max(4, Math.round(presetViews));

  if (n === 317) {
    return [
      { id: 'ring-0-20deg', role: 'low-oblique', elevationDeg: 20.0, count: 72, distanceScale: 1.0, phaseOffsetDeg: 0 },
      { id: 'ring-1-35deg', role: 'mid-oblique', elevationDeg: 35.0, count: 72, distanceScale: 1.0, phaseOffsetDeg: 2.5 },
      { id: 'ring-2-50deg', role: 'high-oblique', elevationDeg: 50.0, count: 60, distanceScale: 1.0, phaseOffsetDeg: 0 },
      { id: 'ring-3-65deg', role: 'steep-oblique', elevationDeg: 65.0, count: 48, distanceScale: 1.0, phaseOffsetDeg: 3.75 },
      { id: 'ring-4-80deg', role: 'near-nadir', elevationDeg: 80.0, count: 16, distanceScale: 1.0, phaseOffsetDeg: 0 },
      { id: 'ring-5-nadir', role: 'nadir', elevationDeg: 89.5, count: 1, distanceScale: 1.0, phaseOffsetDeg: 0 },
      { id: 'ring-6-detail-40deg', role: 'detail-ring', elevationDeg: 40.0, count: 48, distanceScale: 0.62, phaseOffsetDeg: 3.75 },
    ];
  }

  if (n === 150) {
    return [
      { id: 'ring-0-20deg', role: 'low-oblique', elevationDeg: 20.0, count: 36, distanceScale: 1.0, phaseOffsetDeg: 0 },
      { id: 'ring-1-35deg', role: 'mid-oblique', elevationDeg: 35.0, count: 36, distanceScale: 1.0, phaseOffsetDeg: 5.0 },
      { id: 'ring-2-52deg', role: 'high-oblique', elevationDeg: 52.0, count: 30, distanceScale: 1.0, phaseOffsetDeg: 0 },
      { id: 'ring-3-70deg', role: 'steep-oblique', elevationDeg: 70.0, count: 15, distanceScale: 1.0, phaseOffsetDeg: 12.0 },
      { id: 'ring-4-nadir', role: 'nadir', elevationDeg: 89.5, count: 1, distanceScale: 1.0, phaseOffsetDeg: 0 },
      { id: 'ring-5-detail-40deg', role: 'detail-ring', elevationDeg: 40.0, count: 32, distanceScale: 0.64, phaseOffsetDeg: 5.625 },
    ];
  }

  if (n === 72) {
    return [
      { id: 'ring-0-22deg', role: 'low-oblique', elevationDeg: 22.0, count: 24, distanceScale: 1.0, phaseOffsetDeg: 0 },
      { id: 'ring-1-48deg', role: 'high-oblique', elevationDeg: 48.0, count: 20, distanceScale: 1.0, phaseOffsetDeg: 9.0 },
      { id: 'ring-2-72deg', role: 'steep-oblique', elevationDeg: 72.0, count: 11, distanceScale: 1.0, phaseOffsetDeg: 0 },
      { id: 'ring-3-nadir', role: 'nadir', elevationDeg: 89.5, count: 1, distanceScale: 1.0, phaseOffsetDeg: 0 },
      { id: 'ring-4-detail-38deg', role: 'detail-ring', elevationDeg: 38.0, count: 16, distanceScale: 0.65, phaseOffsetDeg: 11.25 },
    ];
  }

  // Classic quick-preview 2-ring oblique + 1 nadir layout
  const lowCount = Math.max(4, Math.ceil(n * 0.55));
  const highCount = Math.max(4, n - lowCount);
  return [
    { id: 'ring-0-low', role: 'low-oblique', elevationDeg: 22.0, count: lowCount, distanceScale: 1.0, phaseOffsetDeg: 0 },
    { id: 'ring-1-high', role: 'high-oblique', elevationDeg: 48.0, count: highCount, distanceScale: 1.05, phaseOffsetDeg: 180 / highCount },
    { id: 'ring-2-nadir', role: 'nadir', elevationDeg: 88.0, count: 1, distanceScale: 1.12, phaseOffsetDeg: 0 },
  ];
}

export function getOrbitPresetSummary(presetViews: number): string {
  if (presetViews === 317) return '317 views · 7-ring dome + detail';
  if (presetViews === 150) return '150 views · 6-ring dome + detail';
  if (presetViews === 72) return '72 views · 5-ring dome + detail';
  const specs = getOrbitRingSpecs(presetViews);
  const total = specs.reduce((acc, r) => acc + r.count, 0);
  return `${total} views (${presetViews} + nadir)`;
}

function flat16ToNested4x4(
  m: number[]
): [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
] {
  return [
    [m[0], m[1], m[2], m[3]],
    [m[4], m[5], m[6], m[7]],
    [m[8], m[9], m[10], m[11]],
    [m[12], m[13], m[14], m[15]],
  ];
}

/**
 * Generates a Nerfstudio / gsplat / Brush compatible `transforms.json` directly from
 * NoDRONE's known ENU OpenGL camera-to-world matrices.
 */
export function buildNerfstudioTransformsJson(
  poses: OrbitPoseForTrainer[],
  options: {
    siteName: string;
    anchor: SurveySplatAnchor;
  }
): NerfstudioTransformsDocument {
  const firstK = poses[0]?.K ?? {
    fx: 1000,
    fy: 1000,
    cx: 640,
    cy: 360,
    width: 1280,
    height: 720,
    fov_v_deg: 40,
    fov_h_deg: 65,
  };

  const cameraAngleX = roundTo(2 * Math.atan(firstK.width / (2 * firstK.fx)), 8);
  const cameraAngleY = roundTo(2 * Math.atan(firstK.height / (2 * firstK.fy)), 8);

  return {
    camera_model: 'OPENCV',
    w: firstK.width,
    h: firstK.height,
    fl_x: roundTo(firstK.fx, 6),
    fl_y: roundTo(firstK.fy, 6),
    cx: roundTo(firstK.cx, 6),
    cy: roundTo(firstK.cy, 6),
    k1: 0,
    k2: 0,
    p1: 0,
    p2: 0,
    camera_angle_x: cameraAngleX,
    camera_angle_y: cameraAngleY,
    applied_scale: 1.0,
    nodrone_meta: {
      site: options.siteName,
      world_frame: 'ENU_meters_Z_up',
      camera_convention: 'OpenGL_c2w',
      anchor_wgs84: { ...options.anchor },
      recommended_ns_train_flags:
        'ns-train splatfacto nerfstudio-data --data . --orientation-method none --center-method none --auto-scale-poses False',
    },
    frames: poses.map((p) => ({
      file_path: p.fileName,
      transform_matrix: flat16ToNested4x4(p.c2w_enu_zup_opengl_rowmajor),
    })),
  };
}

/**
 * Inverts a rigid OpenCV camera-to-world 4x4 matrix into COLMAP world-to-camera
 * `(qw, qx, qy, qz, tx, ty, tz)`.
 */
export function openCvC2WToColmapW2C(c2w: number[]): {
  qw: number;
  qx: number;
  qy: number;
  qz: number;
  tx: number;
  ty: number;
  tz: number;
} {
  const R = extractRotation3x3(c2w);
  // Transpose of orthonormal R_c2w gives R_w2c
  const Rt: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ] = [
    [R[0][0], R[1][0], R[2][0]],
    [R[0][1], R[1][1], R[2][1]],
    [R[0][2], R[1][2], R[2][2]],
  ];

  const cx = c2w[3];
  const cy = c2w[7];
  const cz = c2w[11];

  const tx = -(Rt[0][0] * cx + Rt[0][1] * cy + Rt[0][2] * cz);
  const ty = -(Rt[1][0] * cx + Rt[1][1] * cy + Rt[1][2] * cz);
  const tz = -(Rt[2][0] * cx + Rt[2][1] * cy + Rt[2][2] * cz);

  const q = rotationMatrixToQuaternion(Rt);
  return {
    qw: roundTo(q.qw, 9),
    qx: roundTo(q.qx, 9),
    qy: roundTo(q.qy, 9),
    qz: roundTo(q.qz, 9),
    tx: roundTo(tx, 6),
    ty: roundTo(ty, 6),
    tz: roundTo(tz, 6),
  };
}

/**
 * Generates COLMAP `sparse/0/{cameras.txt, images.txt, points3D.txt}` text files
 * for Postshot, LichtFeld Studio, and vanilla 3DGS trainers without running SfM.
 *
 * `points3D.txt` seeds a deterministic metric point grid across the Geo-Box footprint
 * and 3D volume (`x in [-W/2, W/2], y in [-D/2, D/2], z in [0, H]`) so trainers
 * initialize cleanly inside the capture target.
 */
export function buildColmapSparseTextFiles(
  poses: OrbitPoseForTrainer[],
  boxDimensionsMeters: {
    widthMeters: number;
    depthMeters: number;
    heightMeters: number;
  },
  seedPointTarget = 1500
): ColmapSparseTextFiles {
  const firstK = poses[0]?.K ?? {
    fx: 1000,
    fy: 1000,
    cx: 640,
    cy: 360,
    width: 1280,
    height: 720,
    fov_v_deg: 40,
    fov_h_deg: 65,
  };

  const camerasTxt = [
    '# Camera list with one line of data per camera:',
    '#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]',
    '# Number of cameras: 1',
    `1 PINHOLE ${firstK.width} ${firstK.height} ${roundTo(firstK.fx, 6)} ${roundTo(firstK.fy, 6)} ${roundTo(firstK.cx, 6)} ${roundTo(firstK.cy, 6)}`,
    '',
  ].join('\n');

  const imageLines: string[] = [
    '# Image list with two lines of data per image:',
    '#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME',
    '#   POINTS2D[] as (X, Y, POINT3D_ID)',
    `# Number of images: ${poses.length}`,
  ];

  poses.forEach((p, idx) => {
    const id = idx + 1;
    const w2c = openCvC2WToColmapW2C(p.c2w_enu_zup_rowmajor);
    imageLines.push(
      `${id} ${w2c.qw} ${w2c.qx} ${w2c.qy} ${w2c.qz} ${w2c.tx} ${w2c.ty} ${w2c.tz} 1 ${p.fileName}`
    );
    imageLines.push('');
  });

  const imagesTxt = imageLines.join('\n') + '\n';

  // Deterministic stratified seed points inside the Geo-Box local ENU volume
  const w = Math.max(1, boxDimensionsMeters.widthMeters);
  const d = Math.max(1, boxDimensionsMeters.depthMeters);
  const h = Math.max(1, boxDimensionsMeters.heightMeters);

  // Split ~45% on the ground plane (z=0), ~55% distributed across the 3D volume
  const groundTarget = Math.max(16, Math.round(seedPointTarget * 0.45));
  const groundSide = Math.max(4, Math.round(Math.sqrt(groundTarget)));
  const volTarget = Math.max(27, seedPointTarget - groundSide * groundSide);
  const volSide = Math.max(3, Math.round(Math.cbrt(volTarget)));

  const pointLines: string[] = [
    '# 3D point list with one line of data per point:',
    '#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)',
  ];

  let ptId = 1;
  // Ground plane seed points
  for (let ix = 0; ix < groundSide; ix++) {
    const u = groundSide === 1 ? 0.5 : ix / (groundSide - 1);
    const x = roundTo((u - 0.5) * w, 4);
    for (let iy = 0; iy < groundSide; iy++) {
      const v = groundSide === 1 ? 0.5 : iy / (groundSide - 1);
      const y = roundTo((v - 0.5) * d, 4);
      pointLines.push(`${ptId} ${x} ${y} 0 156 156 156 0`);
      ptId += 1;
    }
  }

  // 3D interior/shell seed points
  for (let iz = 1; iz <= volSide; iz++) {
    const t = iz / volSide;
    const z = roundTo(t * h, 4);
    for (let ix = 0; ix < volSide; ix++) {
      const u = volSide === 1 ? 0.5 : ix / (volSide - 1);
      const x = roundTo((u - 0.5) * w, 4);
      for (let iy = 0; iy < volSide; iy++) {
        const v = volSide === 1 ? 0.5 : iy / (volSide - 1);
        const y = roundTo((v - 0.5) * d, 4);
        pointLines.push(`${ptId} ${x} ${y} ${z} 172 172 172 0`);
        ptId += 1;
      }
    }
  }

  const pointCount = ptId - 1;
  pointLines.splice(2, 0, `# Number of points: ${pointCount}`);

  return {
    camerasTxt,
    imagesTxt,
    points3DTxt: pointLines.join('\n') + '\n',
    pointCount,
  };
}
