// Test-only: the package itself stays free of Node types (it is shared with the browser dashboard).
/// <reference types="node" />
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_PROTOCOL_V5,
  DEVICE_PROTOCOL_V7,
  HTTP_REDACTED,
  LINK_KEY_BYTES,
  LINK_NONCE_PATTERN,
  LINK_PROOF_PATTERN,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_DEVICE_LINE_BYTES,
  MAX_HTTP_BODY_BYTES,
  MAX_HTTP_HEADERS,
  MAX_HTTP_LINE_BYTES,
  MAX_MOCK_BODY_BYTES,
  MAX_MOCK_CLIENT_MESSAGE_BYTES,
  MAX_MOCK_DELAY_MS,
  MAX_MOCK_HEADERS,
  MAX_NETWORK_MOCKS,
  maxDeviceLineBytes,
  parseClientMessage,
  parseDeviceMessage,
  peekLineType,
} from '../src/index.ts';
import type { DeviceMessage, NetworkMockInput } from '../src/index.ts';

const lines = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
const DEVICE_LINES = lines('device-messages.ndjson');
const GATEWAY_LINES = lines('gateway-messages.ndjson');

function golden(type: string, index = 0): Record<string, unknown> {
  const line = DEVICE_LINES.filter((candidate) => (JSON.parse(candidate) as DeviceMessage).type === type)[
    index
  ];
  if (!line) throw new Error(`no golden ${type} line #${index}`);
  return JSON.parse(line) as Record<string, unknown>;
}

const errorOf = (value: object, version = DEVICE_PROTOCOL_V7) => {
  const result = parseDeviceMessage(JSON.stringify(value), version);
  return result.ok ? null : result.error;
};

describe('v7 network messages', () => {
  const request = golden('httpRequest');
  const response = golden('httpResponse');
  const posted = golden('httpRequest', 1);
  const failed = golden('httpResponse', 2);
  const binary = golden('httpResponse', 3);

  it('has golden lines for a request with and without a body, a mocked one, a failure and a binary body', () => {
    expect(request.body).toBeNull();
    expect(posted.mockId).toBe('m1');
    expect(failed.status).toBeNull();
    expect((binary.body as { omitted: string }).omitted).toBe('type');
    expect(JSON.stringify(request)).toContain(HTTP_REDACTED);
  });

  it('flags them as unnegotiated below v7, without validating them', () => {
    for (const message of [request, response, { type: 'mocksApplied' }]) {
      expect(parseDeviceMessage(JSON.stringify(message), DEVICE_PROTOCOL_V5)).toEqual({
        ok: false,
        error: `${String(message.type)} needs protocol version 7`,
        unnegotiated: { type: message.type, since: DEVICE_PROTOCOL_V7 },
      });
    }
  });

  it('flags invalid ones as skippable (never fatal to the link)', () => {
    for (const message of [{ ...request, id: 0 }, { ...response, status: 99 }, { type: 'mocksApplied' }]) {
      expect(parseDeviceMessage(JSON.stringify(message))).toMatchObject({
        ok: false,
        invalidDiagnostic: message.type,
      });
    }
  });

  it('bounds the request: method, url, headers, ids and the drop count', () => {
    const header = (index: number): [string, string] => [`X-H${index}`, 'v'];
    expect(errorOf({ ...request, method: 'PROPFIND' })).toBeNull();
    expect(
      errorOf({ ...request, headers: Array.from({ length: MAX_HTTP_HEADERS }, (_, i) => header(i)) }),
    ).toBeNull();
    expect(errorOf({ ...request, headers: [['X-Empty', '']] })).toBeNull();
    for (const bad of [
      { method: 'GET /' },
      { method: '' },
      { method: 'M'.repeat(17) },
      { url: 'ftp://files.example.com/a' },
      { url: 'https://api.example.com/\n' },
      { url: `https://api.example.com/${'a'.repeat(4096)}` },
      { headers: Array.from({ length: MAX_HTTP_HEADERS + 1 }, (_, i) => header(i)) },
      { headers: [['Bad Name', 'v']] },
      { headers: [['X-Bidi', '‮evil']] },
      { headers: [['X-Line', 'a\r\nInjected: 1']] },
      { headers: [['X-Big', 'v'.repeat(4097)]] },
      { headers: Array.from({ length: 5 }, (_, i) => [`X-${i}`, 'v'.repeat(4000)]) },
      { headers: [['Only-Name']] },
      { id: 2 ** 31 },
      { id: 1.5 },
      { mockId: 'rule-1' },
      { dropped: -1 },
      { dropped: 1_000_001 },
    ]) {
      expect(errorOf({ ...request, ...bad }), JSON.stringify(bad).slice(0, 80)).not.toBeNull();
    }
  });

  it('bounds bodies by UTF-8 bytes and keeps their text as sent (newlines included)', () => {
    const body = posted.body as Record<string, unknown>;
    const withText = (text: string) => ({ ...posted, body: { ...body, text } });
    expect(errorOf(withText('line 1\nline 2\t\u0000'))).toBeNull();
    expect(errorOf(withText('a'.repeat(MAX_HTTP_BODY_BYTES)))).toBeNull();
    expect(errorOf(withText('a'.repeat(MAX_HTTP_BODY_BYTES + 1)))).not.toBeNull();
    expect(errorOf(withText('é'.repeat(MAX_HTTP_BODY_BYTES / 2 + 1)))).not.toBeNull();
    for (const bad of [
      { size: -1 },
      { size: 1.5 },
      { contentType: '' },
      { contentType: 'text/plain\n' },
      { omitted: 'binary' },
      { truncated: 'no' },
    ]) {
      expect(errorOf({ ...posted, body: { ...body, ...bad } })).not.toBeNull();
    }
  });

  it('bounds the response: status, protocol, durations and the error', () => {
    expect(errorOf({ ...response, status: 999 })).toBeNull();
    expect(errorOf({ ...failed, error: { kind: 'connection', message: null } })).toBeNull();
    for (const bad of [
      { status: 1000 },
      { status: 200.5 },
      { protocol: 'HTTP/2 ' },
      { protocol: '' },
      { durationMs: -1 },
      { durationMs: 3_600_001 },
      { headersMs: -1 },
      { error: { kind: 'lost', message: null } },
      { error: { kind: 'timeout', message: 'm'.repeat(257) } },
    ]) {
      expect(errorOf({ ...response, ...bad })).not.toBeNull();
    }
  });

  it('cleans control characters out of error messages', () => {
    const result = parseDeviceMessage(
      JSON.stringify({ ...failed, error: { kind: 'io', message: 'boom\n‮again' } }),
    );
    expect(result).toMatchObject({ ok: true, value: { error: { kind: 'io', message: 'boom again' } } });
  });

  it('bounds mocksApplied', () => {
    expect(errorOf({ type: 'mocksApplied', rev: 0, count: 0 })).toBeNull();
    expect(errorOf({ type: 'mocksApplied', rev: 1, count: MAX_NETWORK_MOCKS + 1 })).not.toBeNull();
    expect(errorOf({ type: 'mocksApplied', rev: -1, count: 0 })).not.toBeNull();
  });

  it('allows MAX_HTTP_LINE_BYTES only for http lines on v7 links', () => {
    expect(peekLineType('{"type":"httpResponse","id":1}')).toBe('httpResponse');
    expect(peekLineType('{ "type":"httpResponse"}')).toBeNull();
    expect(maxDeviceLineBytes('httpRequest', DEVICE_PROTOCOL_V7)).toBe(MAX_HTTP_LINE_BYTES);
    expect(maxDeviceLineBytes('httpResponse', DEVICE_PROTOCOL_V7)).toBe(MAX_HTTP_LINE_BYTES);
    expect(maxDeviceLineBytes('httpResponse', DEVICE_PROTOCOL_V5)).toBe(MAX_DEVICE_LINE_BYTES);
    expect(maxDeviceLineBytes('heartbeat', DEVICE_PROTOCOL_V7)).toBe(MAX_DEVICE_LINE_BYTES);
    expect(maxDeviceLineBytes(null, DEVICE_PROTOCOL_V7)).toBe(MAX_DEVICE_LINE_BYTES);
    const padded = JSON.stringify({ ...response, extra: 'x'.repeat(MAX_DEVICE_LINE_BYTES) });
    expect(parseDeviceMessage(padded, DEVICE_PROTOCOL_V7).ok).toBe(true);
    const heartbeat = `{"type":"heartbeat","ts":1,"droppedMessages":0,"p":"${'x'.repeat(MAX_DEVICE_LINE_BYTES)}"}`;
    expect(parseDeviceMessage(heartbeat, DEVICE_PROTOCOL_V7)).toEqual({
      ok: false,
      error: 'message too large',
    });
    const huge = JSON.stringify({ ...response, extra: 'x'.repeat(MAX_HTTP_LINE_BYTES) });
    expect(parseDeviceMessage(huge, DEVICE_PROTOCOL_V7)).toEqual({ ok: false, error: 'message too large' });
  });
});

describe('gateway golden lines (server → SDK)', () => {
  it('are flat objects with type first and only primitive values', () => {
    expect(GATEWAY_LINES.length).toBeGreaterThanOrEqual(4);
    for (const line of GATEWAY_LINES) {
      expect(line.startsWith('{"type":"')).toBe(true);
      const value = JSON.parse(line) as Record<string, unknown>;
      for (const field of Object.values(value)) expect(typeof field).not.toBe('object');
      // Re-serialising gives the same bytes: what the server's encoder must produce.
      expect(JSON.stringify(value)).toBe(line);
    }
    expect(new Set(GATEWAY_LINES.map((line) => (JSON.parse(line) as { type: string }).type))).toEqual(
      new Set([
        'welcome',
        'mocks',
        'mock',
        'config',
        'bye',
        'inspect',
        'setViewProperty',
        'revertViewProperties',
      ]),
    );
  });

  it('has a welcome whose proof is the HMAC of the golden hello nonce under the test key 00 01 … 1f', () => {
    const hello = golden('hello', 1);
    const welcome = JSON.parse(GATEWAY_LINES[0] ?? '{}') as Record<string, unknown>;
    expect(hello.nonce).toMatch(LINK_NONCE_PATTERN);
    expect(welcome.proof).toMatch(LINK_PROOF_PATTERN);
    const key = Buffer.from(Array.from({ length: LINK_KEY_BYTES }, (_, i) => i));
    const message = `${String(hello.nonce)}:${String(welcome.protocolVersion)}:${String(welcome.mode)}`;
    expect(createHmac('sha256', key).update(message).digest('hex')).toBe(welcome.proof);
  });

  it('accepts a hello nonce only as 32 lower-case hex digits', () => {
    const hello = golden('hello', 1);
    expect(parseDeviceMessage(JSON.stringify(hello)).ok).toBe(true);
    for (const nonce of ['', 'ABCDEF0123456789abcdef0123456789', '9f86d0', 'x'.repeat(32)]) {
      expect(parseDeviceMessage(JSON.stringify({ ...hello, nonce })).ok).toBe(false);
    }
  });
});

describe('network client messages', () => {
  const rule: NetworkMockInput = {
    method: 'GET',
    match: 'prefix',
    url: 'https://api.example.com/v1/items',
    action: 'respond',
    status: 200,
    headers: [['Content-Type', 'application/json']],
    body: '[]',
    delayMs: 0,
    enabled: true,
  };
  const parse = (message: object) => parseClientMessage(JSON.stringify(message));
  const setMock = (changes: Record<string, unknown>) =>
    parse({ type: 'setNetworkMock', rule: { ...rule, ...changes } });

  it('parses getHttpExchange, setNetworkMock and clearNetworkMocks', () => {
    for (const message of [
      { type: 'getHttpExchange', id: 1 },
      { type: 'setNetworkMock', rule },
      {
        type: 'setNetworkMock',
        rule: { ...rule, id: 'm12', method: null, match: 'glob', url: '*://*/v1/*' },
      },
      { type: 'setNetworkMock', rule: { ...rule, action: 'timeout', delayMs: MAX_MOCK_DELAY_MS } },
      { type: 'setNetworkMock', rule: { ...rule, url: 'HTTPS://API.example.com/v1' } },
      { type: 'clearNetworkMocks' },
      { type: 'clearNetworkMocks', id: 'm3' },
    ]) {
      expect(parse(message)).toEqual({ ok: true, value: message });
    }
  });

  it('rejects bad rules', () => {
    for (const bad of [
      { id: 'x1' },
      { id: 'm0' },
      { method: 'get' },
      { method: '*' },
      { match: 'regex' },
      { url: 'api.example.com/v1' },
      { url: 'https://api.example.com/v 1' },
      { url: 'https://api.example.com/\u0000' },
      { url: `https://api.example.com/${'a'.repeat(2048)}` },
      { url: '*://api.example.com/*' },
      { match: 'glob', url: `https://${'*.'.repeat(9)}example.com` },
      { action: 'drop' },
      { status: 99 },
      { status: 600 },
      { headers: [['Content Type', 'x']] },
      { headers: [['X-Line', 'a\nb']] },
      { headers: Array.from({ length: MAX_MOCK_HEADERS + 1 }, (_, i) => [`X-${i}`, 'v']) },
      { body: 'é'.repeat(MAX_MOCK_BODY_BYTES / 2 + 1) },
      { delayMs: -1 },
      { delayMs: MAX_MOCK_DELAY_MS + 1 },
      { delayMs: 1.5 },
      { enabled: 'yes' },
      { extra: true },
    ]) {
      expect(setMock(bad).ok, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    expect(parse({ type: 'getHttpExchange', id: 0 }).ok).toBe(false);
    expect(parse({ type: 'clearNetworkMocks', id: 'all' }).ok).toBe(false);
  });

  it('lets only setNetworkMock use the larger frame', () => {
    const big = { ...rule, body: 'a'.repeat(MAX_MOCK_BODY_BYTES) };
    const frame = JSON.stringify({ type: 'setNetworkMock', rule: big });
    expect(frame.length).toBeGreaterThan(MAX_CLIENT_MESSAGE_BYTES);
    expect(parseClientMessage(frame).ok).toBe(true);
    const padded = `{"type":"clearNetworkMocks","x":"${'a'.repeat(MAX_CLIENT_MESSAGE_BYTES)}"}`;
    expect(parseClientMessage(padded)).toEqual({ ok: false, error: 'message too large' });
    const overFrame = `{"type":"setNetworkMock","x":"${'a'.repeat(MAX_MOCK_CLIENT_MESSAGE_BYTES)}"}`;
    expect(parseClientMessage(overFrame)).toEqual({ ok: false, error: 'message too large' });
  });
});
