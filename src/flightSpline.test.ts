import { describe, expect, it } from 'vitest';
import { enuToWgs84, wgs84ToEnuEllipsoidal, type GeodeticPoint, type Vec3 } from './geodesy';
import {
  alignQuaternion,
  alignQuaternionChain,
  buildFlightExport,
  centripetalCatmullRom,
  cesiumHprToQuaternion,
  FLIGHT_SEGMENT_LIMIT_METERS,
  headingDeltaDeg,
  negateQuaternion,
  parseFlightCameraPathDocument,
  parseFlightTrajectoryDocument,
  quaternionDot,
  quaternionToCesiumHpr,
  sampleFlightSpline,
  slerpQuaternion,
  wgs84SeparationMeters,
  type FlightWaypoint,
} from './flightSpline';

const ORIGIN: GeodeticPoint = { lat: 35.2271, lon: -80.8431, alt: 250 };

function vecDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function nearestMeters(samples: { lat: number; lon: number; height: number }[], point: FlightWaypoint): number {
  return Math.min(...samples.map((sample) => wgs84SeparationMeters(
    { lat: sample.lat, lon: sample.lon, alt: sample.height },
    { lat: point.lat, lon: point.lon, alt: point.alt }
  )));
}

const CLUBHOUSE: FlightWaypoint[] = [
  { name: 'North', lat: 35.2271, lon: -80.8431, alt: 280, heading: 170, pitch: -35, roll: 0 },
  { name: 'East', lat: 35.2264, lon: -80.8418, alt: 310, heading: 250, pitch: -28, roll: 4 },
  { name: 'South', lat: 35.22555, lon: -80.8434, alt: 295, heading: 20, pitch: -40, roll: -6 },
  { name: 'West', lat: 35.2267, lon: -80.8446, alt: 330, heading: 90, pitch: -22, roll: 2 },
];

describe('centripetal Catmull-Rom', () => {
  it('passes through the segment endpoints and stays on a straight run', () => {
    const p0: Vec3 = [-10, 0, 5];
    const p1: Vec3 = [0, 0, 5];
    const p2: Vec3 = [10, 0, 5];
    const p3: Vec3 = [20, 0, 5];
    expect(vecDistance(centripetalCatmullRom(p0, p1, p2, p3, 0), p1)).toBeLessThan(1e-9);
    expect(vecDistance(centripetalCatmullRom(p0, p1, p2, p3, 1), p2)).toBeLessThan(1e-9);
    const mid = centripetalCatmullRom(p0, p1, p2, p3, 0.5);
    expect(Math.abs(mid[0] - 5)).toBeLessThan(0.01);
    expect(Math.abs(mid[1])).toBeLessThan(0.01);
    expect(Math.abs(mid[2] - 5)).toBeLessThan(0.01);
  });
});

describe('flight spline', () => {
  it('passes within 1 cm of every waypoint', () => {
    const spline = sampleFlightSpline(CLUBHOUSE, { fps: 30, speedMps: 18 });
    expect(spline.samples.length).toBeGreaterThan(CLUBHOUSE.length);
    for (const waypoint of CLUBHOUSE) {
      expect(nearestMeters(spline.samples, waypoint)).toBeLessThan(0.01);
    }
  });

  it('drops duplicate knots and still hits the remaining waypoints', () => {
    const duplicate = { ...CLUBHOUSE[0], name: 'North copy' };
    const spline = sampleFlightSpline([CLUBHOUSE[0], duplicate, CLUBHOUSE[1]], { fps: 20, speedMps: 16 });
    expect(nearestMeters(spline.samples, CLUBHOUSE[0])).toBeLessThan(0.01);
    expect(nearestMeters(spline.samples, CLUBHOUSE[1])).toBeLessThan(0.01);
    expect(spline.segmentCount).toBe(1);
  });

  it('splits a hop past 50 km onto a new ENU origin', () => {
    const east = { ...CLUBHOUSE[0], lon: CLUBHOUSE[0].lon + 0.95, name: 'Far' };
    const beyond = { ...east, lat: east.lat + 0.01, name: 'Farther' };
    const hop = wgs84SeparationMeters(
      { lat: CLUBHOUSE[0].lat, lon: CLUBHOUSE[0].lon, alt: CLUBHOUSE[0].alt },
      { lat: east.lat, lon: east.lon, alt: east.alt }
    );
    expect(hop).toBeGreaterThan(FLIGHT_SEGMENT_LIMIT_METERS);
    const spline = sampleFlightSpline([CLUBHOUSE[0], east, beyond], { fps: 2, speedMps: 4000 });
    expect(spline.segmentCount).toBe(2);
    expect(nearestMeters(spline.samples, CLUBHOUSE[0])).toBeLessThan(0.01);
    expect(nearestMeters(spline.samples, east)).toBeLessThan(0.01);
    expect(nearestMeters(spline.samples, beyond)).toBeLessThan(0.01);
  });
});

describe('WGS84 ENU round trip', () => {
  it('returns to the same point within 1 mm', () => {
    const points: GeodeticPoint[] = [
      ORIGIN,
      { lat: 35.23, lon: -80.84, alt: 400 },
      { lat: 35.2, lon: -80.9, alt: 1200 },
      { lat: -33.8688, lon: 151.2093, alt: 58 },
      { lat: 64.1466, lon: -21.9426, alt: 15 },
    ];
    for (const point of points) {
      const enu = wgs84ToEnuEllipsoidal(point.lat, point.lon, point.alt, ORIGIN);
      const back = enuToWgs84(enu[0], enu[1], enu[2], ORIGIN);
      expect(wgs84SeparationMeters(point, back)).toBeLessThan(0.001);
    }
  });
});

describe('quaternion continuity', () => {
  it('flips the hemisphere when the dot product is negative', () => {
    const start = cesiumHprToQuaternion(20, -30, 0);
    const flipped = negateQuaternion(start);
    expect(quaternionDot(start, flipped)).toBeLessThan(0);
    expect(quaternionDot(start, alignQuaternion(start, flipped))).toBeGreaterThan(0);
    const aligned = alignQuaternionChain([start, flipped, cesiumHprToQuaternion(80, -20, 0)]);
    for (let i = 1; i < aligned.length; i++) {
      expect(quaternionDot(aligned[i - 1], aligned[i])).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps sampled attitudes on the short arc without sign flips', () => {
    const wrap: FlightWaypoint[] = [
      { name: 'A', lat: 35.2271, lon: -80.8431, alt: 300, heading: 350, pitch: -25, roll: 0 },
      { name: 'B', lat: 35.2282, lon: -80.8422, alt: 320, heading: 10, pitch: -25, roll: 8 },
      { name: 'C', lat: 35.229, lon: -80.8414, alt: 340, heading: 80, pitch: -15, roll: -4 },
    ];
    const spline = sampleFlightSpline(wrap, { fps: 30, speedMps: 20 });
    expect(spline.samples.length).toBeGreaterThan(4);
    for (let i = 1; i < spline.samples.length; i++) {
      expect(quaternionDot(spline.samples[i - 1].quaternion, spline.samples[i].quaternion)).toBeGreaterThanOrEqual(0);
    }
    for (const sample of spline.samples) {
      const heading = ((sample.heading % 360) + 360) % 360;
      const onShortArc = heading >= 340 || heading <= 90;
      expect(onShortArc).toBe(true);
    }
    const mid = slerpQuaternion(
      cesiumHprToQuaternion(0, -20, 0),
      cesiumHprToQuaternion(90, -20, 0),
      0.5
    );
    expect(headingDeltaDeg(quaternionToCesiumHpr(mid).heading, 45)).toBeLessThan(1);
  });

  it('round-trips heading pitch and roll through the attitude quaternion', () => {
    const cases: Array<[number, number, number]> = [
      [0, 0, 0],
      [90, -35, 0],
      [180, -10, 15],
      [270, 20, -25],
      [15, -80, 5],
      [350, -5, 0],
    ];
    for (const [heading, pitch, roll] of cases) {
      const back = quaternionToCesiumHpr(cesiumHprToQuaternion(heading, pitch, roll));
      expect(headingDeltaDeg(heading, back.heading)).toBeLessThan(0.02);
      expect(Math.abs(pitch - back.pitch)).toBeLessThan(0.02);
      expect(Math.abs(roll - back.roll)).toBeLessThan(0.02);
    }
  });
});

describe('flight path export', () => {
  it('stamps surveyId and round-trips camera-path.json and trajectory.json', () => {
    const bundle = buildFlightExport({
      site: 'Clubhouse',
      surveyId: '2026-08-14-roof',
      capturedAt: '2026-08-14',
      recordedAt: '2026-11-24T00:00:00.000Z',
      resolution: [1280, 720],
      fovyDeg: 53.13,
      waypoints: CLUBHOUSE,
      fps: 30,
      speedMps: 18,
    });

    expect(bundle.cameraPath.schema).toBe('nodrone-camera-path/1');
    expect(bundle.cameraPath.surveyId).toBe('2026-08-14-roof');
    expect(bundle.cameraPath.smoothMode).toBe('catmull-rom');
    expect(bundle.trajectory.surveyId).toBe('2026-08-14-roof');
    expect(bundle.trajectory.convention).toBe('opencv');
    expect(bundle.trajectory.trajectory).toHaveLength(bundle.spline.samples.length);

    const camera = parseFlightCameraPathDocument(JSON.parse(JSON.stringify(bundle.cameraPath)));
    expect(camera.surveyId).toBe('2026-08-14-roof');
    expect(camera.fps).toBe(30);
    expect(camera.resolution).toEqual([1280, 720]);
    expect(camera.samples).toHaveLength(bundle.spline.samples.length);
    for (let i = 0; i < camera.samples.length; i++) {
      const source = bundle.spline.samples[i];
      const loaded = camera.samples[i];
      expect(wgs84SeparationMeters(
        { lat: source.lat, lon: source.lon, alt: source.height },
        { lat: loaded.lat, lon: loaded.lon, alt: loaded.height }
      )).toBeLessThan(0.001);
      expect(headingDeltaDeg(source.heading, loaded.heading)).toBeLessThan(0.001);
      expect(Math.abs(source.pitch - loaded.pitch)).toBeLessThan(0.001);
      expect(Math.abs(source.roll - loaded.roll)).toBeLessThan(0.001);
    }

    const trajectory = parseFlightTrajectoryDocument(JSON.parse(JSON.stringify(bundle.trajectory)));
    expect(trajectory.surveyId).toBe('2026-08-14-roof');
    expect(trajectory.samples).toHaveLength(bundle.spline.samples.length);
    for (let i = 0; i < trajectory.samples.length; i++) {
      const source = bundle.spline.samples[i];
      const loaded = trajectory.samples[i];
      expect(wgs84SeparationMeters(
        { lat: source.lat, lon: source.lon, alt: source.height },
        { lat: loaded.lat, lon: loaded.lon, alt: loaded.height }
      )).toBeLessThan(0.001);
      expect(headingDeltaDeg(source.heading, loaded.heading)).toBeLessThan(0.05);
      expect(Math.abs(source.pitch - loaded.pitch)).toBeLessThan(0.05);
      expect(Math.abs(source.roll - loaded.roll)).toBeLessThan(0.05);
    }
  });
});
