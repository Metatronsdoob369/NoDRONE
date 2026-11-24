/**
 * Smooth real-world camera fly-through.
 *
 * WGS84 bookmarks -> local ENU (geodesy.ts) -> centripetal Catmull-Rom
 * (alpha 0.5) -> quaternion squad -> WGS84 samples at a fixed frame rate.
 * Paths longer than ~50 km are split so each span keeps its own ENU origin.
 */

import {
  blenderFocalLengthMm,
  c2wOpenCvToCesiumHPR,
  computePinholeK,
  degToRad,
  enuBasisAtOrigin,
  enuToWgs84,
  mat3Mul,
  norm3,
  quaternionToRotationMatrix,
  rotationMatrixToQuaternion,
  roundTo,
  sub3,
  wgs84ToEcef,
  wgs84ToEnuEllipsoidal,
  type BlenderTrajectoryDocument,
  type GeodeticPoint,
  type Mat3,
  type UnitQuaternion,
  type Vec3,
} from './geodesy';

export const FLIGHT_SEGMENT_LIMIT_METERS = 50_000;
export const FLIGHT_DUPLICATE_METERS = 0.001;
const DEFAULT_FPS = 30;
const DEFAULT_SPEED_MPS = 25;
const CATMULL_ALPHA = 0.5;
const MAX_SAMPLES = 12_000;
const DENSE_STEPS = 24;
const MIN_HOLD_SEC = 1.5;

export interface FlightWaypoint {
  name?: string;
  lat: number;
  lon: number;
  alt: number;
  heading: number;
  pitch: number;
  roll: number;
}

export interface FlightSplineSample {
  t: number;
  lat: number;
  lon: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
  fovyDeg: number | null;
  quaternion: UnitQuaternion;
}

export interface FlightSplineOptions {
  fps?: number;
  speedMps?: number;
  alpha?: number;
  segmentLimitMeters?: number;
  fovyDeg?: number | null;
  minHoldSec?: number;
}

export interface FlightSplineResult {
  fps: number;
  speedMps: number;
  segmentCount: number;
  durationSec: number;
  origins: GeodeticPoint[];
  samples: FlightSplineSample[];
}

export interface FlightCameraPathSample {
  t?: number;
  lat: number;
  lon: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
  fovyDeg: number | null;
}

export interface ParsedFlightDocument {
  site: string;
  surveyId: string | null;
  fps: number;
  resolution: [number, number];
  samples: FlightCameraPathSample[];
}

export interface FlightCameraPathDocument {
  schema: 'nodrone-camera-path/1';
  site: string;
  surveyId: string;
  capturedAt: string | null;
  recordedAt: string;
  quotable: false;
  mode: string;
  smoothMode: 'catmull-rom';
  heightReference: string;
  angleUnits: 'degrees';
  frameCount: number;
  render: {
    fps: number;
    resolution: [number, number];
  };
  samples: Array<Required<Pick<FlightCameraPathSample, 't'>> & FlightCameraPathSample>;
}

export interface FlightTrajectoryDocument extends BlenderTrajectoryDocument {
  surveyId: string;
  capturedAt: string | null;
  origin: GeodeticPoint & { name: string };
  heightReference: string;
}

export interface FlightExportInput {
  site: string;
  surveyId: string;
  capturedAt?: string | null;
  recordedAt?: string;
  resolution: [number, number];
  fovyDeg: number;
  waypoints: FlightWaypoint[];
  fps?: number;
  speedMps?: number;
  mode?: string;
}

export interface FlightExportBundle {
  spline: FlightSplineResult;
  cameraPath: FlightCameraPathDocument;
  trajectory: FlightTrajectoryDocument;
}

export function verticalFovDegForLens(focalLengthMm: number): number {
  const focal = focalLengthMm > 0 ? focalLengthMm : 24;
  return Number(((2 * Math.atan(24 / (2 * focal)) * 180) / Math.PI).toFixed(2));
}

export function wgs84SeparationMeters(a: GeodeticPoint, b: GeodeticPoint): number {
  return norm3(sub3(wgs84ToEcef(a.lat, a.lon, a.alt), wgs84ToEcef(b.lat, b.lon, b.alt)));
}

export function quaternionDot(a: UnitQuaternion, b: UnitQuaternion): number {
  return a.qw * b.qw + a.qx * b.qx + a.qy * b.qy + a.qz * b.qz;
}

export function negateQuaternion(q: UnitQuaternion): UnitQuaternion {
  return { qw: -q.qw, qx: -q.qx, qy: -q.qy, qz: -q.qz };
}

export function alignQuaternion(reference: UnitQuaternion, next: UnitQuaternion): UnitQuaternion {
  return quaternionDot(reference, next) < 0 ? negateQuaternion(next) : next;
}

export function alignQuaternionChain(quaternions: UnitQuaternion[]): UnitQuaternion[] {
  if (quaternions.length === 0) return [];
  const aligned: UnitQuaternion[] = [quaternions[0]];
  for (let i = 1; i < quaternions.length; i++) {
    aligned.push(alignQuaternion(aligned[i - 1], quaternions[i]));
  }
  return aligned;
}

function normalizeQuaternion(q: UnitQuaternion): UnitQuaternion {
  const n = Math.hypot(q.qw, q.qx, q.qy, q.qz) || 1;
  return { qw: q.qw / n, qx: q.qx / n, qy: q.qy / n, qz: q.qz / n };
}

function multiplyQuaternion(a: UnitQuaternion, b: UnitQuaternion): UnitQuaternion {
  return {
    qw: a.qw * b.qw - a.qx * b.qx - a.qy * b.qy - a.qz * b.qz,
    qx: a.qw * b.qx + a.qx * b.qw + a.qy * b.qz - a.qz * b.qy,
    qy: a.qw * b.qy - a.qx * b.qz + a.qy * b.qw + a.qz * b.qx,
    qz: a.qw * b.qz + a.qx * b.qy - a.qy * b.qx + a.qz * b.qw,
  };
}

function conjugateQuaternion(q: UnitQuaternion): UnitQuaternion {
  return { qw: q.qw, qx: -q.qx, qy: -q.qy, qz: -q.qz };
}

function quaternionLog(q: UnitQuaternion): Vec3 {
  const n = normalizeQuaternion(q);
  const vNorm = Math.hypot(n.qx, n.qy, n.qz);
  if (vNorm < 1e-10) return [0, 0, 0];
  const angle = Math.atan2(vNorm, n.qw);
  const scale = angle / vNorm;
  return [n.qx * scale, n.qy * scale, n.qz * scale];
}

function quaternionExp(v: Vec3): UnitQuaternion {
  const theta = Math.hypot(v[0], v[1], v[2]);
  if (theta < 1e-10) return normalizeQuaternion({ qw: 1, qx: v[0], qy: v[1], qz: v[2] });
  const scale = Math.sin(theta) / theta;
  return { qw: Math.cos(theta), qx: v[0] * scale, qy: v[1] * scale, qz: v[2] * scale };
}

export function slerpQuaternion(a: UnitQuaternion, bIn: UnitQuaternion, t: number): UnitQuaternion {
  const b = alignQuaternion(a, bIn);
  let dot = quaternionDot(a, b);
  if (dot > 0.9995) {
    return normalizeQuaternion({
      qw: a.qw + (b.qw - a.qw) * t,
      qx: a.qx + (b.qx - a.qx) * t,
      qy: a.qy + (b.qy - a.qy) * t,
      qz: a.qz + (b.qz - a.qz) * t,
    });
  }
  dot = Math.min(1, Math.max(-1, dot));
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const w1 = Math.sin((1 - t) * theta) / sinTheta;
  const w2 = Math.sin(t * theta) / sinTheta;
  return normalizeQuaternion({
    qw: a.qw * w1 + b.qw * w2,
    qx: a.qx * w1 + b.qx * w2,
    qy: a.qy * w1 + b.qy * w2,
    qz: a.qz * w1 + b.qz * w2,
  });
}

function squadTangent(qPrev: UnitQuaternion, q: UnitQuaternion, qNext: UnitQuaternion): UnitQuaternion {
  const inv = conjugateQuaternion(normalizeQuaternion(q));
  const toNext = quaternionLog(multiplyQuaternion(inv, alignQuaternion(q, qNext)));
  const toPrev = quaternionLog(multiplyQuaternion(inv, alignQuaternion(q, qPrev)));
  return multiplyQuaternion(q, quaternionExp([
    -0.25 * (toNext[0] + toPrev[0]),
    -0.25 * (toNext[1] + toPrev[1]),
    -0.25 * (toNext[2] + toPrev[2]),
  ]));
}

function squadQuaternion(
  q0: UnitQuaternion,
  q1: UnitQuaternion,
  s0: UnitQuaternion,
  s1: UnitQuaternion,
  t: number
): UnitQuaternion {
  if (t <= 0) return q0;
  if (t >= 1) return alignQuaternion(q0, q1);
  const ends = slerpQuaternion(q0, q1, t);
  const tangents = slerpQuaternion(s0, s1, t);
  return slerpQuaternion(ends, tangents, 2 * t * (1 - t));
}

export function cesiumHprToQuaternion(headingDeg: number, pitchDeg: number, rollDeg: number): UnitQuaternion {
  const heading = degToRad(headingDeg);
  const pitch = degToRad(pitchDeg);
  const roll = degToRad(rollDeg);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const fwd: Vec3 = [Math.sin(heading) * cosPitch, Math.cos(heading) * cosPitch, sinPitch];
  const levelRight: Vec3 = [Math.cos(heading), -Math.sin(heading), 0];
  const levelDown: Vec3 = [
    sinPitch * Math.sin(heading),
    sinPitch * Math.cos(heading),
    -cosPitch,
  ];
  const cosRoll = Math.cos(roll);
  const sinRoll = Math.sin(roll);
  const right: Vec3 = [
    cosRoll * levelRight[0] + sinRoll * levelDown[0],
    cosRoll * levelRight[1] + sinRoll * levelDown[1],
    cosRoll * levelRight[2] + sinRoll * levelDown[2],
  ];
  const down: Vec3 = [
    -sinRoll * levelRight[0] + cosRoll * levelDown[0],
    -sinRoll * levelRight[1] + cosRoll * levelDown[1],
    -sinRoll * levelRight[2] + cosRoll * levelDown[2],
  ];
  const rotation: Mat3 = [
    [right[0], down[0], fwd[0]],
    [right[1], down[1], fwd[1]],
    [right[2], down[2], fwd[2]],
  ];
  return rotationMatrixToQuaternion(rotation);
}

export function quaternionToCesiumHpr(q: UnitQuaternion): { heading: number; pitch: number; roll: number } {
  const m = quaternionToRotationMatrix(normalizeQuaternion(q));
  return c2wOpenCvToCesiumHPR([
    m[0][0], m[0][1], m[0][2], 0,
    m[1][0], m[1][1], m[1][2], 0,
    m[2][0], m[2][1], m[2][2], 0,
    0, 0, 0, 1,
  ]);
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function reflectPoint(anchor: Vec3, other: Vec3): Vec3 {
  return [2 * anchor[0] - other[0], 2 * anchor[1] - other[1], 2 * anchor[2] - other[2]];
}

/**
 * Centripetal Catmull-Rom (alpha 0.5). Endpoints are returned exactly so a
 * duplicated knot cannot divide by zero and the curve hits every control.
 */
export function centripetalCatmullRom(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  p3: Vec3,
  u: number,
  alpha = CATMULL_ALPHA
): Vec3 {
  if (u <= 0) return [p1[0], p1[1], p1[2]];
  if (u >= 1) return [p2[0], p2[1], p2[2]];

  const knot = (ti: number, a: Vec3, b: Vec3) => {
    const distance = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    return ti + Math.pow(Math.max(distance, 1e-8), alpha);
  };
  const t0 = 0;
  const t1 = knot(t0, p0, p1);
  const t2 = knot(t1, p1, p2);
  const t3 = knot(t2, p2, p3);
  const t = t1 + (t2 - t1) * u;
  const span = (left: number, right: number) => {
    const delta = right - left;
    return Math.abs(delta) < 1e-12 ? (delta < 0 ? -1e-12 : 1e-12) : delta;
  };

  const a1 = lerpVec(p0, p1, (t - t0) / span(t0, t1));
  const a2 = lerpVec(p1, p2, (t - t1) / span(t1, t2));
  const a3 = lerpVec(p2, p3, (t - t2) / span(t2, t3));
  const b1 = lerpVec(a1, a2, (t - t0) / span(t0, t2));
  const b2 = lerpVec(a2, a3, (t - t1) / span(t1, t3));
  return lerpVec(b1, b2, (t - t1) / span(t1, t2));
}

function toGeo(point: FlightWaypoint): GeodeticPoint {
  return { lat: point.lat, lon: point.lon, alt: point.alt };
}

function dedupeWaypoints(points: FlightWaypoint[]): FlightWaypoint[] {
  const unique: FlightWaypoint[] = [];
  for (const point of points) {
    const previous = unique[unique.length - 1];
    if (previous && wgs84SeparationMeters(toGeo(previous), toGeo(point)) < FLIGHT_DUPLICATE_METERS) {
      continue;
    }
    unique.push(point);
  }
  return unique;
}

function splitWaypointSegments(points: FlightWaypoint[], limitMeters: number): FlightWaypoint[][] {
  if (points.length === 0) return [];
  const segments: FlightWaypoint[][] = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    const current = segments[segments.length - 1];
    const previous = current[current.length - 1];
    const step = wgs84SeparationMeters(toGeo(previous), toGeo(points[i]));
    const fromOrigin = wgs84SeparationMeters(toGeo(current[0]), toGeo(points[i]));
    if (current.length > 1 && (step > limitMeters || fromOrigin > limitMeters)) {
      segments.push([previous, points[i]]);
    } else {
      current.push(points[i]);
      if (step > limitMeters && i < points.length - 1) {
        segments.push([points[i]]);
      }
    }
  }
  return segments;
}

interface CurveKey {
  span: number;
  u: number;
  dist: number;
  enu: Vec3;
  quaternion: UnitQuaternion;
  knot: boolean;
}

function sampleSegment(
  points: FlightWaypoint[],
  origin: GeodeticPoint,
  alpha: number,
  spacingMeters: number,
  speedMps: number,
  fovyDeg: number | null
): FlightSplineSample[] {
  const enuPoints = points.map((point) => wgs84ToEnuEllipsoidal(point.lat, point.lon, point.alt, origin));
  const quaternions = alignQuaternionChain(
    points.map((point) => cesiumHprToQuaternion(point.heading, point.pitch, point.roll))
  );

  if (points.length === 1) {
    return [poseSample(enuPoints[0], quaternions[0], origin, 0, fovyDeg)];
  }

  const keys: CurveKey[] = [{
    span: 0,
    u: 0,
    dist: 0,
    enu: enuPoints[0],
    quaternion: quaternions[0],
    knot: true,
  }];
  let distance = 0;
  let previous = enuPoints[0];

  for (let span = 0; span < points.length - 1; span++) {
    const p0 = span === 0 ? reflectPoint(enuPoints[0], enuPoints[1]) : enuPoints[span - 1];
    const p1 = enuPoints[span];
    const p2 = enuPoints[span + 1];
    const p3 = span + 2 < enuPoints.length
      ? enuPoints[span + 2]
      : reflectPoint(enuPoints[span + 1], enuPoints[span]);
    const qPrev = span === 0 ? quaternions[0] : quaternions[span - 1];
    const q0 = quaternions[span];
    const q1 = quaternions[span + 1];
    const qNext = span + 2 < quaternions.length ? quaternions[span + 2] : q1;
    const s0 = squadTangent(qPrev, q0, q1);
    const s1 = squadTangent(q0, q1, qNext);

    for (let step = 1; step <= DENSE_STEPS; step++) {
      const u = step / DENSE_STEPS;
      const enu = centripetalCatmullRom(p0, p1, p2, p3, u, alpha);
      distance += Math.hypot(enu[0] - previous[0], enu[1] - previous[1], enu[2] - previous[2]);
      previous = enu;
      keys.push({
        span,
        u,
        dist: distance,
        enu,
        quaternion: u >= 1 ? alignQuaternion(q0, q1) : squadQuaternion(q0, q1, s0, s1, u),
        knot: u >= 1,
      });
    }
  }

  const targets = knotAndGridDistances(keys, spacingMeters);
  const samples: FlightSplineSample[] = [];
  const speed = Math.max(speedMps, 1e-6);
  for (const target of targets) {
    const pose = poseAtDistance(keys, target, enuPoints, quaternions, alpha);
    const wgs = enuToWgs84(pose.enu[0], pose.enu[1], pose.enu[2], origin);
    const hpr = quaternionToCesiumHpr(pose.quaternion);
    samples.push({
      t: pose.dist / speed,
      lat: wgs.lat,
      lon: wgs.lon,
      height: wgs.alt,
      heading: hpr.heading,
      pitch: hpr.pitch,
      roll: hpr.roll,
      fovyDeg,
      quaternion: pose.quaternion,
    });
  }
  return realignSampleChain(samples);
}

function knotAndGridDistances(keys: CurveKey[], spacingMeters: number): number[] {
  const total = keys[keys.length - 1]?.dist ?? 0;
  const targets: number[] = [];
  const spacing = Math.max(spacingMeters, 1e-4);
  for (let dist = 0; dist < total - 1e-6; dist += spacing) targets.push(dist);
  targets.push(total);
  for (const key of keys) {
    if (key.knot) targets.push(key.dist);
  }
  targets.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const dist of targets) {
    if (unique.length === 0 || dist - unique[unique.length - 1] > 1e-4) unique.push(dist);
  }
  return unique;
}

function poseAtDistance(
  keys: CurveKey[],
  dist: number,
  enuPoints: Vec3[],
  quaternions: UnitQuaternion[],
  alpha: number
): { enu: Vec3; quaternion: UnitQuaternion; dist: number } {
  if (keys.length === 0) {
    return { enu: [0, 0, 0], quaternion: { qw: 1, qx: 0, qy: 0, qz: 0 }, dist: 0 };
  }
  let hi = 1;
  while (hi < keys.length && keys[hi].dist < dist - 1e-9) hi += 1;
  if (hi >= keys.length) hi = keys.length - 1;
  const right = keys[Math.min(hi, keys.length - 1)];
  const left = keys[Math.max(0, hi - 1)];
  if (left.knot && Math.abs(left.dist - dist) <= 1e-3) {
    return { enu: left.enu, quaternion: left.quaternion, dist: left.dist };
  }
  if (right.knot && Math.abs(right.dist - dist) <= 1e-3) {
    return { enu: right.enu, quaternion: right.quaternion, dist: right.dist };
  }
  const spanDist = right.dist - left.dist;
  const localU = spanDist <= 1e-9 ? 0 : (dist - left.dist) / spanDist;
  const span = right.span;
  const u0 = left.span === span ? left.u : 0;
  const u = u0 + (right.u - u0) * localU;
  const p0 = span === 0 ? reflectPoint(enuPoints[0], enuPoints[1]) : enuPoints[span - 1];
  const p1 = enuPoints[span];
  const p2 = enuPoints[span + 1];
  const p3 = span + 2 < enuPoints.length
    ? enuPoints[span + 2]
    : reflectPoint(enuPoints[span + 1], enuPoints[span]);
  const qPrev = span === 0 ? quaternions[0] : quaternions[span - 1];
  const q0 = quaternions[span];
  const q1 = quaternions[span + 1];
  const qNext = span + 2 < quaternions.length ? quaternions[span + 2] : q1;
  return {
    enu: centripetalCatmullRom(p0, p1, p2, p3, u, alpha),
    quaternion: squadQuaternion(q0, q1, squadTangent(qPrev, q0, q1), squadTangent(q0, q1, qNext), u),
    dist,
  };
}

function poseSample(
  enu: Vec3,
  quaternion: UnitQuaternion,
  origin: GeodeticPoint,
  t: number,
  fovyDeg: number | null
): FlightSplineSample {
  const wgs = enuToWgs84(enu[0], enu[1], enu[2], origin);
  const hpr = quaternionToCesiumHpr(quaternion);
  return {
    t,
    lat: wgs.lat,
    lon: wgs.lon,
    height: wgs.alt,
    heading: hpr.heading,
    pitch: hpr.pitch,
    roll: hpr.roll,
    fovyDeg,
    quaternion,
  };
}

function realignSampleChain(samples: FlightSplineSample[]): FlightSplineSample[] {
  if (samples.length === 0) return samples;
  const aligned: FlightSplineSample[] = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    aligned.push({
      ...samples[i],
      quaternion: alignQuaternion(aligned[i - 1].quaternion, samples[i].quaternion),
    });
  }
  return aligned;
}

function holdSamples(
  point: FlightWaypoint,
  fps: number,
  holdSec: number,
  fovyDeg: number | null
): FlightSplineSample[] {
  const origin = toGeo(point);
  const quaternion = cesiumHprToQuaternion(point.heading, point.pitch, point.roll);
  const pose = poseSample([0, 0, 0], quaternion, origin, 0, fovyDeg);
  const frames = Math.max(2, Math.round(holdSec * fps));
  return Array.from({ length: frames }, (_, index) => ({ ...pose, t: index / fps }));
}

export function sampleFlightSpline(
  waypoints: FlightWaypoint[],
  options: FlightSplineOptions = {}
): FlightSplineResult {
  const fps = clampNumber(options.fps ?? DEFAULT_FPS, 1, 120);
  const speedMps = clampNumber(options.speedMps ?? DEFAULT_SPEED_MPS, 0.5, 5_000);
  const alpha = Number.isFinite(options.alpha) ? clampNumber(options.alpha as number, 0.1, 1) : CATMULL_ALPHA;
  const limit = options.segmentLimitMeters ?? FLIGHT_SEGMENT_LIMIT_METERS;
  const fovyDeg = typeof options.fovyDeg === 'number' && Number.isFinite(options.fovyDeg) ? options.fovyDeg : null;
  const holdSec = options.minHoldSec ?? MIN_HOLD_SEC;
  const unique = dedupeWaypoints(waypoints.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon)));

  if (unique.length === 0) {
    return { fps, speedMps, segmentCount: 0, durationSec: 0, origins: [], samples: [] };
  }
  if (unique.length === 1) {
    const samples = holdSamples(unique[0], fps, holdSec, fovyDeg);
    return {
      fps,
      speedMps,
      segmentCount: 1,
      durationSec: samples[samples.length - 1].t,
      origins: [toGeo(unique[0])],
      samples,
    };
  }

  const segments = splitWaypointSegments(unique, limit);
  const spacing = adaptSpacing(segments, speedMps / fps);
  const origins: GeodeticPoint[] = [];
  let samples: FlightSplineSample[] = [];

  for (const segment of segments) {
    const origin = toGeo(segment[0]);
    origins.push(origin);
    let part = sampleSegment(segment, origin, alpha, spacing, speedMps, fovyDeg);
    if (part.length === 0) continue;
    const tail = samples[samples.length - 1];
    if (tail && quaternionDot(tail.quaternion, part[0].quaternion) < 0) {
      part = part.map((sample) => ({ ...sample, quaternion: negateQuaternion(sample.quaternion) }));
    }
    const timeOffset = tail ? tail.t : 0;
    const skipBoundary = Boolean(
      tail && wgs84SeparationMeters(
        { lat: tail.lat, lon: tail.lon, alt: tail.height },
        { lat: part[0].lat, lon: part[0].lon, alt: part[0].height }
      ) < FLIGHT_DUPLICATE_METERS
    );
    const usable = skipBoundary ? part.slice(1) : part;
    samples = samples.concat(usable.map((sample) => ({ ...sample, t: roundTo(sample.t + timeOffset, 4) })));
  }

  samples = realignSampleChain(samples).map((sample) => ({ ...sample, t: roundTo(sample.t, 4) }));
  const durationSec = samples.length > 0 ? samples[samples.length - 1].t : 0;
  return { fps, speedMps, segmentCount: segments.length, durationSec, origins, samples };
}

function adaptSpacing(segments: FlightWaypoint[][], requestedSpacing: number): number {
  let length = 0;
  for (const segment of segments) {
    for (let i = 1; i < segment.length; i++) {
      length += wgs84SeparationMeters(toGeo(segment[i - 1]), toGeo(segment[i]));
    }
  }
  if (length <= 0) return requestedSpacing;
  const estimated = length / Math.max(requestedSpacing, 1e-3);
  if (estimated <= MAX_SAMPLES) return requestedSpacing;
  return length / MAX_SAMPLES;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function localEnuToFrame(localLat: number, localLon: number, frameLat: number, frameLon: number): Mat3 {
  const local = enuBasisAtOrigin(localLat, localLon);
  const frame = enuBasisAtOrigin(frameLat, frameLon);
  const localTranspose: Mat3 = [
    [local.Ev[0], local.Nv[0], local.Uv[0]],
    [local.Ev[1], local.Nv[1], local.Uv[1]],
    [local.Ev[2], local.Nv[2], local.Uv[2]],
  ];
  return mat3Mul(frame.B, localTranspose);
}

function formatCoord(value: number): string {
  return value.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
}

export function buildFlightCameraPathDocument(
  input: Omit<FlightExportInput, 'waypoints'> & { samples: FlightSplineSample[]; fps: number }
): FlightCameraPathDocument {
  return {
    schema: 'nodrone-camera-path/1',
    site: input.site,
    surveyId: input.surveyId,
    capturedAt: input.capturedAt ?? null,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    quotable: false,
    mode: input.mode ?? 'smooth-flythrough',
    smoothMode: 'catmull-rom',
    heightReference: 'WGS84 ellipsoid (meters)',
    angleUnits: 'degrees',
    frameCount: input.samples.length,
    render: {
      fps: input.fps,
      resolution: input.resolution,
    },
    samples: input.samples.map((sample) => ({
      t: roundTo(sample.t, 4),
      lat: sample.lat,
      lon: sample.lon,
      height: sample.height,
      heading: sample.heading,
      pitch: sample.pitch,
      roll: sample.roll,
      fovyDeg: input.fovyDeg,
    })),
  };
}

export function buildFlightTrajectoryDocument(
  input: Omit<FlightExportInput, 'waypoints'> & {
    samples: FlightSplineSample[];
    fps: number;
    origin: GeodeticPoint;
    originName?: string;
  }
): FlightTrajectoryDocument {
  const origin = input.origin;
  const originName = input.originName || 'FlightOrigin';
  const intrinsics = computePinholeK(input.resolution[0], input.resolution[1], input.fovyDeg);
  let previous: UnitQuaternion | null = null;
  const trajectory = input.samples.map((sample, index) => {
    const enu = wgs84ToEnuEllipsoidal(sample.lat, sample.lon, sample.height, origin);
    const localRotation = quaternionToRotationMatrix(sample.quaternion);
    const toOrigin = localEnuToFrame(sample.lat, sample.lon, origin.lat, origin.lon);
    let quaternion = rotationMatrixToQuaternion(mat3Mul(toOrigin, localRotation));
    if (previous) quaternion = alignQuaternion(previous, quaternion);
    previous = quaternion;
    return {
      frame: index,
      x_enu: roundTo(enu[0], 6),
      y_enu: roundTo(enu[1], 6),
      z_enu: roundTo(enu[2], 6),
      qx: roundTo(quaternion.qx, 9),
      qy: roundTo(quaternion.qy, 9),
      qz: roundTo(quaternion.qz, 9),
      qw: roundTo(quaternion.qw, 9),
    };
  });

  return {
    site: input.site,
    surveyId: input.surveyId,
    capturedAt: input.capturedAt ?? null,
    convention: 'opencv',
    fps: input.fps,
    quotable: false,
    world: `ENU metres from ${originName} ground point (${formatCoord(origin.lat)}, ${formatCoord(origin.lon)}, ${origin.alt} m ASL): x=East, y=North, z=Up`,
    camera: 'OpenCV: x=right, y=down, z=forward (Blender G-buffer renderer applies OpenCV->OpenGL flip)',
    blender_focal_mm: blenderFocalLengthMm(intrinsics.fx, intrinsics.width, 36),
    sensor_width_mm: 36,
    resolution: input.resolution,
    origin: { ...origin, name: originName },
    heightReference: 'WGS84 ellipsoid (meters)',
    trajectory,
  };
}

export function buildFlightExport(input: FlightExportInput): FlightExportBundle {
  const fovyDeg = input.fovyDeg;
  const spline = sampleFlightSpline(input.waypoints, {
    fps: input.fps,
    speedMps: input.speedMps,
    fovyDeg,
    alpha: CATMULL_ALPHA,
  });
  const origin = spline.origins[0] ?? {
    lat: spline.samples[0]?.lat ?? 0,
    lon: spline.samples[0]?.lon ?? 0,
    alt: spline.samples[0]?.height ?? 0,
  };
  const shared = {
    site: input.site,
    surveyId: input.surveyId,
    capturedAt: input.capturedAt ?? null,
    recordedAt: input.recordedAt,
    resolution: input.resolution,
    fovyDeg,
    fps: spline.fps,
    mode: input.mode,
    samples: spline.samples,
  };
  return {
    spline,
    cameraPath: buildFlightCameraPathDocument(shared),
    trajectory: buildFlightTrajectoryDocument({
      ...shared,
      origin,
      originName: input.waypoints[0]?.name || input.site || 'FlightOrigin',
    }),
  };
}

export function isFlightCameraPathDocument(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && (raw as { schema?: unknown }).schema === 'nodrone-camera-path/1');
}

export function isFlightTrajectoryDocument(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const trajectory = (raw as { trajectory?: unknown }).trajectory;
  if (!Array.isArray(trajectory) || trajectory.length === 0) return false;
  const first = trajectory[0] as { x_enu?: unknown; qw?: unknown } | null;
  return Boolean(first && typeof first.x_enu === 'number' && typeof first.qw === 'number');
}

export function parseFlightCameraPathDocument(raw: unknown, fallbackSite = 'nodrone'): ParsedFlightDocument {
  if (!isFlightCameraPathDocument(raw)) {
    throw new Error('JSON is not a nodrone-camera-path/1 document.');
  }
  const doc = raw as Record<string, any>;
  if (!Array.isArray(doc.samples) || doc.samples.length === 0) {
    throw new Error('Render path contains no samples.');
  }

  const samples: FlightCameraPathSample[] = [];
  for (let i = 0; i < doc.samples.length; i++) {
    const sample = doc.samples[i];
    const lat = Number(sample?.lat);
    const lon = Number(sample?.lon);
    const height = Number(sample?.height);
    const heading = Number(sample?.heading ?? 0);
    const pitch = Number(sample?.pitch ?? -35);
    const roll = Number(sample?.roll ?? 0);
    if (![lat, lon, height, heading, pitch, roll].every((value) => Number.isFinite(value))) {
      throw new Error(`Sample #${i + 1} has invalid numeric camera coordinates/angles.`);
    }
    const fovyRaw = sample?.fovyDeg;
    samples.push({
      t: Number.isFinite(Number(sample?.t)) ? Number(sample.t) : undefined,
      lat,
      lon,
      height,
      heading,
      pitch,
      roll,
      fovyDeg: fovyRaw !== null && fovyRaw !== undefined && Number.isFinite(Number(fovyRaw)) ? Number(fovyRaw) : null,
    });
  }

  let resW = 1920;
  let resH = 1080;
  const resSource = doc.render?.resolution ?? doc.resolution;
  if (Array.isArray(resSource) && resSource.length >= 2) {
    const w = Math.round(Number(resSource[0]));
    const h = Math.round(Number(resSource[1]));
    if (Number.isFinite(w) && Number.isFinite(h) && w >= 64 && h >= 64 && w <= 7680 && h <= 4320) {
      resW = w;
      resH = h;
    }
  }

  let fps = 30;
  const fpsSource = doc.render?.fps ?? doc.fps;
  if (Number.isFinite(Number(fpsSource)) && Number(fpsSource) > 0) {
    fps = Number(fpsSource);
  } else if (samples.length >= 2 && typeof samples[0].t === 'number' && typeof samples[samples.length - 1].t === 'number') {
    const dt = (samples[samples.length - 1].t as number) - (samples[0].t as number);
    if (dt > 0) fps = Math.max(1, Math.min(120, Math.round((samples.length - 1) / dt)));
  }

  const surveyId = typeof doc.surveyId === 'string' && doc.surveyId.trim() ? doc.surveyId.trim() : null;
  return {
    site: String(doc.site || fallbackSite).trim() || fallbackSite,
    surveyId,
    fps,
    resolution: [resW, resH],
    samples,
  };
}

export function parseFlightTrajectoryDocument(raw: unknown, fallbackSite = 'nodrone'): ParsedFlightDocument {
  if (!isFlightTrajectoryDocument(raw)) {
    throw new Error('JSON is not a trajectory.json document.');
  }
  const doc = raw as Record<string, any>;
  const originRaw = doc.origin;
  if (!originRaw || typeof originRaw.lat !== 'number' || typeof originRaw.lon !== 'number' || typeof originRaw.alt !== 'number') {
    throw new Error('trajectory.json is missing a numeric WGS84 origin.');
  }
  const origin: GeodeticPoint = { lat: originRaw.lat, lon: originRaw.lon, alt: originRaw.alt };
  const frames = doc.trajectory as Array<Record<string, unknown>>;
  const samples: FlightCameraPathSample[] = [];
  const fps = Number.isFinite(Number(doc.fps)) && Number(doc.fps) > 0 ? Number(doc.fps) : 30;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const x = Number(frame.x_enu);
    const y = Number(frame.y_enu);
    const z = Number(frame.z_enu);
    const quaternion = {
      qx: Number(frame.qx),
      qy: Number(frame.qy),
      qz: Number(frame.qz),
      qw: Number(frame.qw),
    };
    if (![x, y, z, quaternion.qx, quaternion.qy, quaternion.qz, quaternion.qw].every((value) => Number.isFinite(value))) {
      throw new Error(`Trajectory frame #${i + 1} has invalid ENU pose.`);
    }
    const wgs = enuToWgs84(x, y, z, origin);
    const originRotation = quaternionToRotationMatrix(quaternion);
    const toLocal = localEnuToFrame(origin.lat, origin.lon, wgs.lat, wgs.lon);
    const hpr = quaternionToCesiumHpr(rotationMatrixToQuaternion(mat3Mul(toLocal, originRotation)));
    samples.push({
      t: roundTo(i / fps, 4),
      lat: wgs.lat,
      lon: wgs.lon,
      height: wgs.alt,
      heading: hpr.heading,
      pitch: hpr.pitch,
      roll: hpr.roll,
      fovyDeg: null,
    });
  }

  const resolution = Array.isArray(doc.resolution) && doc.resolution.length >= 2
    ? [Math.round(Number(doc.resolution[0])) || 1920, Math.round(Number(doc.resolution[1])) || 1080] as [number, number]
    : [1920, 1080] as [number, number];
  const surveyId = typeof doc.surveyId === 'string' && doc.surveyId.trim() ? doc.surveyId.trim() : null;
  return {
    site: String(doc.site || fallbackSite).trim() || fallbackSite,
    surveyId,
    fps,
    resolution,
    samples,
  };
}

export function headingDeltaDeg(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}
