/// <reference types="node" />
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { HttpExchangeDetail } from '@lionscope/protocol/wire';
import { curlBlocker, requestCurl } from '../src/lib/curl.ts';

const captured: HttpExchangeDetail = {
  id: 14,
  ts: 1,
  endTs: 2,
  method: 'POST',
  url: 'https://example.test/?token=synthetic',
  state: 'complete',
  status: 200,
  headersMs: 1,
  durationMs: 1,
  requestSize: 0,
  responseSize: 0,
  responseType: null,
  mockId: null,
  error: null,
  screen: null,
  protocol: 'h2',
  requestHeaders: [['Authorization', 'Bearer synthetic']],
  responseHeaders: [],
  requestBody: null,
  responseBody: null,
  originalValues: true,
  requestComplete: true,
};

describe('Copy cURL', () => {
  it('requires original, complete data and explains omissions', () => {
    expect(curlBlocker(captured)).toBeNull();
    expect(curlBlocker({ ...captured, originalValues: undefined })).toContain('Update');
    expect(curlBlocker({ ...captured, requestComplete: false })).toContain('shortened');
    for (const [overrides, reason] of [
      [{ truncated: true }, 'truncated'],
      [{ text: null, omitted: 'type' as const }, 'not captured'],
      [{ text: '\0' }, 'NUL'],
    ] as const) {
      const detail = {
        ...captured,
        requestBody: {
          size: 1,
          contentType: 'text/plain',
          text: 'x',
          truncated: false,
          omitted: null,
          ...overrides,
        },
      };
      expect(curlBlocker(detail)).toContain(reason);
      expect(() => requestCurl(detail)).toThrow();
    }
    expect(requestCurl({ ...captured, method: 'HEAD' })).toContain('--head');
  });

  it('replays synthetic auth, quotes, shell characters, repeated/empty headers and UTF-8 body literally', async () => {
    const seen: { url: string | undefined; headers: string[]; body: Buffer; method: string | undefined }[] =
      [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      seen.push({ url: req.url, headers: req.rawHeaders, body: Buffer.concat(chunks), method: req.method });
      res.end('synthetic response');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No loopback port');
      const body =
        '@not-a-file\r\n{"token":"synthetic", "quote":"\' $(printf INJECTED) `printf INJECTED` é"}\n';
      const detail: HttpExchangeDetail = {
        ...captured,
        url: `http://127.0.0.1:${address.port}/a/../b?token=synthetic&items[]=a&quote='`,
        requestHeaders: [
          ['Authorization', "Bearer synthetic'$(printf INJECTED)`printf INJECTED`"],
          ['Cookie', 'sid=synthetic'],
          ['X-Repeat', 'a'],
          ['X-Repeat', 'b'],
          ['X-Empty', ''],
          ['Content-Length', '999'],
          ['Transfer-Encoding', 'chunked'],
        ],
        requestBody: {
          size: Buffer.byteLength(body),
          contentType: 'application/json',
          text: body,
          truncated: false,
          omitted: null,
        },
      };
      await promisify(execFile)('/bin/sh', ['-c', requestCurl(detail)], { timeout: 5000 });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.method).toBe('POST');
      expect(seen[0]?.url).toBe("/a/../b?token=synthetic&items[]=a&quote='");
      expect(seen[0]?.body).toEqual(Buffer.from(body));
      expect(seen[0]?.headers).toEqual(
        expect.arrayContaining([
          'Authorization',
          detail.requestHeaders[0]![1],
          'Cookie',
          'sid=synthetic',
          'Content-Type',
          'application/json',
          'X-Empty',
          '',
        ]),
      );
      expect(seen[0]?.headers.filter((v) => v === 'X-Repeat')).toHaveLength(2);
      expect(seen[0]?.headers).not.toContain('999');
      expect(seen[0]?.headers).not.toContain('chunked');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
