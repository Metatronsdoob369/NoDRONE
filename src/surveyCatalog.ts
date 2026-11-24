import type {
  CameraBookmark,
  SiteManifest,
  SurveyAssetBundle,
  SurveyCompareHook,
  SurveyPathRef,
  SurveyRecord,
  SurveyStatus,
  SurveyTilesetRef,
} from './types';

const VALID_STATUSES: SurveyStatus[] = ['planned', 'captured', 'processed'];

export function toIsoDateOnly(input?: string | null): string {
  if (input && typeof input === 'string') {
    const trimmed = input.trim();
    const dateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) return dateMatch[1];
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}

export function slugifySurveySegment(input: string, fallback = 'survey'): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36);
  return slug || fallback;
}

export function createSurveyId(
  capturedAt: string,
  label: string,
  existingIds: Iterable<string> = []
): string {
  const taken = new Set(existingIds);
  const datePart = toIsoDateOnly(capturedAt);
  const labelPart = slugifySurveySegment(label, 'epoch');
  const base = `${datePart}-${labelPart}`;
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

export function normalizeSurveyStatus(value: unknown): SurveyStatus {
  const s = String(value ?? '').toLowerCase();
  if (VALID_STATUSES.includes(s as SurveyStatus)) {
    return s as SurveyStatus;
  }
  return 'planned';
}

export function classifyTilesetRefs(
  tilesets: SurveyTilesetRef[]
): { mesh: SurveyTilesetRef | null; splat: SurveyAssetBundle['splat'] } {
  let mesh: SurveyTilesetRef | null = null;
  let splat: SurveyAssetBundle['splat'] = null;
  for (const t of tilesets) {
    const typeLower = String(t.type || '').toLowerCase();
    const nameLower = String(t.name || '').toLowerCase();
    const isSplat =
      typeLower.includes('3dgs') ||
      typeLower.includes('splat') ||
      nameLower.includes('splat') ||
      nameLower.includes('3dgs') ||
      nameLower.includes('gaussian');
    if (isSplat && !splat) {
      splat = {
        name: t.name,
        ionAssetId: t.ionAssetId,
        format: '3dtiles-3dgs',
      };
    } else if (!mesh) {
      mesh = { ...t };
    }
  }
  return { mesh, splat };
}

export function createDefaultSurveyRecord(options?: {
  surveyId?: string;
  capturedAt?: string;
  label?: string;
  status?: SurveyStatus;
  notes?: string;
  verticalOffsetMeters?: number;
  tilesets?: SurveyTilesetRef[];
  bookmarks?: CameraBookmark[];
  clippingGeoJsonAssetId?: number | null;
  imageryProvider?: string;
  splatUrl?: string | null;
  splatAssetId?: number | null;
  existingIds?: Iterable<string>;
}): SurveyRecord {
  const nowIso = new Date().toISOString();
  const capturedAt = toIsoDateOnly(options?.capturedAt);
  const label = (options?.label || 'Baseline Survey').trim() || 'Baseline Survey';
  const surveyId =
    (options?.surveyId || '').trim() ||
    createSurveyId(capturedAt, label, options?.existingIds);

  const tilesets: SurveyTilesetRef[] = Array.isArray(options?.tilesets)
    ? options!.tilesets.map((t) => ({ ...t }))
    : [];
  const classified = classifyTilesetRefs(tilesets);
  const splat =
    options?.splatUrl || options?.splatAssetId
      ? {
          name: classified.splat?.name || `${label} Splat`,
          ionAssetId: options?.splatAssetId ?? classified.splat?.ionAssetId ?? null,
          url: options?.splatUrl ?? null,
          format: options?.splatUrl?.toLowerCase().endsWith('.ply')
            ? 'ply'
            : options?.splatUrl?.toLowerCase().endsWith('.spz')
              ? 'spz'
              : '3dtiles-3dgs',
        }
      : classified.splat;

  const status: SurveyStatus = options?.status
    ? normalizeSurveyStatus(options.status)
    : tilesets.length > 0 || splat
      ? 'processed'
      : 'planned';

  return {
    surveyId,
    capturedAt,
    label,
    status,
    notes: options?.notes?.trim() || undefined,
    verticalOffsetMeters:
      typeof options?.verticalOffsetMeters === 'number' && Number.isFinite(options.verticalOffsetMeters)
        ? Number(options.verticalOffsetMeters.toFixed(2))
        : undefined,
    assets: {
      imagery: {
        provider: options?.imageryProvider || 'Cesium World / Esri Satellite',
        capturedAt,
      },
      mesh: classified.mesh,
      splat,
      tilesets,
      clippingGeoJsonAssetId: options?.clippingGeoJsonAssetId ?? null,
      bundleProvenanceSha256: null,
    },
    bookmarks: Array.isArray(options?.bookmarks)
      ? options!.bookmarks.map((b) => ({ ...b }))
      : [],
    paths: [],
    provenance: {
      quotable: false,
      provenanceTag: 'observed_guide_internal',
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  };
}

function sanitizeTilesets(raw: unknown, fallbackClipId: number | null): SurveyTilesetRef[] {
  if (!Array.isArray(raw)) return [];
  const out: SurveyTilesetRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const ionAssetId = Number(rec.ionAssetId ?? rec.assetId ?? rec.id);
    if (!Number.isFinite(ionAssetId) || ionAssetId <= 0) continue;
    out.push({
      name: String(rec.name || `Asset #${ionAssetId}`),
      ionAssetId,
      type: String(rec.type || '3dtiles'),
      visible: rec.visible !== false,
      clippingGeoJsonAssetId:
        typeof rec.clippingGeoJsonAssetId === 'number'
          ? rec.clippingGeoJsonAssetId
          : fallbackClipId,
    });
  }
  return out;
}

function sanitizeBookmarks(raw: unknown): CameraBookmark[] {
  if (!Array.isArray(raw)) return [];
  const out: CameraBookmark[] = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const rec = b as Record<string, unknown>;
    if (typeof rec.lat !== 'number' || typeof rec.lon !== 'number') continue;
    out.push({
      name: String(rec.name || `View ${out.length + 1}`),
      lat: rec.lat,
      lon: rec.lon,
      alt: typeof rec.alt === 'number' ? rec.alt : 300,
      heading: typeof rec.heading === 'number' ? rec.heading : 0,
      pitch: typeof rec.pitch === 'number' ? rec.pitch : -35,
      roll: typeof rec.roll === 'number' ? rec.roll : 0,
    });
  }
  return out;
}

function sanitizePaths(raw: unknown): SurveyPathRef[] {
  if (!Array.isArray(raw)) return [];
  const out: SurveyPathRef[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const rec = p as Record<string, unknown>;
    out.push({
      pathId: String(rec.pathId || `path-${out.length + 1}`),
      name: String(rec.name || `Flight Path ${out.length + 1}`),
      format:
        rec.format === 'ges-tracking' ||
        rec.format === 'camera-matrices' ||
        rec.format === 'splatthat-bundle'
          ? rec.format
          : 'nodrone-camera-path/1',
      url: typeof rec.url === 'string' ? rec.url : null,
      sampleCount: typeof rec.sampleCount === 'number' ? rec.sampleCount : undefined,
      smoothMode: rec.smoothMode === 'catmull-rom' ? 'catmull-rom' : 'linear',
    });
  }
  return out;
}

export function sortSurveysNewestFirst(surveys: SurveyRecord[]): SurveyRecord[] {
  return [...surveys].sort((a, b) => {
    const cmp = b.capturedAt.localeCompare(a.capturedAt);
    if (cmp !== 0) return cmp;
    return b.provenance.updatedAt.localeCompare(a.provenance.updatedAt);
  });
}

export interface NormalizedManifestResult {
  manifest: SiteManifest;
  upgradedFromV1: boolean;
}

/**
 * Normalizes either a Schema 1.0 or Schema 2.0 SiteManifest into a clean v2.0
 * Survey Catalog manifest without losing any site-level geodesy or layer settings.
 */
export function normalizeSiteManifest(raw: unknown): NormalizedManifestResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid manifest JSON structure.');
  }
  const obj = raw as Record<string, unknown>;
  const nowIso = new Date().toISOString();
  const title = String(obj.title || obj.siteId || 'SplatMap Site').trim() || 'SplatMap Site';
  const siteId =
    String(obj.siteId || '').trim() || slugifySurveySegment(title, 'splatmap-site');

  const rawGeodesy = (obj.geodesy && typeof obj.geodesy === 'object'
    ? obj.geodesy
    : {}) as Record<string, unknown>;
  const rawOrigin = (rawGeodesy.wgs84Origin && typeof rawGeodesy.wgs84Origin === 'object'
    ? rawGeodesy.wgs84Origin
    : {}) as Record<string, unknown>;
  const rawLayers = (obj.layers && typeof obj.layers === 'object'
    ? obj.layers
    : {}) as Record<string, unknown>;

  const defaultClipId =
    typeof rawLayers.clippingGeoJsonAssetId === 'number'
      ? rawLayers.clippingGeoJsonAssetId
      : null;
  const defaultVertOffset =
    typeof rawGeodesy.verticalOffsetMeters === 'number' && Number.isFinite(rawGeodesy.verticalOffsetMeters)
      ? rawGeodesy.verticalOffsetMeters
      : 0;

  const hasSurveysArray = Array.isArray(obj.surveys) && obj.surveys.length > 0;
  let surveys: SurveyRecord[] = [];
  let upgradedFromV1 = false;

  if (hasSurveysArray) {
    const usedIds = new Set<string>();
    for (const item of obj.surveys as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const s = item as Record<string, unknown>;
      const capturedAt = toIsoDateOnly(
        typeof s.capturedAt === 'string'
          ? s.capturedAt
          : typeof obj.exportedAt === 'string'
            ? obj.exportedAt
            : nowIso
      );
      const label = String(s.label || 'Survey Epoch').trim() || 'Survey Epoch';
      const requestedId = typeof s.surveyId === 'string' ? s.surveyId.trim() : '';
      const surveyId =
        requestedId && !usedIds.has(requestedId)
          ? requestedId
          : createSurveyId(capturedAt, label, usedIds);
      usedIds.add(surveyId);

      const rawAssets = (s.assets && typeof s.assets === 'object'
        ? s.assets
        : {}) as Record<string, unknown>;
      const clipId =
        typeof rawAssets.clippingGeoJsonAssetId === 'number'
          ? rawAssets.clippingGeoJsonAssetId
          : defaultClipId;
      const tilesets = sanitizeTilesets(rawAssets.tilesets ?? s.tilesets, clipId);
      const classified = classifyTilesetRefs(tilesets);

      const rawImagery =
        rawAssets.imagery && typeof rawAssets.imagery === 'object'
          ? (rawAssets.imagery as Record<string, unknown>)
          : null;
      const rawSplat =
        rawAssets.splat && typeof rawAssets.splat === 'object'
          ? (rawAssets.splat as Record<string, unknown>)
          : null;
      const rawMesh =
        rawAssets.mesh && typeof rawAssets.mesh === 'object'
          ? sanitizeTilesets([rawAssets.mesh], clipId)[0] ?? null
          : classified.mesh;
      const rawProv =
        s.provenance && typeof s.provenance === 'object'
          ? (s.provenance as Record<string, unknown>)
          : {};

      const splat = rawSplat
        ? {
            name: typeof rawSplat.name === 'string' ? rawSplat.name : undefined,
            ionAssetId: typeof rawSplat.ionAssetId === 'number' ? rawSplat.ionAssetId : null,
            url: typeof rawSplat.url === 'string' ? rawSplat.url : null,
            format: typeof rawSplat.format === 'string' ? rawSplat.format : undefined,
          }
        : classified.splat;

      surveys.push({
        surveyId,
        capturedAt,
        label,
        status: normalizeSurveyStatus(s.status ?? (tilesets.length > 0 || splat ? 'processed' : 'planned')),
        notes: typeof s.notes === 'string' && s.notes.trim() ? s.notes.trim() : undefined,
        verticalOffsetMeters:
          typeof s.verticalOffsetMeters === 'number' && Number.isFinite(s.verticalOffsetMeters)
            ? Number(s.verticalOffsetMeters.toFixed(2))
            : defaultVertOffset,
        assets: {
          imagery: rawImagery
            ? {
                provider: String(rawImagery.provider || 'Cesium World / Esri Satellite'),
                ionAssetId: typeof rawImagery.ionAssetId === 'number' ? rawImagery.ionAssetId : null,
                capturedAt:
                  typeof rawImagery.capturedAt === 'string'
                    ? toIsoDateOnly(rawImagery.capturedAt)
                    : capturedAt,
                url: typeof rawImagery.url === 'string' ? rawImagery.url : null,
              }
            : { provider: 'Cesium World / Esri Satellite', capturedAt },
          mesh: rawMesh,
          splat,
          tilesets,
          clippingGeoJsonAssetId: clipId,
          bundleProvenanceSha256:
            typeof rawAssets.bundleProvenanceSha256 === 'string'
              ? rawAssets.bundleProvenanceSha256
              : null,
        },
        bookmarks: sanitizeBookmarks(s.bookmarks),
        paths: sanitizePaths(s.paths),
        provenance: {
          quotable: false,
          provenanceTag: 'observed_guide_internal',
          createdAt: typeof rawProv.createdAt === 'string' ? rawProv.createdAt : nowIso,
          updatedAt: typeof rawProv.updatedAt === 'string' ? rawProv.updatedAt : nowIso,
        },
      });
    }
  } else {
    upgradedFromV1 = true;
    const legacyTilesets = sanitizeTilesets(obj.tilesets, defaultClipId);
    const legacyBookmarks = sanitizeBookmarks(obj.bookmarks);
    const exportedDate = toIsoDateOnly(
      typeof obj.exportedAt === 'string' ? obj.exportedAt : nowIso
    );
    surveys = [
      createDefaultSurveyRecord({
        capturedAt: exportedDate,
        label: 'Baseline Survey',
        verticalOffsetMeters: defaultVertOffset,
        tilesets: legacyTilesets,
        bookmarks: legacyBookmarks,
        clippingGeoJsonAssetId: defaultClipId,
      }),
    ];
  }

  surveys = sortSurveysNewestFirst(surveys);
  if (surveys.length === 0) {
    surveys = [createDefaultSurveyRecord({ label: 'Baseline Survey' })];
  }

  const rawActiveId = typeof obj.activeSurveyId === 'string' ? obj.activeSurveyId.trim() : '';
  const activeSurvey =
    surveys.find((s) => s.surveyId === rawActiveId) || surveys[0];

  const rawHook = (obj.comparisonHook && typeof obj.comparisonHook === 'object'
    ? obj.comparisonHook
    : {}) as Record<string, unknown>;
  const rawCompareId =
    typeof obj.compareSurveyId === 'string'
      ? obj.compareSurveyId.trim()
      : typeof rawHook.targetSurveyId === 'string'
        ? rawHook.targetSurveyId.trim()
        : '';
  const compareSurvey =
    rawCompareId && rawCompareId !== activeSurvey.surveyId
      ? surveys.find((s) => s.surveyId === rawCompareId) || null
      : null;

  const comparisonHook: SurveyCompareHook = {
    baselineSurveyId: activeSurvey.surveyId,
    targetSurveyId: compareSurvey ? compareSurvey.surveyId : null,
    mode:
      compareSurvey && (rawHook.mode === 'split' || rawHook.mode === 'swipe')
        ? rawHook.mode
        : 'off',
  };

  return {
    upgradedFromV1,
    manifest: {
      schemaVersion: '2.0',
      siteId,
      title,
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : nowIso,
      activeSurveyId: activeSurvey.surveyId,
      compareSurveyId: compareSurvey ? compareSurvey.surveyId : null,
      comparisonHook,
      geodesy: {
        sourceCRS: String(rawGeodesy.sourceCRS || 'NAD83 / NAVD88'),
        convertedBy: String(rawGeodesy.convertedBy || 'MSP GEOTRANS'),
        wgs84Origin: {
          lat: typeof rawOrigin.lat === 'number' ? rawOrigin.lat : 38.5,
          lon: typeof rawOrigin.lon === 'number' ? rawOrigin.lon : -96.0,
          ellipsoidalHeight:
            typeof rawOrigin.ellipsoidalHeight === 'number' ? rawOrigin.ellipsoidalHeight : 300,
        },
        verticalOffsetMeters: defaultVertOffset,
      },
      layers: {
        worldTerrain: Boolean(rawLayers.worldTerrain),
        google3DTiles: Boolean(rawLayers.google3DTiles),
        defaultSSE: typeof rawLayers.defaultSSE === 'number' ? rawLayers.defaultSSE : 8,
        clippingGeoJsonAssetId: activeSurvey.assets.clippingGeoJsonAssetId,
      },
      surveys,
      tilesets: activeSurvey.assets.tilesets.map((t) => ({ ...t })),
      bookmarks: activeSurvey.bookmarks.map((b) => ({ ...b })),
    },
  };
}

/**
 * Resolves a requested `?survey=` and optional `?compare=` query parameter against a catalog.
 * Supports exact `surveyId` match or YYYY-MM-DD date prefix match.
 */
export function resolveSurveySelection(
  surveys: SurveyRecord[],
  requestedSurveyId?: string | null,
  requestedCompareId?: string | null,
  fallbackActiveId?: string | null
): { activeSurveyId: string; compareSurveyId: string | null; matchedFromUrl: boolean } {
  if (surveys.length === 0) {
    return { activeSurveyId: '', compareSurveyId: null, matchedFromUrl: false };
  }

  const findMatch = (query?: string | null): SurveyRecord | undefined => {
    const q = (query || '').trim().toLowerCase();
    if (!q) return undefined;
    return (
      surveys.find((s) => s.surveyId.toLowerCase() === q) ||
      surveys.find((s) => s.capturedAt.toLowerCase() === q) ||
      surveys.find((s) => s.surveyId.toLowerCase().startsWith(q))
    );
  };

  const urlMatch = findMatch(requestedSurveyId);
  const fallbackMatch = findMatch(fallbackActiveId);
  const active = urlMatch || fallbackMatch || surveys[0];

  const compareCandidate = findMatch(requestedCompareId);
  const compareSurveyId =
    compareCandidate && compareCandidate.surveyId !== active.surveyId
      ? compareCandidate.surveyId
      : null;

  return {
    activeSurveyId: active.surveyId,
    compareSurveyId,
    matchedFromUrl: Boolean(urlMatch),
  };
}
