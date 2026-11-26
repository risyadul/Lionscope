/**
 * Stateful H.264 Annex B byte-stream parser that splits streamed encoder output into config packets
 * (SPS + PPS) and access-unit coded frame packets compatible with WebCodecs (`VideoDecoder`) and
 * `SCREEN_VIDEO_FLAG`.
 */

const START_CODE_4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const MAX_ANNEX_B_BUFFER_BYTES = 32 * 1024 * 1024;

export const H264_NAL_TYPE = {
  sliceNonIdr: 1,
  slicePartA: 2,
  slicePartB: 3,
  slicePartC: 4,
  sliceIdr: 5,
  sei: 6,
  sps: 7,
  pps: 8,
  aud: 9,
  endOfSeq: 10,
  endOfStream: 11,
  filler: 12,
} as const;

export interface AnnexBPacket {
  isConfig: boolean;
  isKey: boolean;
  data: Buffer;
}

function isVclNalType(nalType: number): boolean {
  return nalType >= H264_NAL_TYPE.sliceNonIdr && nalType <= H264_NAL_TYPE.sliceIdr;
}

/**
 * In H.264 slice_header(), `first_mb_in_slice` is the first syntax element (`ue(v)`).
 * Value 0 encodes as a single `1` bit (`(nal[1] & 0x80) !== 0`), marking the first slice of a picture.
 * Single-byte synthetic NAL units are treated as starting a new access unit.
 */
function isFirstSliceOfPicture(nal: Buffer): boolean {
  const headerByte = nal[1];
  return headerByte === undefined || (headerByte & 0x80) !== 0;
}

/**
 * Parses an H.264 Annex B byte stream across arbitrary chunk boundaries into config and coded frame packets.
 *
 * - Emits `{ isConfig: true, isKey: false, data }` containing `[SPS, PPS]` with 4-byte Annex B start codes
 *   whenever SPS/PPS first appear or either changes.
 * - Groups VCL slice NAL units into one access unit per picture (`isKey: true` when IDR type 5, `false` for
 *   non-IDR slices).
 * - Drops AUD, SEI, filler, and end-of-sequence/stream NAL units while treating them as access-unit boundaries.
 */
export class H264AnnexBParser {
  private buffer = Buffer.alloc(0);
  private nalStart = -1;
  private scanPos = 0;

  private latestSps: Buffer | null = null;
  private latestPps: Buffer | null = null;
  private emittedSps: Buffer | null = null;
  private emittedPps: Buffer | null = null;
  private configDirty = false;

  private currentSlices: Buffer[] = [];
  private currentIsKey = false;
  private boundarySeenSinceSlice = false;

  /** Push a chunk of Annex B bytes and return any completed packets. */
  push(chunk: Buffer): AnnexBPacket[] {
    if (chunk.length === 0) return [];
    if (this.buffer.length + chunk.length > MAX_ANNEX_B_BUFFER_BYTES) {
      throw new Error(`H.264 Annex B buffer exceeded ${MAX_ANNEX_B_BUFFER_BYTES} bytes`);
    }
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const packets: AnnexBPacket[] = [];
    this.consumeStartCodes(packets);
    this.compactBuffer();
    return packets;
  }

  /** Flush any remaining buffered NAL unit and open access unit at end-of-stream. */
  flush(): AnnexBPacket[] {
    const packets: AnnexBPacket[] = [];
    if (this.nalStart !== -1 && this.nalStart < this.buffer.length) {
      const finalNal = this.buffer.subarray(this.nalStart);
      this.handleNalUnit(finalNal, packets);
    }
    this.flushPendingConfig(packets);
    this.flushCurrentAccessUnit(packets);
    this.buffer = Buffer.alloc(0);
    this.nalStart = -1;
    this.scanPos = 0;
    return packets;
  }

  /** Reset parser state for a new stream. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.nalStart = -1;
    this.scanPos = 0;
    this.latestSps = null;
    this.latestPps = null;
    this.emittedSps = null;
    this.emittedPps = null;
    this.configDirty = false;
    this.currentSlices = [];
    this.currentIsKey = false;
    this.boundarySeenSinceSlice = false;
  }

  private consumeStartCodes(packets: AnnexBPacket[]): void {
    const len = this.buffer.length;
    let i = this.scanPos;

    while (i + 2 < len) {
      if (this.buffer[i] !== 0 || this.buffer[i + 1] !== 0 || this.buffer[i + 2] !== 1) {
        i += 1;
        continue;
      }

      if (this.nalStart === -1) {
        this.nalStart = i + 3;
        i = this.nalStart;
        continue;
      }

      const isLong = i > this.nalStart && this.buffer[i - 1] === 0;
      const nalEnd = isLong ? i - 1 : i;
      if (nalEnd > this.nalStart) {
        this.handleNalUnit(this.buffer.subarray(this.nalStart, nalEnd), packets);
      }

      this.nalStart = i + 3;
      i = this.nalStart;

      // Once the next NAL header byte is present, emit pending SPS+PPS before waiting for the slice to finish.
      if (this.nalStart < len) {
        const nextType = (this.buffer[this.nalStart] ?? 0) & 0x1f;
        if (nextType !== H264_NAL_TYPE.sps && nextType !== H264_NAL_TYPE.pps) {
          this.flushPendingConfig(packets);
        }
      }
    }

    const minKeep = this.nalStart === -1 ? 0 : this.nalStart;
    this.scanPos = Math.max(minKeep, len - 3);

    if (this.nalStart !== -1 && this.nalStart < len) {
      const nextType = (this.buffer[this.nalStart] ?? 0) & 0x1f;
      if (nextType !== H264_NAL_TYPE.sps && nextType !== H264_NAL_TYPE.pps) {
        this.flushPendingConfig(packets);
      }
    }
  }

  private compactBuffer(): void {
    if (this.nalStart === -1) {
      // Keep at most the last 2 bytes before the first start code in case they begin `00 00 01`.
      if (this.buffer.length > 2) {
        this.buffer = Buffer.from(this.buffer.subarray(this.buffer.length - 2));
        this.scanPos = 0;
      }
      return;
    }

    if (this.nalStart > 0) {
      this.buffer = Buffer.from(this.buffer.subarray(this.nalStart));
      this.scanPos = Math.max(0, this.scanPos - this.nalStart);
      this.nalStart = 0;
    }
  }

  private handleNalUnit(nal: Buffer, packets: AnnexBPacket[]): void {
    const header = nal[0];
    if (header === undefined) return;
    const nalType = header & 0x1f;

    if (nalType === H264_NAL_TYPE.sps) {
      this.flushCurrentAccessUnit(packets);
      this.boundarySeenSinceSlice = true;
      if (!this.latestSps || Buffer.compare(this.latestSps, nal) !== 0) {
        this.latestSps = Buffer.from(nal);
        this.configDirty = true;
      }
      return;
    }

    if (nalType === H264_NAL_TYPE.pps) {
      this.flushCurrentAccessUnit(packets);
      this.boundarySeenSinceSlice = true;
      if (!this.latestPps || Buffer.compare(this.latestPps, nal) !== 0) {
        this.latestPps = Buffer.from(nal);
        this.configDirty = true;
      }
      return;
    }

    // Non-parameter-set NALs terminate any pending SPS/PPS batch.
    this.flushPendingConfig(packets);

    if (!isVclNalType(nalType)) {
      // AUD, SEI, filler, end-of-sequence/stream separate access units and are not needed by WebCodecs.
      this.flushCurrentAccessUnit(packets);
      this.boundarySeenSinceSlice = true;
      return;
    }

    const sliceIsKey = nalType === H264_NAL_TYPE.sliceIdr;
    if (this.currentSlices.length > 0) {
      const startsNewAu =
        this.boundarySeenSinceSlice || sliceIsKey !== this.currentIsKey || isFirstSliceOfPicture(nal);
      if (startsNewAu) {
        this.flushCurrentAccessUnit(packets);
      }
    }

    if (this.currentSlices.length === 0) {
      this.currentIsKey = sliceIsKey;
    }
    this.boundarySeenSinceSlice = false;
    this.currentSlices.push(Buffer.concat([START_CODE_4, nal]));
  }

  private flushPendingConfig(packets: AnnexBPacket[]): void {
    if (!this.configDirty || !this.latestSps || !this.latestPps) return;
    const unchanged =
      this.emittedSps !== null &&
      this.emittedPps !== null &&
      Buffer.compare(this.emittedSps, this.latestSps) === 0 &&
      Buffer.compare(this.emittedPps, this.latestPps) === 0;
    this.configDirty = false;
    if (unchanged) return;

    this.emittedSps = Buffer.from(this.latestSps);
    this.emittedPps = Buffer.from(this.latestPps);
    packets.push({
      isConfig: true,
      isKey: false,
      data: Buffer.concat([START_CODE_4, this.latestSps, START_CODE_4, this.latestPps]),
    });
  }

  private flushCurrentAccessUnit(packets: AnnexBPacket[]): void {
    if (this.currentSlices.length === 0) return;
    const data = this.currentSlices.length === 1 ? this.currentSlices[0]! : Buffer.concat(this.currentSlices);
    packets.push({
      isConfig: false,
      isKey: this.currentIsKey,
      data,
    });
    this.currentSlices = [];
    this.currentIsKey = false;
    this.boundarySeenSinceSlice = false;
  }
}
