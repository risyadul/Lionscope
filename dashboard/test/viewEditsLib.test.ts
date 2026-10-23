import { describe, expect, it } from 'vitest';
import {
  covers,
  cssColor,
  currentValue,
  editErrorMessage,
  formatNumber,
  isCurrentValue,
  liveEditsLabel,
  parseDraft,
  propertyWords,
} from '../src/lib/viewEdits.ts';
import { editableSnapshot } from './inspectorFixtures.ts';

const button = editableSnapshot().nodes[2]!;

describe('currentValue', () => {
  it('reads each property from the node and its view state', () => {
    expect(currentValue(button, 'paddingLeft')).toBe(8);
    expect(currentValue(button, 'paddingTop')).toBe(4);
    expect(currentValue(button, 'marginRight')).toBe(16);
    expect(currentValue(button, 'layoutWidth')).toBe('match_parent');
    expect(currentValue(button, 'backgroundColor')).toBe('#FF6200EE');
    expect(currentValue(button, 'textSize')).toBe(14);
    expect(currentValue(button, 'text')).toBe('Checkout');
    expect(currentValue(button, 'enabled')).toBe(true);
    expect(currentValue({ ...button, view: undefined }, 'elevation')).toBeNull();
  });

  it('compares normalized: a color in another case or a size as a number is the same value', () => {
    expect(isCurrentValue(button, 'backgroundColor', '#6200ee')).toBe(true);
    expect(isCurrentValue(button, 'backgroundColor', '#806200EE')).toBe(false);
    expect(isCurrentValue({ ...button, layoutWidth: '400px' }, 'layoutWidth', 400)).toBe(true);
    expect(isCurrentValue(button, 'paddingLeft', 9)).toBe(false);
  });
});

describe('parseDraft', () => {
  it('takes whole px within bounds for padding and margins', () => {
    expect(parseDraft('paddingLeft', ' 12 ')).toEqual({ ok: true, value: 12 });
    expect(parseDraft('paddingLeft', '-1').ok).toBe(false);
    expect(parseDraft('paddingLeft', '2001').ok).toBe(false);
    expect(parseDraft('paddingLeft', '1.5').ok).toBe(false);
    expect(parseDraft('paddingLeft', '')).toEqual({ ok: false, error: 'Whole px from 0 to 2000.' });
    expect(parseDraft('marginTop', '-2000')).toEqual({ ok: true, value: -2000 });
  });

  it('takes alpha, translation, elevation and text size as numbers within bounds', () => {
    expect(parseDraft('alpha', '0.25')).toEqual({ ok: true, value: 0.25 });
    expect(parseDraft('alpha', '1.1').ok).toBe(false);
    expect(parseDraft('translationX', '-12.5')).toEqual({ ok: true, value: -12.5 });
    expect(parseDraft('elevation', '-1').ok).toBe(false);
    expect(parseDraft('textSize', '0.5').ok).toBe(false);
    expect(parseDraft('textSize', 'abc').ok).toBe(false);
  });

  it('normalizes colors, with or without #', () => {
    expect(parseDraft('textColor', '#12abEF')).toEqual({ ok: true, value: '#FF12ABEF' });
    expect(parseDraft('backgroundColor', '8012abef')).toEqual({ ok: true, value: '#8012ABEF' });
    expect(parseDraft('backgroundColor', '#123').ok).toBe(false);
  });

  it('takes text with line breaks, not control characters or more than 500 units', () => {
    expect(parseDraft('text', 'Pay\nnow')).toEqual({ ok: true, value: 'Pay\nnow' });
    expect(parseDraft('text', 'a\u0007').ok).toBe(false);
    expect(parseDraft('text', 'x'.repeat(501)).ok).toBe(false);
  });
});

describe('labels', () => {
  it('draws #AARRGGBB as CSS #RRGGBBAA', () => {
    expect(cssColor('#806200EE')).toBe('#6200EE80');
    expect(cssColor('#6200ee')).toBe('#6200EEFF');
    expect(cssColor('nope')).toBeNull();
  });

  it('formats numbers without float noise', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(null)).toBe('');
  });

  it('words errors from the code when the server sent no message', () => {
    expect(editErrorMessage('limit', undefined)).toBe('256 live edits are in effect: revert some first.');
    expect(editErrorMessage('stale', 'The view is gone.')).toBe('The view is gone.');
    expect(editErrorMessage(undefined, undefined)).toBe('The app could not apply it.');
  });

  it('counts live edits and names groups', () => {
    expect(liveEditsLabel(1)).toBe('1 live edit (temporary)');
    expect(liveEditsLabel(3)).toBe('3 live edits (temporary)');
    expect(propertyWords('padding')).toBe('padding');
    expect(propertyWords('layoutWidth')).toBe('width');
    expect(covers('padding', 'paddingTop')).toBe(true);
    expect(covers('padding', 'marginTop')).toBe(false);
    expect(covers(null, 'alpha')).toBe(true);
  });
});
