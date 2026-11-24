/**
 * Geo-Box export frame used by the capture rig in cesiumApp (`threeJsLocalMeters`):
 * Three.js Y-up, right-handed, X = East, Y = Up from the anchor, Z = South (= −North).
 *
 * Cesium places the cloud in local ENU (X = East, Y = North, Z = Up) at the anchor.
 */

export interface SplatSiteOrigin {
  lat: number;
  lon: number;
  ellipsoidalHeight: number;
}

export interface SplatGeoBoxOrigin {
  lat: number;
  lon: number;
  baseEllipsoidalMeters: number;
}

export interface SplatAnchorSpec {
  lat: number;
  lon: number;
  height: number;
}

export interface SplatAnchorInput {
  siteOrigin: SplatSiteOrigin;
  surveyVerticalOffsetMeters?: number | null;
  siteVerticalOffsetMeters?: number | null;
  /** Locked Geo-Box A1 origin. This is the export-frame anchor when a box is drawn. */
  geoBoxOrigin?: SplatGeoBoxOrigin | null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Anchor for a survey splat.
 *
 * Horizontal position is the locked Geo-Box center when a box exists, otherwise
 * the site WGS84 origin. Height is that origin's ellipsoidal height plus the
 * survey `verticalOffsetMeters` (the site offset when the survey has none).
 */
export function resolveSplatAnchor(input: SplatAnchorInput): SplatAnchorSpec {
  const offset =
    finiteOrNull(input.surveyVerticalOffsetMeters) ??
    finiteOrNull(input.siteVerticalOffsetMeters) ??
    0;
  const box = input.geoBoxOrigin;
  if (
    box &&
    Number.isFinite(box.lat) &&
    Number.isFinite(box.lon) &&
    Number.isFinite(box.baseEllipsoidalMeters)
  ) {
    return {
      lat: box.lat,
      lon: box.lon,
      height: box.baseEllipsoidalMeters + offset,
    };
  }
  return {
    lat: input.siteOrigin.lat,
    lon: input.siteOrigin.lon,
    height: input.siteOrigin.ellipsoidalHeight + offset,
  };
}

function dropSignedZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** Maps one Geo-Box local point (X=East, Y=Up, Z=South) into ENU meters. */
export function geoBoxLocalToEnu(x: number, y: number, z: number): { e: number; n: number; u: number } {
  return { e: dropSignedZero(x), n: dropSignedZero(-z), u: dropSignedZero(y) };
}
