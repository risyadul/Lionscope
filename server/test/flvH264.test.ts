import { describe, expect, it } from 'vitest';
import { FlvH264Parser } from '../src/emulator/flvH264.ts';

const SC4 = [0x00, 0x00, 0x00, 0x01];
const SPS_1 = [0x67, 0x64, 0x00, 0x28, 0xac, 0xd9];
const PPS_1 = [0x68, 0xee, 0x3c, 0x80];
const SPS_2 = [0x67, 0x64, 0x00, 0x33, 0xac, 0xd9];
const PPS_2 = [0x68, 0xee, 0x3c, 0x81];
const IDR_1 = [0x65, 0x88, 0x84, 0x21];
const DELTA_1 = [0x41, 0x9a, 0x02, 0x11];
const SEI = [0x06, 0x05, 0x04, 0xde, 0xad];
const AUD = [0x09, 0xf0];

function flvHeader(dataOffset = 9): Buffer {
  const buf = Buffer.alloc(dataOffset + 4);
  buf.write('FLV', 0, 'ascii');
  buf[3] = 1;
  buf[4] = 1; // video
  buf.writeUInt32BE(dataOffset, 5);
  buf.writeUInt32BE(0, dataOffset); // PreviousTagSize0
  return buf;
}

function flvTag(tagType: number, body: Buffer, timestampMs = 0): Buffer {
  const out = Buffer.alloc(11 + body.length + 4);
  out[0] = tagType;
  out[1] = (body.length >> 16) & 0xff;
  out[2] = (body.length >> 8) & 0xff;
  out[3] = body.length & 0xff;
  out[4] = (timestampMs >> 16) & 0xff;
  out[5] = (timestampMs >> 8) & 0xff;
  out[6] = timestampMs & 0xff;
  out[7] = (timestampMs >> 24) & 0xff;
  body.copy(out, 11);
  out.writeUInt32BE(11 + body.length, 11 + body.length);
  return out;
}

function avcSeqHeader(spsList: number[][], ppsList: number[][], lengthSize: 1 | 2 | 3 | 4 = 4): Buffer {
  const sps = spsList[0] ?? SPS_1;
  const parts: Buffer[] = [
    Buffer.from([0x17, 0x00, 0x00, 0x00, 0x00]), // keyframe + AVC(7), avcPacketType=0
    Buffer.from([
      0x01,
      sps[1] ?? 0x64,
      sps[2] ?? 0x00,
      sps[3] ?? 0x28,
      0xfc | ((lengthSize - 1) & 0x03),
      0xe0 | (spsList.length & 0x1f),
    ]),
  ];
  for (const item of spsList) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(item.length, 0);
    parts.push(len, Buffer.from(item));
  }
  parts.push(Buffer.from([ppsList.length]));
  for (const item of ppsList) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(item.length, 0);
    parts.push(len, Buffer.from(item));
  }
  return flvTag(9, Buffer.concat(parts), 0);
}

function avcNaluTag(
  nals: number[][],
  isKey: boolean,
  lengthSize: 1 | 2 | 3 | 4 = 4,
  timestampMs = 0,
): Buffer {
  const parts: Buffer[] = [
    Buffer.from([((isKey ? 1 : 2) << 4) | 7, 0x01, 0x00, 0x00, 0x00]), // avcPacketType=1
  ];
  for (const nal of nals) {
    const lenBuf = Buffer.alloc(lengthSize);
    for (let i = 0; i < lengthSize; i += 1) {
      lenBuf[lengthSize - 1 - i] = (nal.length >>> (i * 8)) & 0xff;
    }
    parts.push(lenBuf, Buffer.from(nal));
  }
  return flvTag(9, Buffer.concat(parts), timestampMs);
}

describe('FlvH264Parser', () => {
  it('emits config and coded packets immediately per completed FLV tag with zero frame holdback', () => {
    const parser = new FlvH264Parser();
    const header = flvHeader();
    const scriptTag = flvTag(18, Buffer.from([0x02, 0x00, 0x02, 0x6f, 0x6e]));
    const configTag = avcSeqHeader([SPS_1], [PPS_1]);
    const idrTag = avcNaluTag([IDR_1], true, 4, 0);
    const deltaTag = avcNaluTag([DELTA_1], false, 4, 33);

    // First frame arrives alone (no second frame yet): config and IDR emit immediately!
    const firstBatch = parser.push(Buffer.concat([header, scriptTag, configTag, idrTag]));
    expect(firstBatch).toEqual([
      { isConfig: true, isKey: false, data: Buffer.from([...SC4, ...SPS_1, ...SC4, ...PPS_1]) },
      { isConfig: false, isKey: true, data: Buffer.from([...SC4, ...IDR_1]) },
    ]);

    // Second frame arrives: emits immediately too, nothing held for EOF.
    const secondBatch = parser.push(deltaTag);
    expect(secondBatch).toEqual([{ isConfig: false, isKey: false, data: Buffer.from([...SC4, ...DELTA_1]) }]);
    expect(parser.flush()).toEqual([]);
  });

  it('produces identical packets across arbitrary byte-by-byte chunk boundaries and extended headers', () => {
    const parser = new FlvH264Parser();
    const stream = Buffer.concat([
      flvHeader(13), // extended FLV header (DataOffset = 13)
      flvTag(8, Buffer.from([0xaf, 0x00, 0x11, 0x90])), // audio tag ignored
      avcSeqHeader([SPS_1], [PPS_1], 2),
      avcNaluTag([AUD, SEI, IDR_1], true, 2, 0),
      avcNaluTag([DELTA_1], false, 2, 33),
    ]);

    const packets = [];
    for (let i = 0; i < stream.length; i += 1) {
      packets.push(...parser.push(stream.subarray(i, i + 1)));
    }

    expect(packets).toEqual([
      { isConfig: true, isKey: false, data: Buffer.from([...SC4, ...SPS_1, ...SC4, ...PPS_1]) },
      { isConfig: false, isKey: true, data: Buffer.from([...SC4, ...IDR_1]) },
      { isConfig: false, isKey: false, data: Buffer.from([...SC4, ...DELTA_1]) },
    ]);
  });

  it('suppresses identical config headers and re-emits when SPS or PPS changes', () => {
    const parser = new FlvH264Parser();
    const packets = parser.push(
      Buffer.concat([
        flvHeader(),
        avcSeqHeader([SPS_1], [PPS_1]),
        avcNaluTag([IDR_1], true),
        avcSeqHeader([SPS_1], [PPS_1]),
        avcNaluTag([IDR_1], true),
        avcSeqHeader([SPS_2], [PPS_2]),
        avcNaluTag([IDR_1], true),
      ]),
    );

    expect(packets.map((p) => [p.isConfig, p.isKey])).toEqual([
      [true, false],
      [false, true],
      [false, true],
      [true, false],
      [false, true],
    ]);
    expect(packets[3]?.data).toEqual(Buffer.from([...SC4, ...SPS_2, ...SC4, ...PPS_2]));
  });

  it('ignores non-AVC video tags, end-of-sequence tags, and non-VCL-only NALU tags', () => {
    const parser = new FlvH264Parser();
    const nonAvc = flvTag(9, Buffer.from([0x12, 0x00, 0x00, 0x00, 0x00])); // codecId=2
    const eosTag = flvTag(9, Buffer.from([0x17, 0x02, 0x00, 0x00, 0x00]));
    const seiOnly = avcNaluTag([SEI, AUD], false);

    expect(parser.push(Buffer.concat([flvHeader(), nonAvc, eosTag, seiOnly]))).toEqual([]);
  });

  it('rejects malformed headers/records, enforces buffer bounds, and resets cleanly', () => {
    const badHeader = new FlvH264Parser();
    expect(() => badHeader.push(Buffer.from('NOTFLV0000000'))).toThrow(/Invalid FLV header/);

    const truncatedConfig = new FlvH264Parser();
    expect(() =>
      truncatedConfig.push(Buffer.concat([flvHeader(), flvTag(9, Buffer.from([0x17, 0x00, 0, 0, 0, 1, 2]))])),
    ).toThrow(/Truncated AVCDecoderConfigurationRecord/);

    const bounded = new FlvH264Parser();
    expect(() => bounded.push(Buffer.alloc(32 * 1024 * 1024 + 1, 0x46))).toThrow(/exceeded/);

    const resettable = new FlvH264Parser();
    resettable.push(Buffer.concat([flvHeader(), avcSeqHeader([SPS_1], [PPS_1])]));
    resettable.reset();
    expect(resettable.flush()).toEqual([]);
    const afterReset = resettable.push(Buffer.concat([flvHeader(), avcSeqHeader([SPS_1], [PPS_1])]));
    expect(afterReset).toHaveLength(1);
  });
});
