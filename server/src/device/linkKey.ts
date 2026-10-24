import { createHmac, randomBytes } from 'node:crypto';
import { isValidPackageName, LINK_KEY_BYTES, LINK_KEY_RECEIVER } from '@lionscope/protocol';
import { adbShell } from '../adb/adb.ts';
import type { Adb } from '../adb/adb.ts';
import { errorMessage } from '../log.ts';
import type { SdkLinkMode } from './sdkLink.ts';

/** `am broadcast` returns once the receiver ran; slower than this, the link goes without a proof. */
export const LINK_KEY_TIMEOUT_MS = 5000;
/** `am broadcast` prints this once the (ordered) broadcast went through every receiver. */
const BROADCAST_COMPLETED = /^Broadcast completed\b/m;
const REDACTED_KEY = '<redacted>';

/** The shell command that hands `keyHex` to the app's LinkKeyReceiver, for process `pid` only. */
export function linkKeyCommand(packageName: string, pid: number, keyHex: string): string {
  return `am broadcast -n ${packageName}/${LINK_KEY_RECEIVER} --es key ${keyHex} --ei pid ${pid}`;
}

/** `welcome.proof`: hex(HMAC-SHA256(key, `<nonce>:<protocolVersion>:<mode>`)). */
export function linkProof(key: Buffer, nonce: string, protocolVersion: number, mode: SdkLinkMode): string {
  return createHmac('sha256', key).update(`${nonce}:${protocolVersion}:${mode}`).digest('hex');
}

export type LinkKeyResult = { ok: true; proof: string } | { ok: false; error: string };

/**
 * Make a fresh link key, hand it to the app over adb (LINK_KEY_RECEIVER, which keeps it only in process `pid`) and,
 * once the broadcast completed, sign the hello's nonce with it for a v`protocolVersion` session link. The key
 * itself is never kept, logged or put into an error (`error` is safe to log).
 */
export async function deliverLinkKey(
  adb: Adb,
  serial: string,
  hello: { packageName: string; pid: number; nonce: string },
  protocolVersion: number,
): Promise<LinkKeyResult> {
  const { packageName, pid, nonce } = hello;
  // Both are checked by the hello schema already; they go into a device shell command.
  if (!isValidPackageName(packageName) || !Number.isSafeInteger(pid) || pid <= 0) {
    return { ok: false, error: 'invalid package name or pid' };
  }
  const key = randomBytes(LINK_KEY_BYTES);
  const keyHex = key.toString('hex');
  try {
    const output = await adbShell(adb, serial, linkKeyCommand(packageName, pid, keyHex), {
      timeoutMs: LINK_KEY_TIMEOUT_MS,
    });
    if (!BROADCAST_COMPLETED.test(output)) return { ok: false, error: 'the broadcast did not complete' };
    return { ok: true, proof: linkProof(key, nonce, protocolVersion, 'session') };
  } catch (error) {
    return { ok: false, error: errorMessage(error).split(keyHex).join(REDACTED_KEY) };
  } finally {
    key.fill(0);
  }
}
