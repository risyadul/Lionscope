/**
 * Stateful FLV (Flash Video) H.264/AVC demuxer that extracts `AVCDecoderConfigurationRecord`
 * (SPS/PPS) and length-prefixed AVCC NALU video tags into Annex B packets (`isConfig`, `isKey`)
 * immediately as each length-delimited FLV tag completes — with zero frame holdback.
 */

const START_CODE_4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const MAX_FLV_BUFFER_BYTES = 32 * 1024 * 1024;
const FLV_MIN_HEADER_BYTES = 9;
const FLV_PREV_TAG_SIZE_BYTES = 4;
const FLV_TAG_HEADER_BYTES = 11;
const FLV_VIDEO_AVC_HEADER_BYTES = 5;

const FLV_TAG_TYPE_VIDEO = 9;
const FLV_FRAME_TYPE_KEY = 1;
const FLV_CODEC_AVC = 7;

const AVC_PACKET_SEQUENCE_HEADER = 0;
const AVC_PACKET_NALU = 1;

const H264_NAL_TYPE = {
  sliceNonIdr: 1,
  sliceIdr: 5,
  sei: 6,
  sps: 7,
  pps: 8,
  aud: 9,
  endOfSeq: 10,
  endOfStream: 11,
  filler: 12,
} as const;

export interface FlvH264Packet {
  isConfig: boolean;
  isKey: boolean;
  data: Buffer;
}

function isVclNalType(nalType: number): boolean {
  return nalType >= H264_NAL_TYPE.sliceNonIdr && nalType <= H264_NAL_TYPE.sliceIdr;
}

function isDroppedNonVclNalType(nalType: number): boolean {
  return (
    nalType === H264_NAL_TYPE.sei ||
    nalType === H264_NAL_TYPE.aud ||
    nalType === H264_NAL_TYPE.endOfSeq ||
    nalType === H264_NAL_TYPE.endOfStream ||
    nalType === H264_NAL_TYPE.filler
  );
}

function readBigEndianUint(buf: Buffer, offset: number, byteCount: number): number {
  let value = 0;
  for (let i = 0; i < byteCount; i += 1) {
    value = value * 256 + buf[offset + i]!;
  }
  return value;
}

/**
 * Parses an FLV byte stream (`ffmpeg -f flv`) across arbitrary chunk boundaries into Annex B
 * config (`SPS`/`PPS`) and coded frame (`IDR`/delta) packets.
 */
export class FlvH264Parser {
  private buffer = Buffer.alloc(0);
  private headerParsed = false;
  private nalLengthSize = 4;
  private lastConfigData: Buffer | null = null;

  /** Push an FLV stream chunk and return every complete H.264 packet immediately. */
  push(chunk: Buffer): FlvH264Packet[] {
    if (chunk.length === 0) return [];
    if (this.buffer.length + chunk.length > MAX_FLV_BUFFER_BYTES) {
      throw new Error(`FLV H.264 buffer exceeded ${MAX_FLV_BUFFER_BYTES} bytes`);
    }
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);

    const packets: FlvH264Packet[] = [];
    let offset = 0;

    if (!this.headerParsed) {
      if (this.buffer.length < FLV_MIN_HEADER_BYTES) return packets;
      if (this.buffer[0] !== 0x46 || this.buffer[1] !== 0x4c || this.buffer[2] !== 0x56) {
        throw new Error('Invalid FLV header signature');
      }
      const dataOffset = this.buffer.readUInt32BE(5);
      if (dataOffset < FLV_MIN_HEADER_BYTES) {
        throw new Error(`Invalid FLV header data offset: ${dataOffset}`);
      }
      if (this.buffer.length < dataOffset + FLV_PREV_TAG_SIZE_BYTES) return packets;
      offset = dataOffset + FLV_PREV_TAG_SIZE_BYTES;
      this.headerParsed = true;
    }

    while (this.buffer.length - offset >= FLV_TAG_HEADER_BYTES) {
      const tagType = this.buffer[offset]! & 0x1f;
      const dataSize =
        (this.buffer[offset + 1]! << 16) | (this.buffer[offset + 2]! << 8) | this.buffer[offset + 3]!;
      const totalTagBytes = FLV_TAG_HEADER_BYTES + dataSize + FLV_PREV_TAG_SIZE_BYTES;
      if (this.buffer.length - offset < totalTagBytes) break;

      const body = this.buffer.subarray(
        offset + FLV_TAG_HEADER_BYTES,
        offset + FLV_TAG_HEADER_BYTES + dataSize,
      );
      offset += totalTagBytes;

      if (tagType !== FLV_TAG_TYPE_VIDEO || body.length < FLV_VIDEO_AVC_HEADER_BYTES) continue;

      const frameHeader = body[0]!;
      if ((frameHeader & 0x80) !== 0 || (frameHeader & 0x0f) !== FLV_CODEC_AVC) continue;

      const frameType = (frameHeader >> 4) & 0x0f;
      const avcPacketType = body[1]!;
      const payload = body.subarray(FLV_VIDEO_AVC_HEADER_BYTES);

      if (avcPacketType === AVC_PACKET_SEQUENCE_HEADER) {
        this.handleSequenceHeader(payload, packets);
      } else if (avcPacketType === AVC_PACKET_NALU) {
        this.handleNaluPacket(payload, frameType === FLV_FRAME_TYPE_KEY, packets);
      }
    }

    if (offset > 0) {
      this.buffer =
        offset === this.buffer.length ? Buffer.alloc(0) : Buffer.from(this.buffer.subarray(offset));
    }
    return packets;
  }

  /** FLV tags are length-delimited and emitted immediately on `push()`, so EOF has no held frame. */
  flush(): FlvH264Packet[] {
    this.buffer = Buffer.alloc(0);
    return [];
  }

  /** Reset parser state for a new stream. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.headerParsed = false;
    this.nalLengthSize = 4;
    this.lastConfigData = null;
  }

  private handleSequenceHeader(payload: Buffer, packets: FlvH264Packet[]): void {
    // AVCDecoderConfigurationRecord: version(1) profile(1) compat(1) level(1) lengthSizeMinusOne(1) numSps(1)
    if (payload.length < 7) {
      throw new Error('Truncated AVCDecoderConfigurationRecord');
    }
    this.nalLengthSize = (payload[4]! & 0x03) + 1;
    const numSps = payload[5]! & 0x1f;
    let pos = 6;
    const configParts: Buffer[] = [];

    for (let i = 0; i < numSps; i += 1) {
      if (pos + 2 > payload.length) {
        throw new Error('Truncated SPS length in AVCDecoderConfigurationRecord');
      }
      const spsLen = payload.readUInt16BE(pos);
      pos += 2;
      if (pos + spsLen > payload.length) {
        throw new Error('Truncated SPS payload in AVCDecoderConfigurationRecord');
      }
      if (spsLen > 0) {
        configParts.push(START_CODE_4, payload.subarray(pos, pos + spsLen));
      }
      pos += spsLen;
    }

    if (pos >= payload.length) {
      throw new Error('Missing PPS count in AVCDecoderConfigurationRecord');
    }
    const numPps = payload[pos]!;
    pos += 1;

    for (let i = 0; i < numPps; i += 1) {
      if (pos + 2 > payload.length) {
        throw new Error('Truncated PPS length in AVCDecoderConfigurationRecord');
      }
      const ppsLen = payload.readUInt16BE(pos);
      pos += 2;
      if (pos + ppsLen > payload.length) {
        throw new Error('Truncated PPS payload in AVCDecoderConfigurationRecord');
      }
      if (ppsLen > 0) {
        configParts.push(START_CODE_4, payload.subarray(pos, pos + ppsLen));
      }
      pos += ppsLen;
    }

    if (configParts.length === 0) return;
    const configData = Buffer.concat(configParts);
    if (this.lastConfigData && Buffer.compare(this.lastConfigData, configData) === 0) {
      return;
    }
    this.lastConfigData = Buffer.from(configData);
    packets.push({ isConfig: true, isKey: false, data: configData });
  }

  private handleNaluPacket(payload: Buffer, isKeyTag: boolean, packets: FlvH264Packet[]): void {
    const parts: Buffer[] = [];
    let pos = 0;
    let hasVcl = false;
    let hasIdr = false;

    while (pos < payload.length) {
      if (pos + this.nalLengthSize > payload.length) {
        throw new Error('Truncated AVCC NAL length prefix');
      }
      const nalLen = readBigEndianUint(payload, pos, this.nalLengthSize);
      pos += this.nalLengthSize;
      if (pos + nalLen > payload.length) {
        throw new Error('Truncated AVCC NAL unit payload');
      }
      const nal = payload.subarray(pos, pos + nalLen);
      pos += nalLen;
      if (nal.length === 0) continue;

      const nalType = nal[0]! & 0x1f;
      if (isDroppedNonVclNalType(nalType)) continue;
      if (isVclNalType(nalType)) hasVcl = true;
      if (nalType === H264_NAL_TYPE.sliceIdr) hasIdr = true;
      parts.push(START_CODE_4, nal);
    }

    if (!hasVcl || parts.length === 0) return;
    packets.push({
      isConfig: false,
      isKey: isKeyTag || hasIdr,
      data: parts.length === 2 ? Buffer.concat(parts) : Buffer.concat(parts),
    });
  }
}
