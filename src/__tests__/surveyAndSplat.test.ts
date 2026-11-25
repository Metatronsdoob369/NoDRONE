import { describe, expect, it } from 'vitest';
import {
  applySurveySplatRef,
  createDefaultSurveyRecord,
  markSurveySplatLoadError,
  markSurveySplatLoaded,
  normalizeSiteManifest,
  resolveSurveySelection,
} from '../surveyCatalog';
import {
  cesiumCameraToLocalThree,
  inferOverlaySplatFormat,
  isSupportedSplatFileName,
  localThreeEnuToWgs84,
  wgs84ToLocalThreeEnu,
} from '../splatOverlay';
import { cross3, dot3, enuBasisAtOrigin, norm3, sub3, wgs84ToEcef } from '../geodesy';
import type { SurveySplatAnchor } from '../types';

describe('normalizeSiteManifest (v1.0 -> v2.0 upgrade)', () => {
  it('upgrades a Schema 1.0 manifest into Schema 2.0 without losing geodesy, layers, tilesets, or bookmarks', () => {
    const v1Manifest = {
      schemaVersion: '1.0',
      siteId: 'augusta-quarry',
      title: 'Augusta Quarry',
      exportedAt: '2026-05-12T18:30:00.000Z',
      geodesy: {
        sourceCRS: 'NAD83 / NAVD88',
        convertedBy: 'MSP GEOTRANS',
        wgs84Origin: { lat: 33.5021, lon: -82.0226, ellipsoidalHeight: 145.5 },
        verticalOffsetMeters: -3.25,
      },
      layers: {
        worldTerrain: true,
        google3DTiles: false,
        defaultSSE: 6,
        clippingGeoJsonAssetId: 901234,
      },
      tilesets: [
        { name: 'Site Photogrammetry Mesh', ionAssetId: 123456, type: '3dtiles', visible: true },
        { name: 'North Pit 3DGS Splat', ionAssetId: 4547222, type: '3dgs', visible: true },
      ],
      bookmarks: [
        { name: 'Overlook', lat: 33.5021, lon: -82.0226, alt: 420, heading: 45, pitch: -35, roll: 0 },
      ],
    };

    const { manifest, upgradedFromV1 } = normalizeSiteManifest(v1Manifest);

    expect(upgradedFromV1).toBe(true);
    expect(manifest.schemaVersion).toBe('2.0');
    expect(manifest.siteId).toBe('augusta-quarry');
    expect(manifest.title).toBe('Augusta Quarry');
    expect(manifest.geodesy.wgs84Origin).toEqual({
      lat: 33.5021,
      lon: -82.0226,
      ellipsoidalHeight: 145.5,
    });
    expect(manifest.geodesy.verticalOffsetMeters).toBe(-3.25);
    expect(manifest.layers.worldTerrain).toBe(true);
    expect(manifest.layers.defaultSSE).toBe(6);
    expect(manifest.layers.clippingGeoJsonAssetId).toBe(901234);

    expect(manifest.surveys).toHaveLength(1);
    const baseline = manifest.surveys[0];
    expect(baseline.capturedAt).toBe('2026-05-12');
    expect(baseline.provenance.quotable).toBe(false);
    expect(baseline.assets.tilesets).toHaveLength(2);
    expect(baseline.assets.mesh?.ionAssetId).toBe(123456);
    expect(baseline.assets.splat?.ionAssetId).toBe(4547222);
    expect(baseline.bookmarks).toHaveLength(1);
    // Honest status rule: upgrading a v1.0 manifest with a splat ref stays 'captured', not 'processed'
    expect(baseline.status).toBe('captured');
    expect(manifest.activeSurveyId).toBe(baseline.surveyId);
  });

  it('preserves v2.0 per-splat placement fields and defaults missing nudges to 0 / 1 / 0', () => {
    const v2Manifest = {
      schemaVersion: '2.0',
      siteId: 'redmond-campus',
      title: 'Redmond Campus',
      activeSurveyId: '2026-09-01-autumn',
      surveys: [
        {
          surveyId: '2026-09-01-autumn',
          capturedAt: '2026-09-01',
          label: 'Autumn',
          status: 'captured',
          assets: {
            splat: {
              url: 'https://example.com/campus.spz',
              anchor: { lat: 47.6423, lon: -122.1369, baseHeightMeters: 112.4 },
              headingDeg: 27,
              scale: 1.5,
              offsetMeters: -1.2,
            },
            tilesets: [],
          },
          bookmarks: [],
          paths: [],
        },
      ],
    };

    const { manifest, upgradedFromV1 } = normalizeSiteManifest(v2Manifest);
    expect(upgradedFromV1).toBe(false);
    const splat = manifest.surveys[0].assets.splat;
    expect(splat?.url).toBe('https://example.com/campus.spz');
    expect(splat?.format).toBe('spz');
    expect(splat?.anchor).toEqual({ lat: 47.6423, lon: -122.1369, baseHeightMeters: 112.4 });
    expect(splat?.headingDeg).toBe(27);
    expect(splat?.scale).toBe(1.5);
    expect(splat?.offsetMeters).toBe(-1.2);
  });
});

describe('resolveSurveySelection (id, date, prefix, compare)', () => {
  const surveys = [
    createDefaultSurveyRecord({
      surveyId: '2026-10-20-post-storm',
      capturedAt: '2026-10-20',
      label: 'Post Storm',
    }),
    createDefaultSurveyRecord({
      surveyId: '2026-08-14-baseline',
      capturedAt: '2026-08-14',
      label: 'Baseline',
    }),
    createDefaultSurveyRecord({
      surveyId: '2026-06-02-spring-grading',
      capturedAt: '2026-06-02',
      label: 'Spring Grading',
    }),
  ];

  it('matches by exact surveyId', () => {
    const res = resolveSurveySelection(surveys, '2026-08-14-baseline', '2026-10-20-post-storm');
    expect(res.activeSurveyId).toBe('2026-08-14-baseline');
    expect(res.compareSurveyId).toBe('2026-10-20-post-storm');
    expect(res.matchedFromUrl).toBe(true);
  });

  it('matches by exact ISO capture date', () => {
    const res = resolveSurveySelection(surveys, '2026-06-02', '2026-08-14');
    expect(res.activeSurveyId).toBe('2026-06-02-spring-grading');
    expect(res.compareSurveyId).toBe('2026-08-14-baseline');
    expect(res.matchedFromUrl).toBe(true);
  });

  it('matches by surveyId prefix and blocks self-comparison', () => {
    const res = resolveSurveySelection(surveys, '2026-10', '2026-10-20');
    expect(res.activeSurveyId).toBe('2026-10-20-post-storm');
    expect(res.compareSurveyId).toBeNull();
    expect(res.matchedFromUrl).toBe(true);
  });

  it('falls back cleanly when URL query does not match any survey', () => {
    const res = resolveSurveySelection(surveys, 'non-existent', null, '2026-08-14-baseline');
    expect(res.activeSurveyId).toBe('2026-08-14-baseline');
    expect(res.compareSurveyId).toBeNull();
    expect(res.matchedFromUrl).toBe(false);
  });
});

describe('Honest splat status rules', () => {
  it('keeps a new survey with a splat ref at captured (never processed) until loaded', () => {
    const withUrl = createDefaultSurveyRecord({
      label: 'URL Splat',
      splatUrl: 'https://example.com/site.spz',
    });
    expect(withUrl.status).toBe('captured');
    expect(withUrl.assets.splat?.format).toBe('spz');

    const withForcedProcessed = createDefaultSurveyRecord({
      label: 'Forced Processed Attempt',
      status: 'processed',
      splatUrl: 'https://example.com/site.ply',
    });
    expect(withForcedProcessed.status).toBe('captured');

    const withoutCapture = createDefaultSurveyRecord({
      label: 'Planned Only',
    });
    expect(withoutCapture.status).toBe('planned');
  });

  it('does not promote to processed on ref edit or 0 splats; promotes only after load success', () => {
    const survey = createDefaultSurveyRecord({
      label: 'Site Epoch',
      status: 'captured',
    });

    applySurveySplatRef(survey, {
      url: 'https://example.com/model.spz',
      ionAssetId: null,
    });
    expect(survey.status).toBe('captured');

    // 0 splats must NOT promote
    markSurveySplatLoaded(survey, { splatCount: 0 });
    expect(survey.status).toBe('captured');

    // Real load success (> 0 splats) promotes to 'processed'
    const anchor: SurveySplatAnchor = { lat: 38.627, lon: -90.1994, baseHeightMeters: 142 };
    markSurveySplatLoaded(survey, { splatCount: 84210, anchor });
    expect(survey.status).toBe('processed');
    expect(survey.assets.splat?.splatCount).toBe(84210);
    expect(survey.assets.splat?.anchor).toEqual(anchor);
    expect(survey.assets.splat?.lastError).toBeNull();

    // Editing to a new unverified URL demotes back to 'captured' until loaded
    applySurveySplatRef(survey, {
      url: 'https://example.com/updated.ksplat',
      ionAssetId: null,
    });
    expect(survey.status).toBe('captured');
    expect(survey.assets.splat?.format).toBe('ksplat');

    // Ion tileset ready promotes to 'processed'
    applySurveySplatRef(survey, { ionAssetId: 4547222, url: null });
    expect(survey.status).toBe('captured');
    markSurveySplatLoaded(survey, { ionReady: true });
    expect(survey.status).toBe('processed');
  });

  it('preserves prior status and records assets.splat.lastError when loading fails', () => {
    const planned = createDefaultSurveyRecord({ label: 'Planned Site' });
    expect(planned.status).toBe('planned');

    applySurveySplatRef(planned, { url: 'https://example.com/missing.spz', ionAssetId: null });
    expect(planned.status).toBe('planned');

    markSurveySplatLoadError(planned, 'HTTP 404 Not Found fetching splat URL.');
    expect(planned.status).toBe('planned');
    expect(planned.assets.splat?.lastError).toBe('HTTP 404 Not Found fetching splat URL.');

    // Subsequent success clears lastError and promotes
    markSurveySplatLoaded(planned, { splatCount: 15000 });
    expect(planned.status).toBe('processed');
    expect(planned.assets.splat?.lastError).toBeNull();
  });

  it('recognizes supported splat file extensions including query strings', () => {
    expect(isSupportedSplatFileName('https://cdn.example.com/scene.spz?token=abc')).toBe(true);
    expect(isSupportedSplatFileName('scan.PLY')).toBe(true);
    expect(isSupportedSplatFileName('model.splat')).toBe(true);
    expect(isSupportedSplatFileName('export.ksplat#v2')).toBe(true);
    expect(inferOverlaySplatFormat('https://cdn.example.com/a.ksplat?x=1')).toBe('ksplat');
    expect(isSupportedSplatFileName('https://cdn.example.com/mesh.glb')).toBe(false);
  });
});

describe('ENU anchor math (WGS84 <-> local Three.js ENU)', () => {
  const testAnchors: Array<{ name: string; anchor: SurveySplatAnchor }> = [
    { name: 'Augusta, GA', anchor: { lat: 33.5021, lon: -82.0226, baseHeightMeters: 145.2 } },
    { name: 'Redmond, WA', anchor: { lat: 47.6423, lon: -122.1369, baseHeightMeters: 118.0 } },
    { name: 'St. Louis, MO', anchor: { lat: 38.6247, lon: -90.1848, baseHeightMeters: 138.6 } },
    { name: 'Sydney, AU (Southern Hemisphere)', anchor: { lat: -33.8568, lon: 151.2153, baseHeightMeters: 12.5 } },
    { name: 'Denver, CO (High Elevation)', anchor: { lat: 39.7392, lon: -104.9903, baseHeightMeters: 1610.0 } },
  ];

  it('maps the anchor origin itself to (0, 0, 0) and respects +X=East, +Y=Up, +Z=South', () => {
    const anchor: SurveySplatAnchor = { lat: 38.6247, lon: -90.1848, baseHeightMeters: 138.6 };
    const originLocal = wgs84ToLocalThreeEnu(anchor.lat, anchor.lon, anchor.baseHeightMeters, anchor);
    expect(norm3(originLocal)).toBeLessThan(1e-6);

    // Move slightly East -> +X
    const eastPt = wgs84ToLocalThreeEnu(anchor.lat, anchor.lon + 0.001, anchor.baseHeightMeters, anchor);
    expect(eastPt[0]).toBeGreaterThan(70);
    expect(Math.abs(eastPt[2])).toBeLessThan(0.1);

    // Move slightly North -> -Z (since +Z is South)
    const northPt = wgs84ToLocalThreeEnu(anchor.lat + 0.001, anchor.lon, anchor.baseHeightMeters, anchor);
    expect(northPt[2]).toBeLessThan(-100);
    expect(Math.abs(northPt[0])).toBeLessThan(0.1);

    // Move Up 25 m -> +Y = +25 m
    const upPt = wgs84ToLocalThreeEnu(anchor.lat, anchor.lon, anchor.baseHeightMeters + 25, anchor);
    expect(upPt[1]).toBeCloseTo(25, 4);
  });

  it('round-trips WGS84 -> local Three ENU -> WGS84 within 1 cm across global sites and offsets', () => {
    const offsets: Array<[number, number, number]> = [
      [0, 0, 0],
      [15.4, 2.5, -18.2],
      [-120.75, 48.3, 95.6],
      [850.0, -35.0, -640.0],
      [-1800.25, 320.5, 1450.75],
    ];

    for (const { anchor } of testAnchors) {
      for (const [x, y, z] of offsets) {
        const wgs = localThreeEnuToWgs84(x, y, z, anchor);
        const backLocal = wgs84ToLocalThreeEnu(wgs.lat, wgs.lon, wgs.baseHeightMeters, anchor);
        const localErrMeters = norm3(sub3([x, y, z], backLocal));
        expect(localErrMeters).toBeLessThan(0.01); // strictly < 1 cm

        // Also verify reverse order: lat/lon/alt -> local -> lat/lon/alt in ECEF meters
        const ecefA = wgs84ToEcef(wgs.lat, wgs.lon, wgs.baseHeightMeters);
        const wgs2 = localThreeEnuToWgs84(backLocal[0], backLocal[1], backLocal[2], anchor);
        const ecefB = wgs84ToEcef(wgs2.lat, wgs2.lon, wgs2.baseHeightMeters);
        const ecefErrMeters = norm3(sub3(ecefA, ecefB));
        expect(ecefErrMeters).toBeLessThan(0.01); // strictly < 1 cm
      }
    }
  });

  it('transforms Cesium ECEF camera pose into a right-handed orthonormal local Three.js camera', () => {
    const anchor: SurveySplatAnchor = { lat: 47.6423, lon: -122.1369, baseHeightMeters: 118.0 };
    const { Ev, Nv, Uv } = enuBasisAtOrigin(anchor.lat, anchor.lon);
    // Place camera 50m South and 30m Up from anchor, looking North (+Nv), up = +Uv, right = +Ev
    const camGeo = localThreeEnuToWgs84(0, 30, 50, anchor);
    const camEcef = wgs84ToEcef(camGeo.lat, camGeo.lon, camGeo.baseHeightMeters);

    const localCam = cesiumCameraToLocalThree(
      {
        positionWC: camEcef,
        rightWC: Ev,
        upWC: Uv,
        directionWC: Nv,
        fovyDeg: 53.13,
        near: 0.5,
        far: 100000,
        aspect: 16 / 9,
      },
      anchor
    );

    expect(norm3(sub3(localCam.position, [0, 30, 50]))).toBeLessThan(0.01);
    expect(norm3(sub3(localCam.right, [1, 0, 0]))).toBeLessThan(1e-6);
    expect(norm3(sub3(localCam.up, [0, 1, 0]))).toBeLessThan(1e-6);
    // Looking North (-Z in Three), so camera +Z (back) is South (+Z = [0, 0, 1])
    expect(norm3(sub3(localCam.back, [0, 0, 1]))).toBeLessThan(1e-6);

    // Check right-handedness det = dot(right x up, back) === +1
    const det = dot3(cross3(localCam.right, localCam.up), localCam.back);
    expect(det).toBeCloseTo(1, 6);
  });
});
