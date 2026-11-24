import { deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  parsePlyGaussians,
  parseSplatCloud,
  parseSplatContainer,
  parseSpzGaussians,
  splatFormatFromName,
} from './splatthatLoader';

function splatRow(position: [number, number, number], color: [number, number, number, number]): ArrayBuffer {
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setFloat32(0, position[0], true);
  view.setFloat32(4, position[1], true);
  view.setFloat32(8, position[2], true);
  view.setFloat32(12, 0.2, true);
  view.setFloat32(16, 0.1, true);
  view.setFloat32(20, 0.05, true);
  bytes[24] = color[0];
  bytes[25] = color[1];
  bytes[26] = color[2];
  bytes[27] = color[3];
  bytes[28] = 255;
  bytes[29] = 128;
  bytes[30] = 128;
  bytes[31] = 128;
  return buffer;
}

describe('splatFormatFromName', () => {
  it('reads the extension from a URL with a query string', () => {
    expect(splatFormatFromName('https://cdn.example.com/a/scene.ply?raw=1')).toBe('ply');
    expect(splatFormatFromName('roof.SPZ')).toBe('spz');
    expect(splatFormatFromName('cloud.splat#tile')).toBe('splat');
    expect(splatFormatFromName('4547222')).toBeNull();
  });
});

describe('parseSplatContainer', () => {
  it('decodes fixed-width .splat rows', () => {
    const a = splatRow([1, 2, 3], [10, 20, 30, 255]);
    const b = splatRow([-4, 0.5, 8], [1, 2, 3, 128]);
    const combined = new Uint8Array(64);
    combined.set(new Uint8Array(a), 0);
    combined.set(new Uint8Array(b), 32);
    const cloud = parseSplatContainer(combined.buffer);
    expect(cloud.count).toBe(2);
    expect(cloud.sourceFormat).toBe('splat');
    expect(Array.from(cloud.positions.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(cloud.colors.subarray(0, 4))).toEqual([10, 20, 30, 255]);
    expect(cloud.scales[0]).toBeCloseTo(0.2);
    expect(cloud.rotations[3]).toBeCloseTo((255 - 128) / 128);
    expect(cloud.rotations[0]).toBeCloseTo(0);
  });
});

describe('parsePlyGaussians', () => {
  it('decodes a binary little-endian gaussian PLY', () => {
    const names = [
      'x', 'y', 'z',
      'scale_0', 'scale_1', 'scale_2',
      'rot_0', 'rot_1', 'rot_2', 'rot_3',
      'f_dc_0', 'f_dc_1', 'f_dc_2',
      'opacity',
    ];
    const header = `ply\nformat binary_little_endian 1.0\nelement vertex 1\n${names
      .map((name) => `property float ${name}`)
      .join('\n')}\nend_header\n`;
    const headerBytes = new TextEncoder().encode(header);
    const body = new ArrayBuffer(names.length * 4);
    const view = new DataView(body);
    const values = [
      4, 5, 6,
      Math.log(0.25), Math.log(0.25), Math.log(0.25),
      1, 0, 0, 0,
      0, 0, 0,
      8,
    ];
    values.forEach((value, index) => view.setFloat32(index * 4, value, true));
    const bytes = new Uint8Array(headerBytes.byteLength + body.byteLength);
    bytes.set(headerBytes, 0);
    bytes.set(new Uint8Array(body), headerBytes.byteLength);
    const cloud = parsePlyGaussians(bytes.buffer);
    expect(cloud.count).toBe(1);
    expect(Array.from(cloud.positions)).toEqual([4, 5, 6]);
    expect(cloud.scales[0]).toBeCloseTo(0.25);
    expect(cloud.rotations[3]).toBeCloseTo(1);
    expect(cloud.colors[0]).toBe(128);
    expect(cloud.colors[3]).toBe(255);
  });
});

describe('parseSpzGaussians', () => {
  it('round-trips one gzipped SPZ v2 gaussian', async () => {
    const count = 1;
    const fractionalBits = 12;
    const header = new Uint8Array(16);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x5053474e, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, count, true);
    header[12] = 0;
    header[13] = fractionalBits;
    const scale = 1 << fractionalBits;
    const position = new Uint8Array(9);
    const writeI24 = (offset: number, meters: number) => {
      const fixed = Math.round(meters * scale);
      position[offset] = fixed & 0xff;
      position[offset + 1] = (fixed >> 8) & 0xff;
      position[offset + 2] = (fixed >> 16) & 0xff;
    };
    writeI24(0, 1);
    writeI24(3, -2);
    writeI24(6, 0.5);
    const alpha = new Uint8Array([200]);
    const color = new Uint8Array([255, 128, 0]);
    const scales = new Uint8Array([160, 160, 160]);
    const rotation = new Uint8Array([128, 128, 128]);
    const raw = new Uint8Array(16 + 9 + 1 + 3 + 3 + 3);
    raw.set(header, 0);
    raw.set(position, 16);
    raw.set(alpha, 25);
    raw.set(color, 26);
    raw.set(scales, 29);
    raw.set(rotation, 32);
    const gzip = gzipSync(raw);
    const cloud = await parseSpzGaussians(gzip.buffer.slice(gzip.byteOffset, gzip.byteOffset + gzip.byteLength));
    expect(cloud.count).toBe(1);
    expect(cloud.sourceFormat).toBe('spz');
    expect(cloud.positions[0]).toBeCloseTo(1, 3);
    expect(cloud.positions[1]).toBeCloseTo(-2, 3);
    expect(cloud.positions[2]).toBeCloseTo(0.5, 3);
    expect(cloud.colors[3]).toBe(200);
    expect(cloud.scales[0]).toBeCloseTo(Math.exp(160 / 16 - 10), 5);
    expect(cloud.rotations[0]).toBeCloseTo(0.5 / 127.5, 5);
    expect(cloud.rotations[3]).toBeCloseTo(Math.sqrt(1 - 3 * (0.5 / 127.5) ** 2), 5);
  });

  it('rejects a zlib wrapper that is not gzip NGSP', async () => {
    const junk = deflateSync(Buffer.from('not a splat'));
    await expect(parseSplatCloud(junk.buffer.slice(junk.byteOffset, junk.byteOffset + junk.byteLength), 'spz')).rejects.toThrow(
      /NGSP|gunzip|SPZ/
    );
  });
});
