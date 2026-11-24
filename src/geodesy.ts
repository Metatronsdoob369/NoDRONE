/**
 * Verified Geodetic & Camera Pose Engine for NoDRONE
 *
 * Ports verified Flyover / Google Earth Studio (GES) WGS84 <-> ECEF <-> ENU
 * transformations, pinhole intrinsics, OpenCV/OpenGL 4x4 camera-to-world matrices,
 * Shepperd's quaternion extraction, and Blender 6-DoF trajectory generation.
 *
 * Scope: Visual cinematography, camera pose export, and spatial registration only.
 * Not for quotable measurements (quotable: false).
 */

export const WGS84_A = 6378137.0; // Semi-major axis (meters)
export const WGS84_F = 1.0 / 298.257223563; // Flattening
export const WGS84_E2 = 2.0 * WGS84_F - WGS84_F * WGS84_F; // First eccentricity squared

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];
export type CameraConvention = 'opencv' | 'opengl';

export interface GeodeticPoint {
  lat: number;
  lon: number;
  alt: number;
}

export interface EnuPoint {
  e: number;
  n: number;
  u: number;
}

export interface UnitQuaternion {
  qw: number;
  qx: number;
  qy: number;
  qz: number;
}

export interface PinholeIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  fov_vertical_deg: number;
}

export interface FlyoverAnchor {
  name: string;
  role: 'origin' | 'anchor' | 'ref';
  lat: string | number;
  lon: string | number;
  elev_m: number;
  es_alt?: number;
  note?: string;
}

export interface AnchorEnu {
  name: string;
  E: number;
  N: number;
  U: number;
}

export interface CameraMatrixFrame {
  frame: number;
  time_s: number;
  c2w_enu_zup_rowmajor: number[];
  K: PinholeIntrinsics;
  lat: number;
  lon: number;
  alt_asl_m: number;
}

export interface CameraMatricesDocument {
  name: string;
  frames_count: number;
  fps: number;
  quotable: false;
  conventions: {
    world: string;
    camera: string;
    matrix: string;
    intrinsics: string;
    source: string;
  };
  verification: {
    max_forward_error_deg_vs_camera_target: number;
    max_roll_deg: number;
    max_position_diff_m_es_vs_latlon: number;
  };
  anchors_enu: AnchorEnu[];
  frames: CameraMatrixFrame[];
}

export interface BlenderTrajectoryFrame {
  frame: number;
  x_enu: number;
  y_enu: number;
  z_enu: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface BlenderTrajectoryDocument {
  site: string;
  convention: 'opencv';
  fps: number;
  quotable: false;
  world: string;
  camera: string;
  blender_focal_mm: number;
  sensor_width_mm: number;
  resolution: [number, number];
  trajectory: BlenderTrajectoryFrame[];
}

export interface CesiumCameraSample {
  t: number;
  lat: number;
  lon: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
  fovyDeg: number;
}

export interface GesConversionOptions {
  origin?: {
    name?: string;
    lat: number;
    lon: number;
    alt: number;
  };
  anchors?: FlyoverAnchor[];
  targetAglM?: number;
  useEllipsoidal?: boolean;
  convention?: CameraConvention;
}

export interface GesConversionResult {
  name: string;
  width: number;
  height: number;
  fps: number;
  origin: GeodeticPoint & { name: string };
  blenderFocalMm: number;
  cameraMatrices: CameraMatricesDocument;
  trajectory: BlenderTrajectoryDocument;
  cesiumSamples: CesiumCameraSample[];
}

const DEG_TO_RAD = Math.PI / 180.0;
const RAD_TO_DEG = 180.0 / Math.PI;

export function degToRad(deg: number): number {
  return deg * DEG_TO_RAD;
}

export function radToDeg(rad: number): number {
  return rad * RAD_TO_DEG;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Matches Flyover `dec7`: published 7-decimal origin coordinate precision (~1.1 cm).
 */
export function round7(value: number): number {
  return roundTo(value, 7);
}

/**
 * Parses decimal degrees or DMS strings (e.g. `35°28'08.71"N`, `80°06'09.18"W`).
 */
export function parseLatLon(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`Invalid coordinate number: ${input}`);
    return input;
  }
  const trimmed = String(input).trim();
  const asNum = Number(trimmed);
  if (trimmed.length > 0 && Number.isFinite(asNum)) {
    return asNum;
  }
  const match = trimmed.match(/^\s*(\d+)[°\s]+(\d+)['′\s]+([\d.]+)["″\s]*([NSEW])\s*$/i);
  if (!match) {
    throw new Error(`Unable to parse coordinate: "${input}"`);
  }
  const deg = parseInt(match[1], 10);
  const min = parseInt(match[2], 10);
  const sec = parseFloat(match[3]);
  const hemi = match[4].toUpperCase();
  const value = deg + min / 60.0 + sec / 3600.0;
  return hemi === 'S' || hemi === 'W' ? -value : value;
}

/**
 * Formats decimal degrees into Flyover DMS string (e.g. `35°28'08.71"N`).
 */
export function formatDms(deg: number, axis: 'lat' | 'lon'): string {
  const hemi = axis === 'lat' ? (deg >= 0 ? 'N' : 'S') : deg >= 0 ? 'E' : 'W';
  const absDeg = Math.abs(deg);
  let d = Math.floor(absDeg);
  const minFloat = (absDeg - d) * 60.0;
  let m = Math.floor(minFloat);
  let s = Math.round((minFloat - m) * 60.0 * 100) / 100;
  if (s >= 60.0) {
    s = 0.0;
    m += 1;
  }
  if (m >= 60) {
    m = 0;
    d += 1;
  }
  const mStr = String(m).padStart(2, '0');
  const sStr = s.toFixed(2).padStart(5, '0');
  return `${d}°${mStr}'${sStr}"${hemi}`;
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function norm3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalize3(v: Vec3): Vec3 {
  const n = norm3(v);
  if (n < 1e-12) return [0, 0, 0];
  return [v[0] / n, v[1] / n, v[2] / n];
}

export function mat3Mul(A: Mat3, B: Mat3): Mat3 {
  const out: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    }
  }
  return out;
}

export function mat3MulVec(M: Mat3, v: Vec3): Vec3 {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}

/**
 * Converts geodetic WGS84 (lat deg, lon deg, alt m) to ECEF (X, Y, Z m).
 */
export function wgs84ToEcef(latDeg: number, lonDeg: number, altM: number): Vec3 {
  const latRad = degToRad(latDeg);
  const lonRad = degToRad(lonDeg);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);
  const N = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);

  return [
    (N + altM) * cosLat * cosLon,
    (N + altM) * cosLat * sinLon,
    (N * (1.0 - WGS84_E2) + altM) * sinLat,
  ];
}

/**
 * Computes the local ENU basis rows [Ev, Nv, Uv] at a WGS84 origin.
 * Multiplying an ECEF delta vector by B = [Ev; Nv; Uv] yields local ENU meters.
 */
export function enuBasisAtOrigin(
  lat0Deg: number,
  lon0Deg: number
): { Ev: Vec3; Nv: Vec3; Uv: Vec3; B: Mat3 } {
  const p = degToRad(lat0Deg);
  const l = degToRad(lon0Deg);
  const sinP = Math.sin(p);
  const cosP = Math.cos(p);
  const sinL = Math.sin(l);
  const cosL = Math.cos(l);

  const Ev: Vec3 = [-sinL, cosL, 0.0];
  const Nv: Vec3 = [-sinP * cosL, -sinP * sinL, cosP];
  const Uv: Vec3 = [cosP * cosL, cosP * sinL, sinP];
  return { Ev, Nv, Uv, B: [Ev, Nv, Uv] };
}

/**
 * Rotates an ECEF delta (or Google Earth Studio ECEF-shifted Local vector) into local ENU meters.
 */
export function esLocalToEnu(localXyz: Vec3, lat0Deg: number, lon0Deg: number): Vec3 {
  const { Ev, Nv, Uv } = enuBasisAtOrigin(lat0Deg, lon0Deg);
  return [dot3(localXyz, Ev), dot3(localXyz, Nv), dot3(localXyz, Uv)];
}

/**
 * Exact ellipsoidal WGS84 -> ECEF -> ENU transformation relative to origin.
 */
export function wgs84ToEnuEllipsoidal(
  latDeg: number,
  lonDeg: number,
  altM: number,
  origin: GeodeticPoint
): Vec3 {
  const pEcef = wgs84ToEcef(latDeg, lonDeg, altM);
  const oEcef = wgs84ToEcef(origin.lat, origin.lon, origin.alt);
  return esLocalToEnu(sub3(pEcef, oEcef), origin.lat, origin.lon);
}

/**
 * Spherical tangent-plane ENU matching `es_matrices.py` / `ges_converter.py` default mode
 * (R_earth = 6378137.0 m, z = alt - origin.alt).
 */
export function wgs84ToEnuTangent(
  latDeg: number,
  lonDeg: number,
  altM: number,
  origin: GeodeticPoint
): Vec3 {
  const p = degToRad(origin.lat);
  const e = WGS84_A * degToRad(lonDeg - origin.lon) * Math.cos(p);
  const n = WGS84_A * degToRad(latDeg - origin.lat);
  const u = altM - origin.alt;
  return [e, n, u];
}

/**
 * Inverse ENU -> WGS84 (lat deg, lon deg, alt m) via exact ECEF transpose + iterative geodetic solver.
 */
export function enuToWgs84(east: number, north: number, up: number, origin: GeodeticPoint): GeodeticPoint {
  const oEcef = wgs84ToEcef(origin.lat, origin.lon, origin.alt);
  const { Ev, Nv, Uv } = enuBasisAtOrigin(origin.lat, origin.lon);
  // B^T * [east, north, up]
  const x = oEcef[0] + Ev[0] * east + Nv[0] * north + Uv[0] * up;
  const y = oEcef[1] + Ev[1] * east + Nv[1] * north + Uv[1] * up;
  const z = oEcef[2] + Ev[2] * east + Nv[2] * north + Uv[2] * up;

  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1.0 - WGS84_E2));
  let alt = 0;

  for (let iter = 0; iter < 8; iter++) {
    const sinLat = Math.sin(lat);
    const N = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
    alt = p / Math.max(1e-12, Math.cos(lat)) - N;
    const nextLat = Math.atan2(z, p * (1.0 - (WGS84_E2 * N) / (N + alt)));
    if (Math.abs(nextLat - lat) < 1e-13) {
      lat = nextLat;
      break;
    }
    lat = nextLat;
  }

  const sinLat = Math.sin(lat);
  const N = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
  alt = Math.abs(Math.cos(lat)) > 1e-6 ? p / Math.cos(lat) - N : Math.abs(z) / Math.abs(sinLat) - N * (1.0 - WGS84_E2);

  return {
    lat: radToDeg(lat),
    lon: radToDeg(lon),
    alt,
  };
}

/**
 * Exact pinhole intrinsics (zero distortion, principal point at image center, square pixels).
 */
export function computePinholeK(
  width: number,
  height: number,
  fovVerticalDeg: number
): PinholeIntrinsics {
  const fy = (height / 2.0) / Math.tan(degToRad(fovVerticalDeg / 2.0));
  return {
    fx: roundTo(fy, 3),
    fy: roundTo(fy, 3),
    cx: roundTo(width / 2.0, 3),
    cy: roundTo(height / 2.0, 3),
    width: Math.round(width),
    height: Math.round(height),
    fov_vertical_deg: roundTo(fovVerticalDeg, 4),
  };
}

/**
 * Blender focal length in mm on a 36 mm horizontal sensor: `f_mm = fx_px * 36 / width_px`.
 */
export function blenderFocalLengthMm(
  fxPx: number,
  widthPx: number,
  sensorWidthMm = 36.0
): number {
  if (widthPx <= 0) return 35.0;
  return roundTo((fxPx * sensorWidthMm) / widthPx, 4);
}

/**
 * Google Earth Studio Euler rotation in Local (ECEF-shifted) frame:
 * R = Rx(rx) * Ry(ry) * Rz(rz) (angles in degrees).
 */
export function gesRotationMatrix(rxDeg: number, ryDeg: number, rzDeg: number): Mat3 {
  const a = degToRad(rxDeg);
  const b = degToRad(ryDeg);
  const c = degToRad(rzDeg);

  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  const cc = Math.cos(c);
  const sc = Math.sin(c);

  const Rx: Mat3 = [
    [1, 0, 0],
    [0, ca, -sa],
    [0, sa, ca],
  ];
  const Ry: Mat3 = [
    [cb, 0, sb],
    [0, 1, 0],
    [-sb, 0, cb],
  ];
  const Rz: Mat3 = [
    [cc, -sc, 0],
    [sc, cc, 0],
    [0, 0, 1],
  ];
  return mat3Mul(mat3Mul(Rx, Ry), Rz);
}

/**
 * Converts a 4x4 row-major OpenCV camera-to-world matrix (`+X right, +Y down, +Z forward`)
 * to OpenGL / Blender / Three.js camera-to-world (`+X right, +Y up, -Z forward`):
 * `c2w_gl = c2w_cv @ diag(1, -1, -1, 1)`.
 */
export function openCvToOpenGlC2W(c2wCv: readonly number[]): number[] {
  return [
    c2wCv[0], -c2wCv[1], -c2wCv[2], c2wCv[3],
    c2wCv[4], -c2wCv[5], -c2wCv[6], c2wCv[7],
    c2wCv[8], -c2wCv[9], -c2wCv[10], c2wCv[11],
    0, 0, 0, 1,
  ];
}

/**
 * Builds a 4x4 row-major camera-to-world matrix in local ENU (Z-up) for a level camera
 * at `camEnu` looking at `targetEnu`.
 */
export function buildLookAtC2W(
  camEnu: Vec3,
  targetEnu: Vec3,
  convention: CameraConvention = 'opencv'
): number[] {
  const fwd = normalize3(sub3(targetEnu, camEnu));
  let right: Vec3;
  let down: Vec3;

  if (Math.abs(fwd[2]) > 0.9995) {
    // Near-nadir or zenith: align camera "up" with North (+Y in ENU)
    const northUp: Vec3 = [0, 1, 0];
    right = normalize3(cross3(fwd, northUp));
    down = normalize3(cross3(fwd, right));
  } else {
    const worldUp: Vec3 = [0, 0, 1];
    right = normalize3(cross3(fwd, worldUp));
    down = normalize3(cross3(fwd, right));
  }

  const c2wCv = [
    right[0], down[0], fwd[0], camEnu[0],
    right[1], down[1], fwd[1], camEnu[1],
    right[2], down[2], fwd[2], camEnu[2],
    0, 0, 0, 1,
  ];
  return convention === 'opengl' ? openCvToOpenGlC2W(c2wCv) : c2wCv;
}

/**
 * Converts a 3x3 row-major rotation matrix to a unit quaternion (qw, qx, qy, qz)
 * using Shepperd's method (exact port of `matrices_to_trajectory.py`).
 */
export function rotationMatrixToQuaternion(m: Mat3): UnitQuaternion {
  const t = m[0][0] + m[1][1] + m[2][2];
  let qw: number;
  let qx: number;
  let qy: number;
  let qz: number;

  if (t > 0) {
    const s = Math.sqrt(t + 1.0) * 2.0;
    qw = s * 0.25;
    qx = (m[2][1] - m[1][2]) / s;
    qy = (m[0][2] - m[2][0]) / s;
    qz = (m[1][0] - m[0][1]) / s;
  } else if (m[0][0] >= m[1][1] && m[0][0] >= m[2][2]) {
    const s = Math.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2.0;
    qw = (m[2][1] - m[1][2]) / s;
    qx = s * 0.25;
    qy = (m[0][1] + m[1][0]) / s;
    qz = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] >= m[2][2]) {
    const s = Math.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2.0;
    qw = (m[0][2] - m[2][0]) / s;
    qx = (m[0][1] + m[1][0]) / s;
    qy = s * 0.25;
    qz = (m[1][2] + m[2][1]) / s;
  } else {
    const s = Math.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2.0;
    qw = (m[1][0] - m[0][1]) / s;
    qx = (m[0][2] + m[2][0]) / s;
    qy = (m[1][2] + m[2][1]) / s;
    qz = s * 0.25;
  }

  const len = Math.hypot(qw, qx, qy, qz) || 1.0;
  return {
    qw: qw / len,
    qx: qx / len,
    qy: qy / len,
    qz: qz / len,
  };
}

/**
 * Rebuilds a 3x3 row-major rotation matrix from a unit quaternion (qw, qx, qy, qz).
 */
export function quaternionToRotationMatrix(q: UnitQuaternion): Mat3 {
  const { qw: w, qx: x, qy: y, qz: z } = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  return [
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
  ];
}

/**
 * Extracts a 3x3 rotation block from a 16-element row-major 4x4 matrix.
 */
export function extractRotation3x3(c2w: readonly number[]): Mat3 {
  return [
    [c2w[0], c2w[1], c2w[2]],
    [c2w[4], c2w[5], c2w[6]],
    [c2w[8], c2w[9], c2w[10]],
  ];
}

/**
 * Converts an OpenCV ENU camera-to-world 4x4 matrix into CesiumJS camera orientation
 * angles in degrees: heading [0, 360) clockwise from North, pitch [-90, 90], roll [-180, 180].
 */
export function c2wOpenCvToCesiumHPR(c2w: readonly number[]): {
  heading: number;
  pitch: number;
  roll: number;
} {
  const right: Vec3 = [c2w[0], c2w[4], c2w[8]];
  const down: Vec3 = [c2w[1], c2w[5], c2w[9]];
  const fwd: Vec3 = normalize3([c2w[2], c2w[6], c2w[10]]);

  const pitchRad = Math.asin(clamp(fwd[2], -1.0, 1.0));
  const cosPitch = Math.cos(pitchRad);

  let headingRad: number;
  let rollRad = 0;

  if (cosPitch > 1e-4) {
    headingRad = Math.atan2(fwd[0], fwd[1]);
    // Zero-roll horizontal right vector in ENU: [cos(h), -sin(h), 0]
    const hRight: Vec3 = [Math.cos(headingRad), -Math.sin(headingRad), 0.0];
    const hDown = normalize3(cross3(fwd, hRight));
    rollRad = Math.atan2(dot3(right, hDown), dot3(right, hRight));
  } else {
    // Near-nadir / zenith: derive heading from camera "up" = -down
    headingRad = Math.atan2(-down[0], -down[1]);
    rollRad = 0;
  }

  let headingDeg = radToDeg(headingRad) % 360;
  if (headingDeg < 0) headingDeg += 360;
  const pitchDeg = radToDeg(pitchRad);
  const rollDeg = radToDeg(rollRad);

  return {
    heading: roundTo(headingDeg, 4),
    pitch: roundTo(pitchDeg, 4),
    roll: roundTo(rollDeg, 4),
  };
}

/**
 * Detects whether an uploaded JSON object is a Google Earth Studio 3D Tracking Data export.
 */
export function isGesTrackingJson(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  const frames = Array.isArray(obj.cameraFrames)
    ? obj.cameraFrames
    : Array.isArray(obj.frames)
      ? obj.frames
      : null;
  if (!frames || frames.length === 0) return false;
  const first = frames[0] as Record<string, unknown> | null;
  if (!first || typeof first !== 'object') return false;
  const coord = (first.coordinate ?? first) as Record<string, unknown>;
  const hasCoord =
    typeof coord?.latitude === 'number' &&
    typeof coord?.longitude === 'number' &&
    typeof coord?.altitude === 'number';
  const rot = first.rotation as Record<string, unknown> | undefined;
  const hasRot =
    rot !== undefined &&
    typeof rot?.x === 'number' &&
    typeof rot?.y === 'number' &&
    typeof rot?.z === 'number';
  return hasCoord && hasRot;
}

/**
 * Converts a Google Earth Studio 3D Tracking Data JSON into:
 *  - `cameraMatrices` (`es_matrices.py` schema)
 *  - `trajectory` (`matrices_to_trajectory.py` / `blender_gbuffers.py` schema)
 *  - `cesiumSamples` (NoDRONE Offline Render Path samples)
 *
 * Always iterates `cameraFrames.length` (never relies on the off-by-one `numFrames` header).
 */
export function convertGesTrackingJson(
  raw: Record<string, unknown>,
  options: GesConversionOptions = {}
): GesConversionResult {
  const cameraFrames = (
    Array.isArray(raw.cameraFrames)
      ? raw.cameraFrames
      : Array.isArray(raw.frames)
        ? raw.frames
        : []
  ) as Array<Record<string, any>>;

  if (cameraFrames.length === 0) {
    throw new Error('Google Earth Studio JSON contains no cameraFrames.');
  }

  const name = String(raw.name || 'GES_Export').trim();
  const width = Number.isFinite(Number(raw.width)) ? Math.round(Number(raw.width)) : 1920;
  const height = Number.isFinite(Number(raw.height)) ? Math.round(Number(raw.height)) : 1080;
  const fps = Number.isFinite(Number(raw.frameRate)) && Number(raw.frameRate) > 0
    ? Number(raw.frameRate)
    : 30;
  const targetAglM = options.targetAglM ?? 7.0;
  const useEllipsoidal = options.useEllipsoidal ?? false;
  const convention: CameraConvention = options.convention ?? 'opencv';

  // Determine ENU origin: explicit override > origin anchor > first trackPoint coordinate > first frame
  let originLat: number;
  let originLon: number;
  let originAlt: number;
  let originName: string;

  const trackPoints = Array.isArray(raw.trackPoints)
    ? (raw.trackPoints as Array<Record<string, any>>)
    : [];

  if (options.origin) {
    originLat = round7(options.origin.lat);
    originLon = round7(options.origin.lon);
    originAlt = options.origin.alt;
    originName = options.origin.name || 'Origin';
  } else if (options.anchors && options.anchors.length > 0) {
    const originAnchor = options.anchors.find((a) => a.role === 'origin') ?? options.anchors[0];
    originLat = round7(parseLatLon(originAnchor.lat));
    originLon = round7(parseLatLon(originAnchor.lon));
    originAlt = Number(originAnchor.es_alt ?? originAnchor.elev_m);
    originName = originAnchor.name;
  } else {
    const zeroTp = trackPoints.find(
      (tp) =>
        tp?.coordinate &&
        typeof tp.coordinate.latitude === 'number' &&
        typeof tp.coordinate.longitude === 'number' &&
        (tp.position?.x === 0 && tp.position?.y === 0 && tp.position?.z === 0)
    );
    const fallbackCoord = zeroTp?.coordinate ?? cameraFrames[0].coordinate ?? cameraFrames[0];
    originLat = round7(Number(fallbackCoord.latitude));
    originLon = round7(Number(fallbackCoord.longitude));
    originAlt = Number(fallbackCoord.altitude ?? 0);
    originName = zeroTp?.name ? String(zeroTp.name) : 'GES_Origin';
  }

  const originPt: GeodeticPoint = { lat: originLat, lon: originLon, alt: originAlt };
  const targetEnu: Vec3 = [0.0, 0.0, targetAglM];

  const frames: CameraMatrixFrame[] = [];
  const trajectory: BlenderTrajectoryFrame[] = [];
  const cesiumSamples: CesiumCameraSample[] = [];

  let maxFwdErrDeg = 0.0;
  let maxRollDeg = 0.0;
  let maxPosDiffM = 0.0;

  for (let i = 0; i < cameraFrames.length; i++) {
    const fr = cameraFrames[i];
    const frameIndex = Number.isFinite(Number(fr.frame)) ? Math.round(Number(fr.frame)) : i;
    const coord = fr.coordinate ?? fr;
    const lat = Number(coord.latitude);
    const lon = Number(coord.longitude);
    const alt = Number(coord.altitude);
    const fovV = Number.isFinite(Number(fr.fovVertical)) ? Number(fr.fovVertical) : 40.0;

    const rot = fr.rotation ?? { x: 0, y: 0, z: 0 };
    const Rm = gesRotationMatrix(Number(rot.x || 0), Number(rot.y || 0), Number(rot.z || 0));

    // Camera axes in Earth Studio ECEF-shifted Local frame, rotated to ENU
    const right = esLocalToEnu(mat3MulVec(Rm, [1, 0, 0]), originLat, originLon);
    const down = esLocalToEnu(mat3MulVec(Rm, [0, 1, 0]), originLat, originLon);
    const fwd = esLocalToEnu(mat3MulVec(Rm, [0, 0, 1]), originLat, originLon);

    const camEnu: Vec3 = useEllipsoidal
      ? wgs84ToEnuEllipsoidal(lat, lon, alt, originPt)
      : wgs84ToEnuTangent(lat, lon, alt, originPt);

    // Verification checks (matching es_matrices.py)
    const toTarget = normalize3(sub3(targetEnu, camEnu));
    if (norm3(toTarget) > 0) {
      const fwdErr = radToDeg(Math.acos(clamp(dot3(normalize3(fwd), toTarget), -1.0, 1.0)));
      if (fwdErr > maxFwdErrDeg) maxFwdErrDeg = fwdErr;
    }
    const rollErr = radToDeg(Math.asin(clamp(Math.abs(right[2]), -1.0, 1.0)));
    if (rollErr > maxRollDeg) maxRollDeg = rollErr;

    if (fr.position && typeof fr.position.x === 'number') {
      const localEnu = esLocalToEnu(
        [Number(fr.position.x), Number(fr.position.y), Number(fr.position.z)],
        originLat,
        originLon
      );
      const posDiff = norm3(sub3(camEnu, localEnu));
      if (posDiff > maxPosDiffM) maxPosDiffM = posDiff;
    }

    const c2wOpenCvRaw = [
      right[0], down[0], fwd[0], camEnu[0],
      right[1], down[1], fwd[1], camEnu[1],
      right[2], down[2], fwd[2], camEnu[2],
      0, 0, 0, 1,
    ];

    const c2wExportRaw = convention === 'opengl' ? openCvToOpenGlC2W(c2wOpenCvRaw) : c2wOpenCvRaw;
    const c2wRounded = c2wExportRaw.map((v) => roundTo(v, 6));
    const K = computePinholeK(width, height, fovV);

    frames.push({
      frame: frameIndex,
      time_s: roundTo(i / fps, 4),
      c2w_enu_zup_rowmajor: c2wRounded,
      K,
      lat,
      lon,
      alt_asl_m: alt,
    });

    // Shepperd quaternion of OpenCV c2w rotation (for blender_gbuffers.py)
    const c2wOpenCvRounded = c2wOpenCvRaw.map((v) => roundTo(v, 6));
    const quat = rotationMatrixToQuaternion(extractRotation3x3(c2wOpenCvRounded));
    trajectory.push({
      frame: frameIndex,
      x_enu: c2wOpenCvRounded[3],
      y_enu: c2wOpenCvRounded[7],
      z_enu: c2wOpenCvRounded[11],
      qx: roundTo(quat.qx, 9),
      qy: roundTo(quat.qy, 9),
      qz: roundTo(quat.qz, 9),
      qw: roundTo(quat.qw, 9),
    });

    const hpr = c2wOpenCvToCesiumHPR(c2wOpenCvRaw);
    cesiumSamples.push({
      t: roundTo(i / fps, 4),
      lat,
      lon,
      height: alt,
      heading: hpr.heading,
      pitch: hpr.pitch,
      roll: hpr.roll,
      fovyDeg: fovV,
    });
  }

  // Convert anchors or trackPoints to ENU
  const anchorsEnu: AnchorEnu[] = [];
  if (options.anchors && options.anchors.length > 0) {
    for (const a of options.anchors) {
      if (a.role === 'ref') continue;
      const enu = wgs84ToEnuTangent(
        parseLatLon(a.lat),
        parseLatLon(a.lon),
        Number(a.es_alt ?? a.elev_m),
        originPt
      );
      anchorsEnu.push({
        name: a.name,
        E: roundTo(enu[0], 2),
        N: roundTo(enu[1], 2),
        U: roundTo(enu[2], 2),
      });
    }
  } else if (trackPoints.length > 0) {
    for (const tp of trackPoints) {
      if (!tp?.position || typeof tp.position.x !== 'number') continue;
      const enu = esLocalToEnu(
        [Number(tp.position.x), Number(tp.position.y), Number(tp.position.z)],
        originLat,
        originLon
      );
      anchorsEnu.push({
        name: String(tp.name || 'TrackPoint'),
        E: roundTo(enu[0], 2),
        N: roundTo(enu[1], 2),
        U: roundTo(enu[2], 2),
      });
    }
  }

  const fmtCoord = (v: number) => v.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
  const worldDesc = `ENU metres from ${originName} ground point (${fmtCoord(originLat)}, ${fmtCoord(originLon)}, ${originAlt} m ASL): x=East, y=North, z=Up`;
  const cameraDesc =
    convention === 'opengl'
      ? 'OpenGL: x=right, y=up, -z=forward (converted from Earth Studio OpenCV frame via diag(1,-1,-1,1))'
      : "OpenCV: x=right, y=down, z=forward (Earth Studio's native camera frame; up = -y)";

  const firstK = frames[0].K;
  const fMm = blenderFocalLengthMm(firstK.fx, firstK.width, 36.0);

  const cameraMatrices: CameraMatricesDocument = {
    name,
    frames_count: frames.length,
    fps,
    quotable: false,
    conventions: {
      world: worldDesc,
      camera: cameraDesc,
      matrix:
        'camera-to-world, 4x4, row-major, translation in last column; world_point = c2w @ [x_cam, y_cam, z_cam, 1]; invert for world-to-camera',
      intrinsics: 'pinhole, principal point at image centre, fx=fy=(H/2)/tan(fov_v/2); no distortion',
      source:
        'rotation R = Rx(x)*Ry(y)*Rz(z) (deg) applied to camera axes in Earth Studio ECEF-shifted Local frame, then rotated to ENU; position from lat/lon/alt (exact)',
    },
    verification: {
      max_forward_error_deg_vs_camera_target: roundTo(maxFwdErrDeg, 3),
      max_roll_deg: roundTo(maxRollDeg, 3),
      max_position_diff_m_es_vs_latlon: roundTo(maxPosDiffM, 3),
    },
    anchors_enu: anchorsEnu,
    frames,
  };

  const trajectoryDoc: BlenderTrajectoryDocument = {
    site: name,
    convention: 'opencv',
    fps,
    quotable: false,
    world: worldDesc,
    camera: "OpenCV: x=right, y=down, z=forward (Blender G-buffer renderer applies OpenCV->OpenGL flip)",
    blender_focal_mm: fMm,
    sensor_width_mm: 36.0,
    resolution: [width, height],
    trajectory,
  };

  return {
    name,
    width,
    height,
    fps,
    origin: { ...originPt, name: originName },
    blenderFocalMm: fMm,
    cameraMatrices,
    trajectory: trajectoryDoc,
    cesiumSamples,
  };
}

/**
 * Computes lowercase hex SHA-256 digest via Web Crypto API (browser & Node 22).
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}
