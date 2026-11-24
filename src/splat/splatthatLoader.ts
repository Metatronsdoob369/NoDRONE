/**
 * Parse/decode step ported from -splatthat.
 *
 * Source repo: https://github.com/Metatronsdoob369/-splatthat
 * Commit: 528bba8189e6dc14dc61261f8b269b6f04e17a42
 * Entry: services/assetLoaderService.ts `loadAssetFromFile`
 *
 * That module renders with Three.js r187 WebGPU (`GaussianSplat`, `SPZLoader`,
 * `SPLATLoader`, `GaussianSplatPLYLoader`). NoDRONE is Cesium, so this file
 * vendors only the decode of .ply / .spz / .splat into a plain cloud. Positions
 * stay in the Geo-Box export frame (Three.js Y-up, X=East, Y=Up, Z=South).
 * The Three.js scene object, grounding, and WebGPU renderer are not ported.
 *
 * .spz follows Niantic SPZ v1–v3 (16-byte NGSP header, gzip, 24-bit positions).
 * SPZ v4 (zstd streams) is rejected with an explicit error.
 */

export type SplatFileFormat = 'ply' | 'spz' | 'splat';

export interface DecodedSplatCloud {
  count: number;
  /** Geo-Box local meters, xyz packed. */
  positions: Float32Array;
  /** Linear scale xyz (not log-scale). */
  scales: Float32Array;
  /** Quaternion xyzw. */
  rotations: Float32Array;
  /** RGBA bytes. */
  colors: Uint8Array;
  sourceFormat: SplatFileFormat;
  truncatedFrom: number | null;
}

export const MAX_RENDER_SPLATS = 20_000;

const SH_C0 = 0.28209479177387814;
const SPZ_COLOR_SCALE = 0.15;
const SPZ_MAGIC = 0x5053474e;
const ROW_SIZE_BYTES = 32;

const PLY_TYPE_SIZE: Record<string, number> = {
  char: 1,
  uchar: 1,
  int8: 1,
  uint8: 1,
  short: 2,
  ushort: 2,
  int16: 2,
  uint16: 2,
  int: 4,
  uint: 4,
  int32: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};

export function splatFormatFromName(name: string): SplatFileFormat | null {
  const cleaned = name.trim().split(/[?#]/)[0].toLowerCase();
  if (cleaned.endsWith('.ply')) return 'ply';
  if (cleaned.endsWith('.spz')) return 'spz';
  if (cleaned.endsWith('.splat')) return 'splat';
  return null;
}

export function splatCloudRadius(cloud: DecodedSplatCloud): number {
  let max = 0;
  for (let i = 0; i < cloud.count; i++) {
    const d = Math.hypot(
      cloud.positions[i * 3],
      cloud.positions[i * 3 + 1],
      cloud.positions[i * 3 + 2]
    );
    if (d > max) max = d;
  }
  return max;
}

function sh0ToByte(coefficient: number): number {
  const channel = 0.5 + SH_C0 * coefficient;
  return Math.max(0, Math.min(255, Math.round(channel * 255)));
}

function sigmoidByte(logit: number): number {
  const value = 1 / (1 + Math.exp(-logit));
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function limitCloud(cloud: DecodedSplatCloud, maxSplats: number): DecodedSplatCloud {
  if (cloud.count <= maxSplats || maxSplats <= 0) {
    return { ...cloud, truncatedFrom: cloud.truncatedFrom };
  }
  const target = Math.max(1, Math.floor(maxSplats));
  const stride = cloud.count / target;
  const positions = new Float32Array(target * 3);
  const scales = new Float32Array(target * 3);
  const rotations = new Float32Array(target * 4);
  const colors = new Uint8Array(target * 4);
  for (let i = 0; i < target; i++) {
    const src = Math.min(cloud.count - 1, Math.floor(i * stride));
    positions.set(cloud.positions.subarray(src * 3, src * 3 + 3), i * 3);
    scales.set(cloud.scales.subarray(src * 3, src * 3 + 3), i * 3);
    rotations.set(cloud.rotations.subarray(src * 4, src * 4 + 4), i * 4);
    colors.set(cloud.colors.subarray(src * 4, src * 4 + 4), i * 4);
  }
  return {
    count: target,
    positions,
    scales,
    rotations,
    colors,
    sourceFormat: cloud.sourceFormat,
    truncatedFrom: cloud.count,
  };
}

function emptyRotations(count: number): Float32Array {
  const rotations = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) rotations[i * 4 + 3] = 1;
  return rotations;
}

export function parseSplatContainer(buffer: ArrayBuffer): DecodedSplatCloud {
  if (buffer.byteLength % ROW_SIZE_BYTES !== 0 || buffer.byteLength === 0) {
    throw new Error('Invalid .splat byte length.');
  }
  const count = buffer.byteLength / ROW_SIZE_BYTES;
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const colors = new Uint8Array(count * 4);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < count; i++) {
    const row = i * ROW_SIZE_BYTES;
    const i3 = i * 3;
    const i4 = i * 4;
    positions[i3] = view.getFloat32(row, true);
    positions[i3 + 1] = view.getFloat32(row + 4, true);
    positions[i3 + 2] = view.getFloat32(row + 8, true);
    scales[i3] = view.getFloat32(row + 12, true);
    scales[i3 + 1] = view.getFloat32(row + 16, true);
    scales[i3 + 2] = view.getFloat32(row + 20, true);
    colors[i4] = bytes[row + 24];
    colors[i4 + 1] = bytes[row + 25];
    colors[i4 + 2] = bytes[row + 26];
    colors[i4 + 3] = bytes[row + 27];
    const qw = (bytes[row + 28] - 128) / 128;
    const qx = (bytes[row + 29] - 128) / 128;
    const qy = (bytes[row + 30] - 128) / 128;
    const qz = (bytes[row + 31] - 128) / 128;
    rotations[i4] = qx;
    rotations[i4 + 1] = qy;
    rotations[i4 + 2] = qz;
    rotations[i4 + 3] = qw;
  }

  return {
    count,
    positions,
    scales,
    rotations,
    colors,
    sourceFormat: 'splat',
    truncatedFrom: null,
  };
}

interface PlyProperty {
  name: string;
  type: string;
}

function findPlyHeaderEnd(bytes: Uint8Array): number {
  const marker = 'end_header';
  const scan = Math.min(bytes.length, 1024 * 1024);
  for (let i = 0; i <= scan - marker.length; i++) {
    let matches = true;
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker.charCodeAt(j)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    let end = i + marker.length;
    if (bytes[end] === 13) end += 1;
    if (bytes[end] === 10) end += 1;
    return end;
  }
  throw new Error('PLY file is missing an end_header marker.');
}

function parsePlyHeader(text: string): {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  count: number;
  properties: PlyProperty[];
} {
  const lines = text.split(/\r\n|\n|\r/);
  if (!lines[0] || lines[0].trim() !== 'ply') {
    throw new Error('PLY file is missing the ply magic.');
  }
  let format: 'ascii' | 'binary_little_endian' | 'binary_big_endian' | null = null;
  let count = 0;
  let inVertex = false;
  const properties: PlyProperty[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('comment') || line.startsWith('obj_info')) continue;
    if (line.startsWith('format ')) {
      const kind = line.slice(7).trim().split(/\s+/)[0];
      if (kind === 'ascii' || kind === 'binary_little_endian' || kind === 'binary_big_endian') {
        format = kind;
      } else {
        throw new Error(`Unsupported PLY format "${kind}".`);
      }
      continue;
    }
    if (line.startsWith('element ')) {
      const parts = line.split(/\s+/);
      inVertex = parts[1] === 'vertex';
      if (inVertex) count = Number(parts[2]);
      continue;
    }
    if (line.startsWith('property ') && inVertex) {
      const parts = line.split(/\s+/);
      if (parts[1] === 'list') {
        throw new Error('Gaussian splat PLY vertex properties cannot be lists.');
      }
      properties.push({ type: parts[1], name: parts[2] });
    }
  }
  if (!format) throw new Error('PLY header is missing a format line.');
  if (!Number.isFinite(count) || count < 0) throw new Error('PLY vertex count is invalid.');
  const names = new Set(properties.map((property) => property.name));
  const required = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'];
  if (required.some((name) => !names.has(name))) {
    throw new Error('PLY file requires position, scale, rotation, f_dc and opacity properties.');
  }
  return { format, count, properties };
}

function readPlyNumber(view: DataView, offset: number, type: string, littleEndian: boolean): number {
  switch (type) {
    case 'char':
    case 'int8':
      return view.getInt8(offset);
    case 'uchar':
    case 'uint8':
      return view.getUint8(offset);
    case 'short':
    case 'int16':
      return view.getInt16(offset, littleEndian);
    case 'ushort':
    case 'uint16':
      return view.getUint16(offset, littleEndian);
    case 'int':
    case 'int32':
      return view.getInt32(offset, littleEndian);
    case 'uint':
    case 'uint32':
      return view.getUint32(offset, littleEndian);
    case 'float':
    case 'float32':
      return view.getFloat32(offset, littleEndian);
    case 'double':
    case 'float64':
      return view.getFloat64(offset, littleEndian);
    default:
      throw new Error(`Unsupported PLY property type "${type}".`);
  }
}

function cloudFromGaussianRows(
  count: number,
  rows: Array<Record<string, number>>,
  sourceFormat: SplatFileFormat
): DecodedSplatCloud {
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const colors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const row = rows[i];
    const i3 = i * 3;
    const i4 = i * 4;
    positions[i3] = row.x;
    positions[i3 + 1] = row.y;
    positions[i3 + 2] = row.z;
    scales[i3] = Math.exp(row.scale_0);
    scales[i3 + 1] = Math.exp(row.scale_1);
    scales[i3 + 2] = Math.exp(row.scale_2);
    rotations[i4] = row.rot_1;
    rotations[i4 + 1] = row.rot_2;
    rotations[i4 + 2] = row.rot_3;
    rotations[i4 + 3] = row.rot_0;
    colors[i4] = sh0ToByte(row.f_dc_0);
    colors[i4 + 1] = sh0ToByte(row.f_dc_1);
    colors[i4 + 2] = sh0ToByte(row.f_dc_2);
    colors[i4 + 3] = sigmoidByte(row.opacity);
  }
  return {
    count,
    positions,
    scales,
    rotations,
    colors,
    sourceFormat,
    truncatedFrom: null,
  };
}

export function parsePlyGaussians(buffer: ArrayBuffer): DecodedSplatCloud {
  const bytes = new Uint8Array(buffer);
  const headerEnd = findPlyHeaderEnd(bytes);
  const header = parsePlyHeader(new TextDecoder().decode(bytes.subarray(0, headerEnd)));
  const rows: Array<Record<string, number>> = [];

  if (header.format === 'ascii') {
    const tokens = new TextDecoder()
      .decode(bytes.subarray(headerEnd))
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0);
    let cursor = 0;
    for (let i = 0; i < header.count; i++) {
      const row: Record<string, number> = {};
      for (const property of header.properties) {
        const value = Number(tokens[cursor]);
        cursor += 1;
        if (!Number.isFinite(value)) {
          throw new Error('PLY ascii vertex data ended early.');
        }
        row[property.name] = value;
      }
      rows.push(row);
    }
  } else {
    const littleEndian = header.format === 'binary_little_endian';
    const stride = header.properties.reduce((sum, property) => {
      const size = PLY_TYPE_SIZE[property.type];
      if (!size) throw new Error(`Unsupported PLY property type "${property.type}".`);
      return sum + size;
    }, 0);
    const needed = headerEnd + stride * header.count;
    if (bytes.byteLength < needed) {
      throw new Error('PLY binary vertex data ended early.');
    }
    const view = new DataView(buffer);
    for (let i = 0; i < header.count; i++) {
      let offset = headerEnd + i * stride;
      const row: Record<string, number> = {};
      for (const property of header.properties) {
        row[property.name] = readPlyNumber(view, offset, property.type, littleEndian);
        offset += PLY_TYPE_SIZE[property.type];
      }
      rows.push(row);
    }
  }

  if (header.count === 0) {
    return {
      count: 0,
      positions: new Float32Array(),
      scales: new Float32Array(),
      rotations: new Float32Array(),
      colors: new Uint8Array(),
      sourceFormat: 'ply',
      truncatedFrom: null,
    };
  }
  return cloudFromGaussianRows(header.count, rows, 'ply');
}

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This runtime cannot gunzip .spz data.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function unpackSpzQuaternionV2(r0: number, r1: number, r2: number): [number, number, number, number] {
  const x = (r0 - 127.5) / 127.5;
  const y = (r1 - 127.5) / 127.5;
  const z = (r2 - 127.5) / 127.5;
  const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
  return [x, y, z, w];
}

function unpackSpzQuaternionV3(bytes: Uint8Array, offset: number): [number, number, number, number] {
  const comp =
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24);
  const largest = (comp >>> 30) & 3;
  const rest = comp & 0x3fffffff;
  const chunks = [(rest >>> 20) & 0x3ff, (rest >>> 10) & 0x3ff, rest & 0x3ff];
  const q = [0, 0, 0, 0];
  let sum = 0;
  let chunkIndex = 0;
  for (let i = 0; i < 4; i++) {
    if (i === largest) continue;
    const chunk = chunks[chunkIndex];
    chunkIndex += 1;
    const negative = (chunk >>> 9) & 1;
    const magnitude = chunk & 0x1ff;
    const value = (negative ? -1 : 1) * (magnitude / 511) * Math.SQRT1_2;
    q[i] = value;
    sum += value * value;
  }
  q[largest] = Math.sqrt(Math.max(0, 1 - sum));
  return [q[0], q[1], q[2], q[3]];
}

function readI24(bytes: Uint8Array, offset: number): number {
  let value = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  if (value & 0x800000) value |= ~0xffffff;
  return value;
}

export async function parseSpzGaussians(buffer: ArrayBuffer): Promise<DecodedSplatCloud> {
  const packed = await gunzipBytes(new Uint8Array(buffer));
  if (packed.byteLength < 16) {
    throw new Error('SPZ file is shorter than the NGSP header.');
  }
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== SPZ_MAGIC) {
    throw new Error('SPZ file is missing the NGSP magic.');
  }
  const version = view.getUint32(4, true);
  const count = view.getUint32(8, true);
  const fractionalBits = packed[13];
  if (version >= 4) {
    throw new Error(`SPZ v${version} (zstd) is outside the ported -splatthat loader. Use .spz v2/v3, .ply, or .splat.`);
  }
  if (version < 1 || count < 0) {
    throw new Error(`Unsupported SPZ version ${version}.`);
  }
  const rotationBytes = version >= 3 ? 4 : 3;
  const body =
    count * 9 + count + count * 3 + count * 3 + count * rotationBytes;
  if (packed.byteLength < 16 + body) {
    throw new Error('SPZ payload ended early.');
  }

  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const rotations = count > 0 ? new Float32Array(count * 4) : emptyRotations(0);
  const colors = new Uint8Array(count * 4);
  const positionScale = 1 / (1 << fractionalBits);
  let offset = 16;

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    positions[i3] = readI24(packed, offset) * positionScale;
    positions[i3 + 1] = readI24(packed, offset + 3) * positionScale;
    positions[i3 + 2] = readI24(packed, offset + 6) * positionScale;
    offset += 9;
  }
  const alphaOffset = offset;
  offset += count;
  const colorOffset = offset;
  offset += count * 3;
  const scaleOffset = offset;
  offset += count * 3;
  const rotationOffset = offset;

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const i4 = i * 4;
    const logX = packed[scaleOffset + i3] / 16 - 10;
    const logY = packed[scaleOffset + i3 + 1] / 16 - 10;
    const logZ = packed[scaleOffset + i3 + 2] / 16 - 10;
    scales[i3] = Math.exp(logX);
    scales[i3 + 1] = Math.exp(logY);
    scales[i3 + 2] = Math.exp(logZ);

    const shR = (packed[colorOffset + i3] / 255 - 0.5) / SPZ_COLOR_SCALE;
    const shG = (packed[colorOffset + i3 + 1] / 255 - 0.5) / SPZ_COLOR_SCALE;
    const shB = (packed[colorOffset + i3 + 2] / 255 - 0.5) / SPZ_COLOR_SCALE;
    colors[i4] = sh0ToByte(shR);
    colors[i4 + 1] = sh0ToByte(shG);
    colors[i4 + 2] = sh0ToByte(shB);
    colors[i4 + 3] = packed[alphaOffset + i];

    const quat =
      version >= 3
        ? unpackSpzQuaternionV3(packed, rotationOffset + i * 4)
        : unpackSpzQuaternionV2(
            packed[rotationOffset + i * 3],
            packed[rotationOffset + i * 3 + 1],
            packed[rotationOffset + i * 3 + 2]
          );
    rotations[i4] = quat[0];
    rotations[i4 + 1] = quat[1];
    rotations[i4 + 2] = quat[2];
    rotations[i4 + 3] = quat[3];
  }

  return {
    count,
    positions,
    scales,
    rotations,
    colors,
    sourceFormat: 'spz',
    truncatedFrom: null,
  };
}

function sniffFormat(buffer: ArrayBuffer, hinted: SplatFileFormat | 'auto'): SplatFileFormat {
  if (hinted !== 'auto') return hinted;
  const bytes = new Uint8Array(buffer.slice(0, 64));
  const head = new TextDecoder().decode(bytes);
  if (head.startsWith('ply')) return 'ply';
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'spz';
  if (buffer.byteLength >= 4) {
    const magic = new DataView(buffer).getUint32(0, true);
    if (magic === SPZ_MAGIC) return 'spz';
  }
  if (buffer.byteLength % ROW_SIZE_BYTES === 0) return 'splat';
  throw new Error('Unrecognized splat bytes. Expected .ply, .spz, or .splat.');
}

/**
 * Decodes a survey splat. Large clouds are stride-sampled to `maxSplats` so
 * the Cesium mount stays off the long-frame path. Callers that need the full
 * cloud can pass a higher cap.
 */
export async function parseSplatCloud(
  buffer: ArrayBuffer,
  format: SplatFileFormat | 'auto' = 'auto',
  maxSplats = MAX_RENDER_SPLATS
): Promise<DecodedSplatCloud> {
  const resolved = sniffFormat(buffer, format);
  const decoded =
    resolved === 'ply'
      ? parsePlyGaussians(buffer)
      : resolved === 'spz'
        ? await parseSpzGaussians(buffer)
        : parseSplatContainer(buffer);
  if (decoded.count <= 0) {
    throw new Error('Splat file contains no gaussians.');
  }
  return limitCloud(decoded, maxSplats);
}
