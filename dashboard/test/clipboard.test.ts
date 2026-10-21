import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCREEN_CLIPBOARD_BYTES } from '@lionscope/protocol/wire';
import {
  clipboardReadAccess,
  limitClipboardText,
  readDesktopClipboard,
  resetClipboardReadAccess,
  writeDesktopClipboard,
  type ClipboardEnv,
} from '../src/lib/clipboard.ts';

function env(overrides: Partial<ClipboardEnv> = {}) {
  const readText = vi.fn(async () => 'from desktop');
  const writeText = vi.fn(async (_text: string) => {});
  const query = vi.fn(async () => ({ state: 'granted' }) as PermissionStatus);
  return {
    readText,
    writeText,
    query,
    env: { clipboard: { readText, writeText }, permissions: { query }, hasFocus: () => true, ...overrides },
  };
}

beforeEach(() => resetClipboardReadAccess());

describe('readDesktopClipboard', () => {
  it('reads once the clipboard-read permission is known', async () => {
    const { env: e, query } = env();
    expect(await readDesktopClipboard(e)).toBe('from desktop');
    expect(await readDesktopClipboard(e)).toBe('from desktop');
    expect(query).toHaveBeenCalledOnce();
    expect(clipboardReadAccess()).toBe('allowed');
  });

  it('never reads where the permission is unknown (Firefox, Safari) or the API is missing', async () => {
    const { env: e, readText } = env({
      permissions: { query: vi.fn(async () => Promise.reject(new TypeError('bad name'))) },
    });
    expect(await readDesktopClipboard(e)).toBeNull();
    expect(await readDesktopClipboard(e)).toBeNull();
    expect(readText).not.toHaveBeenCalled();
    expect(clipboardReadAccess()).toBe('unsupported');

    resetClipboardReadAccess();
    expect(await readDesktopClipboard({ ...e, clipboard: undefined })).toBeNull();
    expect(clipboardReadAccess()).toBe('unsupported');
  });

  it('remembers a denial for the page session: no more reads, no more prompts', async () => {
    const { env: e, readText } = env();
    readText.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    expect(await readDesktopClipboard(e)).toBeNull();
    expect(await readDesktopClipboard(e)).toBeNull();
    expect(readText).toHaveBeenCalledOnce();
    expect(clipboardReadAccess()).toBe('denied');
  });

  it('a permission already denied is never asked', async () => {
    const { env: e, readText } = env({
      permissions: { query: vi.fn(async () => ({ state: 'denied' }) as PermissionStatus) },
    });
    expect(await readDesktopClipboard(e)).toBeNull();
    expect(readText).not.toHaveBeenCalled();
  });

  it('a refusal while the page is not focused is not a denial', async () => {
    const { env: e, readText } = env({ hasFocus: () => false });
    readText.mockRejectedValueOnce(new DOMException('Document is not focused', 'NotAllowedError'));
    expect(await readDesktopClipboard(e)).toBeNull();
    expect(clipboardReadAccess()).toBe('allowed');
    expect(await readDesktopClipboard(e)).toBe('from desktop');
  });
});

describe('writeDesktopClipboard', () => {
  it('reports whether the browser took the text', async () => {
    const { env: e, writeText } = env();
    expect(await writeDesktopClipboard('hi', e)).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hi');
    writeText.mockRejectedValueOnce(new DOMException('no gesture', 'NotAllowedError'));
    expect(await writeDesktopClipboard('hi', e)).toBe(false);
    expect(await writeDesktopClipboard('hi', { ...e, clipboard: undefined })).toBe(false);
  });
});

describe('limitClipboardText', () => {
  it('keeps text within 32 KB as encoded in the JSON message, on code point boundaries', () => {
    expect(limitClipboardText('hello')).toEqual({ text: 'hello', isTruncated: false });
    const long = limitClipboardText('x'.repeat(MAX_SCREEN_CLIPBOARD_BYTES + 1));
    expect(long).toEqual({ text: 'x'.repeat(MAX_SCREEN_CLIPBOARD_BYTES), isTruncated: true });
    expect(limitClipboardText('ééé', 5)).toEqual({ text: 'éé', isTruncated: true });
    expect(limitClipboardText('a😀', 4)).toEqual({ text: 'a', isTruncated: true });
    expect(limitClipboardText('😀', 4)).toEqual({ text: '😀', isTruncated: false });
  });

  it('counts JSON escapes, so the socket frame can never outgrow the limit', () => {
    // A newline is two bytes in JSON, a control character six, a quote two.
    expect(limitClipboardText('\n\n\n', 4).text).toBe('\n\n');
    expect(limitClipboardText('\u0001\u0001', 6).text).toBe('\u0001');
    expect(limitClipboardText('"a', 2).text).toBe('"');
    const nasty = '\u0001'.repeat(20_000);
    const { text } = limitClipboardText(nasty);
    expect(new TextEncoder().encode(JSON.stringify(text)).length).toBeLessThanOrEqual(
      MAX_SCREEN_CLIPBOARD_BYTES + 2,
    );
  });
});
