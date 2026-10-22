/** Pure H.264 Annex B helpers for the physical-device mirror: NAL units, the SPS codec string. */

/** NAL unit types used here (ITU-T H.264 table 7-1). */
export const NAL_TYPE = { idr: 5, sps: 7, pps: 8 } as const;

export interface NalUnit {
  type: number;
  /** The unit without its start code, header byte included. */
  data: Uint8Array;
}

/** Splits an Annex B stream at its 3- or 4-byte start codes. Bytes before the first start code are skipped. */
export function nalUnits(stream: Uint8Array): NalUnit[] {
  const starts: { at: number; codeLength: number }[] = [];
  for (let i = 0; i + 2 < stream.length; i++) {
    if (stream[i] !== 0 || stream[i + 1] !== 0) continue;
    if (stream[i + 2] === 1) {
      const isLong = i > 0 && stream[i - 1] === 0;
      starts.push({ at: isLong ? i - 1 : i, codeLength: isLong ? 4 : 3 });
      i += 2;
    }
  }
  return starts.flatMap(({ at, codeLength }, index) => {
    const from = at + codeLength;
    const to = starts[index + 1]?.at ?? stream.length;
    const first = stream[from];
    if (first === undefined || to <= from) return [];
    return [{ type: first & 0x1f, data: stream.subarray(from, to) }];
  });
}

export function hasNalType(stream: Uint8Array, type: number): boolean {
  return nalUnits(stream).some((unit) => unit.type === type);
}

function hex2(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * The WebCodecs codec string (`avc1.PPCCLL`) from the first SPS in a config packet: profile_idc, the
 * constraint flags byte and level_idc follow the NAL header directly (no emulation prevention can occur
 * there, profile_idc is never 0). Null without a complete SPS.
 */
export function codecFromConfig(config: Uint8Array): string | null {
  const sps = nalUnits(config).find((unit) => unit.type === NAL_TYPE.sps);
  if (!sps || sps.data.length < 4) return null;
  const [, profile = 0, constraints = 0, level = 0] = sps.data;
  if (profile === 0) return null;
  return `avc1.${hex2(profile)}${hex2(constraints)}${hex2(level)}`;
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
