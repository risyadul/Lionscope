import { describe, expect, it } from 'vitest';
import { codecFromConfig, concatBytes, hasNalType, NAL_TYPE, nalUnits } from '../src/lib/h264.ts';
import { CONFIG_PAYLOAD, IDR_PAYLOAD } from './screenFakes.ts';

const bytes = (...values: number[]) => new Uint8Array(values);
/** A config packet: SPS with the given profile / constraints / level, then a PPS. */
const config = (profile: number, constraints: number, level: number) =>
  bytes(0, 0, 0, 1, 0x67, profile, constraints, level, 0xac, 0, 0, 1, 0x68, 0xce, 0x38, 0x80);

describe('nalUnits', () => {
  it('splits at 3- and 4-byte start codes and reads each unit type', () => {
    const units = nalUnits(bytes(0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4));
    expect(units.map((u) => u.type)).toEqual([NAL_TYPE.sps, NAL_TYPE.pps, NAL_TYPE.idr]);
    expect([...(units[0]?.data ?? [])]).toEqual([0x67, 1, 2]);
    expect([...(units[2]?.data ?? [])]).toEqual([0x65, 4]);
  });

  it('skips leading garbage and returns nothing without a start code', () => {
    expect(nalUnits(bytes(9, 9, 0, 0, 1, 0x41, 7)).map((u) => u.type)).toEqual([1]);
    expect(nalUnits(bytes(1, 2, 3))).toEqual([]);
    expect(nalUnits(bytes(0, 0, 1))).toEqual([]);
  });

  it('tells whether a stream carries an SPS', () => {
    expect(hasNalType(new Uint8Array(CONFIG_PAYLOAD), NAL_TYPE.sps)).toBe(true);
    expect(hasNalType(new Uint8Array(IDR_PAYLOAD), NAL_TYPE.sps)).toBe(false);
  });
});

describe('codecFromConfig', () => {
  it('builds avc1.PPCCLL for baseline, main and high profiles', () => {
    expect(codecFromConfig(config(0x42, 0xc0, 0x1e))).toBe('avc1.42C01E');
    expect(codecFromConfig(config(0x4d, 0x40, 0x1f))).toBe('avc1.4D401F');
    expect(codecFromConfig(config(0x64, 0x00, 0x28))).toBe('avc1.640028');
    expect(codecFromConfig(new Uint8Array(CONFIG_PAYLOAD))).toBe('avc1.640028');
  });

  it('finds the SPS after other units and rejects a stream without a complete one', () => {
    const ppsFirst = bytes(0, 0, 1, 0x68, 0xce, 0, 0, 1, 0x67, 0x64, 0x00, 0x33, 0xac);
    expect(codecFromConfig(ppsFirst)).toBe('avc1.640033');
    expect(codecFromConfig(new Uint8Array(IDR_PAYLOAD))).toBeNull();
    expect(codecFromConfig(bytes(0, 0, 1, 0x67, 0x64))).toBeNull();
    expect(codecFromConfig(bytes(0, 0, 1, 0x67, 0x00, 0x00, 0x28))).toBeNull();
  });
});

describe('concatBytes', () => {
  it('joins two arrays into a new one', () => {
    expect([...concatBytes(bytes(1, 2), bytes(3))]).toEqual([1, 2, 3]);
  });
});
