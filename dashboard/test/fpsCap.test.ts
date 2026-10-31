import { describe, expect, it } from 'vitest';
import { isPresetFpsCap, parseStoredFpsCap, resolveFpsCapInput } from '../src/lib/fpsCap.ts';

describe('parseStoredFpsCap', () => {
  it('keeps presets and custom whole numbers from 5 to 60', () => {
    for (const fps of [5, 15, 30, 45, 60]) expect(parseStoredFpsCap(String(fps))).toBe(fps);
  });

  it('falls back to 30 for anything else rather than guessing', () => {
    for (const raw of [
      null,
      '',
      'abc',
      '4',
      '61',
      '120',
      '0',
      '-5',
      '45.5',
      '45.0',
      '045',
      ' 45',
      '1e1',
      'NaN',
    ])
      expect(parseStoredFpsCap(raw)).toBe(30);
  });
});

describe('resolveFpsCapInput', () => {
  it('applies a whole number in range as typed', () => {
    expect(resolveFpsCapInput('45')).toEqual({ fps: 45, note: null });
    expect(resolveFpsCapInput(' 5 ')).toEqual({ fps: 5, note: null });
    expect(resolveFpsCapInput('60')).toEqual({ fps: 60, note: null });
  });

  it('clamps into 5–60 and rounds to a whole number, saying so', () => {
    expect(resolveFpsCapInput('61')).toEqual({ fps: 60, note: 'Set to 60 fps: the cap is 5–60 fps' });
    expect(resolveFpsCapInput('1000')).toEqual({ fps: 60, note: 'Set to 60 fps: the cap is 5–60 fps' });
    expect(resolveFpsCapInput('4')).toEqual({ fps: 5, note: 'Set to 5 fps: the cap is 5–60 fps' });
    expect(resolveFpsCapInput('0')).toEqual({ fps: 5, note: 'Set to 5 fps: the cap is 5–60 fps' });
    expect(resolveFpsCapInput('-30')).toEqual({ fps: 5, note: 'Set to 5 fps: the cap is 5–60 fps' });
    expect(resolveFpsCapInput('44.5')).toEqual({ fps: 45, note: 'Rounded to 45 fps' });
    expect(resolveFpsCapInput('.4')).toEqual({ fps: 5, note: 'Set to 5 fps: the cap is 5–60 fps' });
    expect(resolveFpsCapInput('60.4')).toEqual({ fps: 60, note: 'Rounded to 60 fps' });
    expect(resolveFpsCapInput('45.')).toEqual({ fps: 45, note: null });
  });

  it('refuses text that is not a plain number', () => {
    for (const text of ['', ' ', 'abc', '45fps', '1e1', '0x10', 'Infinity', '4 5', '--5', '+'])
      expect(resolveFpsCapInput(text)).toEqual({ fps: null, note: 'Enter a whole number from 5–60 fps' });
  });
});

describe('isPresetFpsCap', () => {
  it('tells presets from custom caps', () => {
    expect([15, 30, 60].every(isPresetFpsCap)).toBe(true);
    expect([5, 20, 45].some(isPresetFpsCap)).toBe(false);
  });
});
