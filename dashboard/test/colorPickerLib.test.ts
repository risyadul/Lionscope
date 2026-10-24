import { describe, expect, it } from 'vitest';
import {
  argbCss,
  argbToHsva,
  hsvaToArgb,
  parseRecent,
  pixelArgb,
  screenColors,
  SWATCH_LIMIT,
  withRecent,
} from '../src/lib/colorPicker.ts';
import { editableSnapshot } from './inspectorFixtures.ts';

describe('color math', () => {
  it('turns #AARRGGBB into HSVA and back without drift', () => {
    for (const argb of [
      '#FF6200EE',
      '#DE000000',
      '#80FFFFFF',
      '#FF12ABEF',
      '#00000000',
      '#FFFF0000',
      '#FF00FF00',
    ]) {
      expect(hsvaToArgb(argbToHsva(argb)!)).toBe(argb);
    }
  });

  it('reads #RRGGBB as opaque and refuses what is not a color', () => {
    expect(argbToHsva('#ff0000')).toEqual({ h: 0, s: 1, v: 1, a: 1 });
    expect(argbToHsva('red')).toBeNull();
    expect(argbToHsva('#12345')).toBeNull();
  });

  it('places primaries on the hue wheel', () => {
    expect(argbToHsva('#FF00FF00')?.h).toBe(120);
    expect(argbToHsva('#FF0000FF')?.h).toBe(240);
    expect(hsvaToArgb({ h: 60, s: 1, v: 1, a: 0.5 })).toBe('#80FFFF00');
  });

  it('writes CSS colors and screenshot pixels', () => {
    expect(argbCss('#806200EE')).toBe('#6200EE80');
    expect(pixelArgb(18, 52, 86)).toBe('#FF123456');
  });
});

describe('swatches', () => {
  it('lists the snapshot’s colors, most used first, without repeats', () => {
    expect(screenColors(editableSnapshot().nodes)).toEqual(['#FF202124', '#FF6200EE', '#DE000000']);
  });

  it('keeps at most SWATCH_LIMIT colors', () => {
    const nodes = Array.from({ length: SWATCH_LIMIT + 5 }, (_, i) => ({
      ...editableSnapshot().nodes[0]!,
      view: {
        ...editableSnapshot().nodes[0]!.view!,
        backgroundColor: `#FF0000${String(i).padStart(2, '0')}`,
      },
    }));
    expect(screenColors(nodes)).toHaveLength(SWATCH_LIMIT);
  });

  it('moves a recent color to the front and remembers only valid ones', () => {
    expect(withRecent(['#FF000000', '#FFFFFFFF'], '#FFFFFFFF')).toEqual(['#FFFFFFFF', '#FF000000']);
    expect(parseRecent('["#ff0000", 4, "nope", "#80123456"]')).toEqual(['#FFFF0000', '#80123456']);
    expect(parseRecent('{')).toEqual([]);
    expect(parseRecent(null)).toEqual([]);
  });
});
