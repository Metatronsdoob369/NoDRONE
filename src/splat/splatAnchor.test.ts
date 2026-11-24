import { describe, expect, it } from 'vitest';
import { geoBoxLocalToEnu, resolveSplatAnchor } from './splatAnchor';

describe('resolveSplatAnchor', () => {
  it('places the splat at the site origin plus the survey vertical offset', () => {
    expect(
      resolveSplatAnchor({
        siteOrigin: { lat: 35.1, lon: -80.8, ellipsoidalHeight: 200 },
        surveyVerticalOffsetMeters: 1.5,
        siteVerticalOffsetMeters: 9,
      })
    ).toEqual({ lat: 35.1, lon: -80.8, height: 201.5 });
  });

  it('falls back to the site vertical offset when the survey has none', () => {
    expect(
      resolveSplatAnchor({
        siteOrigin: { lat: 33.5021, lon: -82.0226, ellipsoidalHeight: 450 },
        surveyVerticalOffsetMeters: null,
        siteVerticalOffsetMeters: 2.25,
      })
    ).toEqual({ lat: 33.5021, lon: -82.0226, height: 452.25 });
  });

  it('uses the locked Geo-Box center as the export-frame anchor', () => {
    expect(
      resolveSplatAnchor({
        siteOrigin: { lat: 1, lon: 2, ellipsoidalHeight: 3 },
        surveyVerticalOffsetMeters: 4,
        geoBoxOrigin: { lat: 35.2, lon: -80.7, baseEllipsoidalMeters: 210 },
      })
    ).toEqual({ lat: 35.2, lon: -80.7, height: 214 });
  });
});

describe('geoBoxLocalToEnu', () => {
  it('matches the Geo-Box export frame (X=East, Y=Up, Z=South)', () => {
    expect(geoBoxLocalToEnu(12, 0, 0)).toEqual({ e: 12, n: 0, u: 0 });
    expect(geoBoxLocalToEnu(0, 7.5, 0)).toEqual({ e: 0, n: 0, u: 7.5 });
    expect(geoBoxLocalToEnu(0, 0, 4)).toEqual({ e: 0, n: -4, u: 0 });
    // threeJsLocalMeters stores [east, up, -north]
    const east = 3;
    const north = 5;
    const up = 1.25;
    expect(geoBoxLocalToEnu(east, up, -north)).toEqual({ e: east, n: north, u: up });
  });
});
