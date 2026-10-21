import { MAX_SCREEN_CLIPBOARD_BYTES } from '@lionscope/protocol';
import { errorMessage, log } from '../log.ts';
import type { ScreenClientMessage } from '@lionscope/protocol';
import { isAuthError } from './emulatorClient.ts';
import type { EmulatorClient } from './emulatorClient.ts';

/** A failed clipboard stream is reopened after this, doubling up to the maximum. */
export const CLIPBOARD_RETRY_MS = 1000;
export const CLIPBOARD_MAX_RETRY_MS = 30_000;

/** `text` cut to at most `maxBytes` of UTF-8, on a character boundary. */
export function truncateUtf8(text: string, maxBytes: number = MAX_SCREEN_CLIPBOARD_BYTES): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off a character cut in two (continuation bytes are 10xxxxxx).
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

export interface ClipboardBridgeOptions {
  client: EmulatorClient;
  serial: string;
  /** Text copied inside Android (sync on): sent to the dashboard. */
  deliver(text: string): void;
  /** Press Android's Paste key in the focused field. */
  pressPaste(): void;
  onAuthFailure(): void;
}

/**
 * Clipboard sharing for one screen socket. Off by default; while on, Android's copies go to the dashboard and the
 * dashboard's copies to Android. `paste` works either way. Clipboard text is never logged.
 */
export class ClipboardBridge {
  private enabled = false;
  private stream: { cancel(): void } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = CLIPBOARD_RETRY_MS;
  /** The last text this socket put on the clipboard: an event with it is our own echo. */
  private lastSet: string | null = null;
  /** setClipboard calls (and the Paste after one) run in order. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: ClipboardBridgeOptions) {}

  handle(message: Extract<ScreenClientMessage, { type: 'clipboardSync' | 'clipboard' | 'paste' }>): void {
    if (message.type === 'clipboardSync') this.setSync(message.enabled);
    else if (message.type === 'clipboard') this.copy(message.text);
    else this.paste(message.text);
  }

  setSync(enabled: boolean): void {
    if (this.closed || enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) this.open();
    else this.stopStream();
  }

  /** Desktop copy → Android's clipboard (only while sync is on). */
  copy(text: string): void {
    if (this.enabled) this.set(text, false);
  }

  /** Put the text on Android's clipboard, then press Paste. */
  paste(text: string): void {
    this.set(text, true);
  }

  close(): void {
    this.closed = true;
    this.enabled = false;
    this.stopStream();
  }

  private set(text: string, thenPaste: boolean): void {
    if (this.closed) return;
    this.chain = this.chain.then(async () => {
      if (this.closed) return;
      try {
        this.lastSet = text;
        await this.options.client.setClipboard(text);
        if (thenPaste && !this.closed) this.options.pressPaste();
      } catch (error) {
        if (isAuthError(error)) this.options.onAuthFailure();
        else log.warn(`Setting the clipboard of ${this.options.serial} failed: ${errorMessage(error)}`);
      }
    });
  }

  private open(): void {
    // The emulator sends the current content first: that is no copy, so it is skipped.
    let initial = true;
    this.stream = this.options.client.streamClipboard({
      onText: (text) => {
        if (initial) {
          initial = false;
          return;
        }
        this.retryMs = CLIPBOARD_RETRY_MS;
        if (text === '' || text === this.lastSet) return;
        this.options.deliver(truncateUtf8(text));
      },
      onEnd: (error) => {
        this.stream = null;
        if (isAuthError(error)) {
          this.options.onAuthFailure();
          return;
        }
        if (error) log.warn(`Clipboard stream of ${this.options.serial} failed: ${error.message}`);
        this.scheduleRetry();
      },
    });
  }

  private scheduleRetry(): void {
    if (!this.enabled || this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.enabled && !this.closed && !this.stream) this.open();
    }, this.retryMs);
    this.retryTimer.unref();
    this.retryMs = Math.min(this.retryMs * 2, CLIPBOARD_MAX_RETRY_MS);
  }

  private stopStream(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stream?.cancel();
    this.stream = null;
  }
}
