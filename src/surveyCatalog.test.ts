import { describe, expect, it } from 'vitest';
import { createDefaultSurveyRecord, normalizeSiteManifest, resolveSurveySelection } from './surveyCatalog';

describe('normalizeSiteManifest', () => {
  it('upgrades a v1 manifest into a v2 survey catalog', () => {
    const v1 = {
      schemaVersion: '1.0',
      siteId: 'clubhouse',
      title: 'Clubhouse',
      exportedAt: '2026-06-01T12:00:00.000Z',
      geodesy: {
        sourceCRS: 'NAD83 / NAVD88',
        convertedBy: 'MSP GEOTRANS',
        wgs84Origin: { lat: 35.1, lon: -80.8, ellipsoidalHeight: 200 },
        verticalOffsetMeters: 1.5,
      },
      layers: {
        worldTerrain: true,
        google3DTiles: false,
        defaultSSE: 16,
        clippingGeoJsonAssetId: 99,
      },
      tilesets: [
        { name: 'Mesh', ionAssetId: 123, type: '3dtiles', visible: true, clippingGeoJsonAssetId: 99 },
      ],
      bookmarks: [
        { name: 'Overview', lat: 35.1, lon: -80.8, alt: 300, heading: 10, pitch: -35, roll: 0 },
      ],
    };

    const { manifest, upgradedFromV1 } = normalizeSiteManifest(v1);

    expect(upgradedFromV1).toBe(true);
    expect(manifest.schemaVersion).toBe('2.0');
    expect(manifest.siteId).toBe('clubhouse');
    expect(manifest.title).toBe('Clubhouse');
    expect(manifest.geodesy.sourceCRS).toBe('NAD83 / NAVD88');
    expect(manifest.geodesy.wgs84Origin).toEqual({ lat: 35.1, lon: -80.8, ellipsoidalHeight: 200 });
    expect(manifest.geodesy.verticalOffsetMeters).toBe(1.5);
    expect(manifest.layers).toEqual({
      worldTerrain: true,
      google3DTiles: false,
      defaultSSE: 16,
      clippingGeoJsonAssetId: 99,
    });
    expect(manifest.surveys).toHaveLength(1);
    expect(manifest.surveys[0].surveyId).toBe('2026-06-01-baseline-survey');
    expect(manifest.surveys[0].capturedAt).toBe('2026-06-01');
    expect(manifest.surveys[0].bookmarks[0]).toMatchObject({ name: 'Overview', lat: 35.1, lon: -80.8, alt: 300 });
    expect(manifest.surveys[0].assets.tilesets[0].ionAssetId).toBe(123);
    expect(manifest.activeSurveyId).toBe(manifest.surveys[0].surveyId);
    expect(manifest.tilesets[0].ionAssetId).toBe(123);
    expect(manifest.bookmarks[0].name).toBe('Overview');
  });
});

describe('resolveSurveySelection', () => {
  const older = createDefaultSurveyRecord({
    surveyId: '2026-05-01-baseline',
    capturedAt: '2026-05-01',
    label: 'Baseline',
  });
  const newer = createDefaultSurveyRecord({
    surveyId: '2026-08-14-roof',
    capturedAt: '2026-08-14',
    label: 'Roof',
  });
  const surveys = [older, newer];

  it('selects a survey by exact id', () => {
    expect(resolveSurveySelection(surveys, '2026-08-14-roof', null, older.surveyId)).toEqual({
      activeSurveyId: '2026-08-14-roof',
      compareSurveyId: null,
      matchedFromUrl: true,
    });
  });

  it('selects a survey by capture date and a compare target by date', () => {
    expect(resolveSurveySelection(surveys, '2026-05-01', '2026-08-14', null)).toEqual({
      activeSurveyId: '2026-05-01-baseline',
      compareSurveyId: '2026-08-14-roof',
      matchedFromUrl: true,
    });
  });
});
