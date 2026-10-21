import { MAX_SCREEN_CLIPBOARD_BYTES } from '@lionscope/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_RETRY_MS, ClipboardBridge, truncateUtf8 } from '../src/emulator/clipboardBridge.ts';
import { EmulatorRpcError } from '../src/emulator/emulatorClient.ts';
import { log } from '../src/log.ts';
import { FakeEmulatorClient } from './helpers/fakeEmulatorClient.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function bridge() {
  const client = new FakeEmulatorClient();
  const delivered: string[] = [];
  const steps: string[] = [];
  let authFailures = 0;
  const original = client.setClipboard.bind(client);
  client.setClipboard = async (text) => {
    await original(text);
    steps.push(`set:${text}`);
  };
  const clipboard = new ClipboardBridge({
    client,
    serial: 'emulator-5554',
    deliver: (text) => delivered.push(text),
    pressPaste: () => steps.push('Paste'),
    onAuthFailure: () => (authFailures += 1),
  });
  return { client, clipboard, delivered, steps, authFailures: () => authFailures };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('truncateUtf8', () => {
  it('keeps text that fits and cuts longer text on a character boundary', () => {
    expect(truncateUtf8('héllo', 6)).toBe('héllo');
    expect(truncateUtf8('héllo', 2)).toBe('h');
    expect(truncateUtf8('a👋b', 4)).toBe('a');
    expect(truncateUtf8('a👋b', 5)).toBe('a👋');
    const big = 'é'.repeat(MAX_SCREEN_CLIPBOARD_BYTES);
    expect(Buffer.byteLength(truncateUtf8(big))).toBe(MAX_SCREEN_CLIPBOARD_BYTES);
  });
});

describe('ClipboardBridge', () => {
  it('is off by default: no stream, desktop copies ignored', async () => {
    const { client, clipboard } = bridge();
    clipboard.copy('desktop');
    await tick();
    expect(client.clipboardStreams).toEqual([]);
    expect(client.clipboardSets).toEqual([]);
  });

  it('forwards Android copies while on, skipping the initial state, empties and our own echo', async () => {
    const { client, clipboard, delivered } = bridge();
    clipboard.setSync(true);
    clipboard.setSync(true);
    expect(client.clipboardStreams).toHaveLength(1);
    const stream = client.clipboardStream;
    stream?.handlers.onText('what was there before');
    stream?.handlers.onText('copied in Android 👋');
    clipboard.copy('from the desktop');
    await tick();
    expect(client.clipboardSets).toEqual(['from the desktop']);
    stream?.handlers.onText('from the desktop');
    stream?.handlers.onText('');
    stream?.handlers.onText('x'.repeat(MAX_SCREEN_CLIPBOARD_BYTES + 10));
    expect(delivered).toEqual(['copied in Android 👋', 'x'.repeat(MAX_SCREEN_CLIPBOARD_BYTES)]);
  });

  it('stops forwarding and accepting when turned off', async () => {
    const { client, clipboard, delivered } = bridge();
    clipboard.setSync(true);
    const stream = client.clipboardStream;
    clipboard.setSync(false);
    expect(stream?.cancelled).toBe(true);
    clipboard.copy('ignored');
    await tick();
    expect(client.clipboardSets).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('pastes in order (setClipboard, then Paste), also with sync off', async () => {
    const { clipboard, steps } = bridge();
    clipboard.paste('one');
    clipboard.paste('two');
    await tick();
    expect(steps).toEqual(['set:one', 'Paste', 'set:two', 'Paste']);
  });

  it('does not press Paste when setClipboard fails, and never logs the text', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { client, clipboard, steps, authFailures } = bridge();
    client.clipboardFailure = new Error('UNAVAILABLE');
    clipboard.paste('secret text');
    await tick();
    expect(steps).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret text');
    client.clipboardFailure = new EmulatorRpcError(16, 'setClipboard failed: no token');
    clipboard.paste('again');
    await tick();
    expect(authFailures()).toBe(1);
  });

  it('reopens a failed stream with a growing back-off; a refused token ends the socket instead', async () => {
    vi.useFakeTimers();
    const { client, clipboard, authFailures } = bridge();
    clipboard.setSync(true);
    client.clipboardStream?.handlers.onEnd(new EmulatorRpcError(14, 'streamClipboard failed: UNAVAILABLE'));
    expect(client.clipboardStreams).toHaveLength(1);
    vi.advanceTimersByTime(CLIPBOARD_RETRY_MS);
    expect(client.clipboardStreams).toHaveLength(2);
    client.clipboardStream?.handlers.onEnd(null);
    vi.advanceTimersByTime(CLIPBOARD_RETRY_MS);
    expect(client.clipboardStreams).toHaveLength(2);
    vi.advanceTimersByTime(CLIPBOARD_RETRY_MS);
    expect(client.clipboardStreams).toHaveLength(3);
    client.clipboardStream?.handlers.onEnd(new EmulatorRpcError(16, 'streamClipboard failed: no token'));
    expect(authFailures()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(client.clipboardStreams).toHaveLength(3);
  });

  it('does not reopen after being turned off or closed', () => {
    vi.useFakeTimers();
    const { client, clipboard } = bridge();
    clipboard.setSync(true);
    client.clipboardStream?.handlers.onEnd(new Error('x') as EmulatorRpcError);
    clipboard.setSync(false);
    vi.advanceTimersByTime(60_000);
    expect(client.clipboardStreams).toHaveLength(1);
    clipboard.setSync(true);
    clipboard.close();
    expect(client.clipboardStream?.cancelled).toBe(true);
    clipboard.setSync(true);
    clipboard.paste('late');
    expect(client.clipboardStreams).toHaveLength(2);
  });
});
