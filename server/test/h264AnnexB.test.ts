import { describe, expect, it } from 'vitest';
import { H264_NAL_TYPE, H264AnnexBParser } from '../src/emulator/h264AnnexB.ts';

const SC4 = [0x00, 0x00, 0x00, 0x01];
const SC3 = [0x00, 0x00, 0x01];

const SPS_1 = [0x67, 0x64, 0x00, 0x28, 0xac, 0xd9];
const PPS_1 = [0x68, 0xee, 0x3c, 0x80];
const SPS_2 = [0x67, 0x64, 0x00, 0x33, 0xac, 0xd9];
const PPS_2 = [0x68, 0xee, 0x3c, 0x81];
const AUD = [0x09, 0xf0];
const SEI = [0x06, 0x05, 0x04, 0xde, 0xad, 0xbe, 0xef];
const IDR_1 = [0x65, 0x88, 0x84, 0x21];
const IDR_SLICE_2 = [0x65, 0x02, 0x33, 0x44];
const DELTA_1 = [0x41, 0x9a, 0x02, 0x11];
const DELTA_SLICE_2 = [0x41, 0x02, 0x55, 0x66];
const DELTA_2 = [0x41, 0x9e, 0x04, 0x22];

function bytes(...parts: number[][]): Buffer {
  return Buffer.from(parts.flat());
}

function splitNalUnits(stream: Buffer): { type: number; data: Buffer }[] {
  const starts: { at: number; codeLength: number }[] = [];
  for (let i = 0; i + 2 < stream.length; i += 1) {
    if (stream[i] !== 0 || stream[i + 1] !== 0) continue;
    if (stream[i + 2] === 1) {
      const isLong = i > 0 && stream[i - 1] === 0;
      starts.push({ at: isLong ? i - 1 : i, codeLength: isLong ? 4 : 3 });
      i += 2;
    }
  }
  return starts.flatMap(({ at, codeLength }, idx) => {
    const from = at + codeLength;
    const to = starts[idx + 1]?.at ?? stream.length;
    const first = stream[from];
    if (first === undefined || to <= from) return [];
    return [{ type: first & 0x1f, data: stream.subarray(from, to) }];
  });
}

describe('H264AnnexBParser', () => {
  it('emits config packet (SPS+PPS) and coded key/delta packets', () => {
    const parser = new H264AnnexBParser();
    const stream = bytes(SC4, SPS_1, SC4, PPS_1, SC4, IDR_1, SC3, DELTA_1, SC4, DELTA_2);

    const pushed = parser.push(stream);
    const flushed = parser.flush();
    const packets = [...pushed, ...flushed];

    expect(packets).toHaveLength(4);
    expect(packets[0]).toMatchObject({ isConfig: true, isKey: false });
    expect(splitNalUnits(packets[0]!.data)).toEqual([
      { type: H264_NAL_TYPE.sps, data: Buffer.from(SPS_1) },
      { type: H264_NAL_TYPE.pps, data: Buffer.from(PPS_1) },
    ]);

    expect(packets[1]).toMatchObject({ isConfig: false, isKey: true });
    expect(splitNalUnits(packets[1]!.data)).toEqual([
      { type: H264_NAL_TYPE.sliceIdr, data: Buffer.from(IDR_1) },
    ]);

    expect(packets[2]).toMatchObject({ isConfig: false, isKey: false });
    expect(splitNalUnits(packets[2]!.data)).toEqual([
      { type: H264_NAL_TYPE.sliceNonIdr, data: Buffer.from(DELTA_1) },
    ]);

    expect(packets[3]).toMatchObject({ isConfig: false, isKey: false });
    expect(splitNalUnits(packets[3]!.data)).toEqual([
      { type: H264_NAL_TYPE.sliceNonIdr, data: Buffer.from(DELTA_2) },
    ]);
  });

  it('produces identical packets when split byte-by-byte across start codes and NAL boundaries', () => {
    const stream = bytes(
      [0xff, 0xaa], // leading noise before first start code
      SC4,
      SPS_1,
      SC3,
      PPS_1,
      SC4,
      IDR_1,
      SC3,
      DELTA_1,
    );

    const parser = new H264AnnexBParser();
    const packets = [];
    for (let i = 0; i < stream.length; i += 1) {
      packets.push(...parser.push(stream.subarray(i, i + 1)));
    }
    packets.push(...parser.flush());

    expect(packets).toHaveLength(3);
    expect(packets[0]!.isConfig).toBe(true);
    expect(packets[1]).toEqual({ isConfig: false, isKey: true, data: bytes(SC4, IDR_1) });
    expect(packets[2]).toEqual({ isConfig: false, isKey: false, data: bytes(SC4, DELTA_1) });
  });

  it('handles start-code zero-byte prefixes split across chunks without corrupting NAL payloads', () => {
    const parser = new H264AnnexBParser();
    const idrWithTrailingZero = [0x65, 0x88, 0x00];
    const p1 = parser.push(bytes(SC4, SPS_1, SC4, PPS_1, SC4, idrWithTrailingZero, [0x00, 0x00]));
    const p2 = parser.push(bytes([0x00, 0x01], DELTA_1));
    const p3 = parser.flush();
    const all = [...p1, ...p2, ...p3];

    expect(all).toHaveLength(3);
    expect(splitNalUnits(all[1]!.data)).toEqual([
      { type: H264_NAL_TYPE.sliceIdr, data: Buffer.from(idrWithTrailingZero) },
    ]);
    expect(splitNalUnits(all[2]!.data)).toEqual([
      { type: H264_NAL_TYPE.sliceNonIdr, data: Buffer.from(DELTA_1) },
    ]);
  });

  it('suppresses duplicate SPS/PPS config packets and re-emits when SPS or PPS changes', () => {
    const parser = new H264AnnexBParser();
    const packets = [
      ...parser.push(
        bytes(
          SC4,
          SPS_1,
          SC4,
          PPS_1,
          SC4,
          IDR_1,
          // Repeated identical SPS/PPS at next keyframe -> no duplicate config
          SC4,
          SPS_1,
          SC4,
          PPS_1,
          SC4,
          IDR_1,
          // Resolution/level change -> new SPS + new PPS -> emits updated config
          SC4,
          SPS_2,
          SC4,
          PPS_2,
          SC4,
          IDR_1,
          // Only PPS changed -> still emits updated config with latest SPS+PPS
          SC4,
          PPS_1,
          SC4,
          IDR_1,
        ),
      ),
      ...parser.flush(),
    ];

    expect(packets.map((p) => [p.isConfig, p.isKey])).toEqual([
      [true, false],
      [false, true],
      [false, true],
      [true, false],
      [false, true],
      [true, false],
      [false, true],
    ]);
    expect(splitNalUnits(packets[3]!.data)).toEqual([
      { type: H264_NAL_TYPE.sps, data: Buffer.from(SPS_2) },
      { type: H264_NAL_TYPE.pps, data: Buffer.from(PPS_2) },
    ]);
    expect(splitNalUnits(packets[5]!.data)).toEqual([
      { type: H264_NAL_TYPE.sps, data: Buffer.from(SPS_2) },
      { type: H264_NAL_TYPE.pps, data: Buffer.from(PPS_1) },
    ]);
  });

  it('drops AUD/SEI/filler NAL units while preserving access-unit boundaries', () => {
    const parser = new H264AnnexBParser();
    const packets = [
      ...parser.push(
        bytes(
          SC4,
          AUD,
          SC4,
          SPS_1,
          SC4,
          PPS_1,
          SC4,
          SEI,
          SC4,
          IDR_1,
          SC4,
          AUD,
          SC4,
          SEI,
          SC4,
          DELTA_1,
          SC4,
          [0x0c, 0xff], // filler data
          SC4,
          DELTA_2,
        ),
      ),
      ...parser.flush(),
    ];

    expect(packets).toHaveLength(4);
    expect(packets.map((p) => [p.isConfig, p.isKey])).toEqual([
      [true, false],
      [false, true],
      [false, false],
      [false, false],
    ]);
    for (const packet of packets.slice(1)) {
      const types = splitNalUnits(packet.data).map((u) => u.type);
      expect(types).not.toContain(H264_NAL_TYPE.aud);
      expect(types).not.toContain(H264_NAL_TYPE.sei);
      expect(types).not.toContain(H264_NAL_TYPE.filler);
    }
  });

  it('groups multi-slice pictures into one access unit using first_mb_in_slice', () => {
    const parser = new H264AnnexBParser();
    const packets = [
      ...parser.push(
        bytes(
          SC4,
          SPS_1,
          SC4,
          PPS_1,
          SC4,
          IDR_1,
          SC4,
          IDR_SLICE_2,
          SC4,
          DELTA_1,
          SC4,
          DELTA_SLICE_2,
          SC4,
          DELTA_2,
        ),
      ),
      ...parser.flush(),
    ];

    expect(packets).toHaveLength(4);
    expect(splitNalUnits(packets[1]!.data)).toEqual([
      { type: H264_NAL_TYPE.sliceIdr, data: Buffer.from(IDR_1) },
      { type: H264_NAL_TYPE.sliceIdr, data: Buffer.from(IDR_SLICE_2) },
    ]);
    expect(splitNalUnits(packets[2]!.data)).toEqual([
      { type: H264_NAL_TYPE.sliceNonIdr, data: Buffer.from(DELTA_1) },
      { type: H264_NAL_TYPE.sliceNonIdr, data: Buffer.from(DELTA_SLICE_2) },
    ]);
    expect(splitNalUnits(packets[3]!.data)).toEqual([
      { type: H264_NAL_TYPE.sliceNonIdr, data: Buffer.from(DELTA_2) },
    ]);
  });

  it('emits config immediately when chunk boundary falls between start code and slice header', () => {
    const parser = new H264AnnexBParser();
    expect(parser.push(bytes(SC4, SPS_1, SC4, PPS_1, SC4))).toEqual([]);
    const p2 = parser.push(Buffer.from(IDR_1));
    expect(p2).toHaveLength(1);
    expect(p2[0]!.isConfig).toBe(true);
    expect(parser.flush()).toEqual([{ isConfig: false, isKey: true, data: bytes(SC4, IDR_1) }]);
  });

  it('resets state cleanly and rejects unbounded non-Annex-B streams', () => {
    const parser = new H264AnnexBParser();
    parser.push(bytes(SC4, SPS_1, SC4, PPS_1, SC4, IDR_1));
    parser.reset();
    expect(parser.flush()).toEqual([]);

    expect(() => parser.push(Buffer.alloc(32 * 1024 * 1024 + 1, 0xaa))).toThrow(/exceeded/);
  });
});
