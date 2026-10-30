import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupStrictMode, redactLogText, summarizeFrames } from '../src/insights/index.ts';
import { HTTP_REDACTED } from '../src/wire.ts';
import type { FrameSample, StackFrame, StrictModeSample } from '../src/wire.ts';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

function frame(ts: number, overrides: Partial<FrameSample> = {}): FrameSample {
  return {
    ts,
    frameCount: 60,
    jankCount: 3,
    slowCount: 5,
    fps: 60,
    p50Ms: 8,
    p90Ms: 14,
    p99Ms: 22,
    maxMs: 40,
    frameIntervalMs: 16.67,
    frameIntervalSource: 'reported',
    durationsMs: [8, 9, 10, 14, 30],
    ...overrides,
  };
}

const appFrame = (method: string, line: number): StackFrame => ({
  className: 'com.example.shop.cart.CartRepository',
  method,
  file: 'CartRepository.kt',
  line,
  inApp: true,
});

function violation(ts: number, overrides: Partial<StrictModeSample> = {}): StrictModeSample {
  return {
    ts,
    policy: 'thread',
    violation: 'DiskReadViolation',
    message: null,
    frames: [appFrame('load', 40)],
    count: 1,
    screen: 'Cart',
    ...overrides,
  };
}

describe('summarizeFrames', () => {
  it('sums the samples in the window', () => {
    const summary = summarizeFrames(
      [
        frame(T0 - 1000, { jankCount: 60 }),
        frame(T0, { fps: 30, frameCount: 30, maxMs: 90 }),
        frame(T0 + 1000, { source: 'sdk', slowCount: 1, jankCount: 2 }),
      ],
      T0,
      T0 + 1000,
    );
    expect(summary).toEqual({
      samples: 2,
      renderedFrames: 90,
      jankFrames: 5,
      slowFrames: 7,
      jankPercent: (5 / 90) * 100,
      slowPercent: (7 / 90) * 100,
      meanFps: 45,
      p50Ms: 10,
      p90Ms: 30,
      maxMs: 90,
      frameIntervalMs: 16.67,
      source: 'sdk',
    });
  });

  it('has no rates without frames, and ignores idle samples for the slowest frame', () => {
    const summary = summarizeFrames(
      [frame(T0, { frameCount: 0, fps: 0, maxMs: 500, durationsMs: [] })],
      T0,
      T0,
    );
    expect(summary).toMatchObject({
      jankPercent: null,
      meanFps: 0,
      maxMs: null,
      p90Ms: null,
      source: 'gfxinfo',
    });
    expect(summarizeFrames([], T0, T0)).toMatchObject({ samples: 0, meanFps: null, source: null });
  });
});

describe('groupStrictMode', () => {
  it('groups by violation and culprit line, most occurrences first', () => {
    const groups = groupStrictMode(
      [
        violation(T0, { count: 3 }),
        violation(T0 + 1000, { message: 'newest', screen: 'Home' }),
        violation(T0 + 2000, { frames: [appFrame('save', 70)] }),
        violation(T0 + 3000, { violation: 'NetworkViolation' }),
        violation(T0 - 5000, { count: 50 }),
      ],
      T0,
      T0 + 3000,
    );
    expect(groups.map((group) => [group.violation, group.frame?.line, group.occurrences])).toEqual([
      ['DiskReadViolation', 40, 4],
      ['NetworkViolation', 40, 1],
      ['DiskReadViolation', 70, 1],
    ]);
    expect(groups[0]).toMatchObject({ samples: 2, screens: ['Cart', 'Home'], lastTs: T0 + 1000 });
    expect(groups[0]?.latest.message).toBe('newest');
  });
});

describe('redactLogText', () => {
  const R = HTTP_REDACTED;
  /** `{"alg":"none"}.{"sub":"test"}.fake-signature`: obviously not a real token. */
  const JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.fake-signature';

  it('redacts sensitive header lines as OkHttp and Ktor log them', () => {
    expect(redactLogText(`Authorization: Bearer ${JWT}`)).toBe(`Authorization: ${R}`);
    expect(redactLogText('authorization: Basic dXNlcjpmYWtl')).toBe(`authorization: ${R}`);
    expect(redactLogText('-> Proxy-Authorization: fake-credential')).toBe(`-> Proxy-Authorization: ${R}`);
    expect(redactLogText('Cookie: sid=fake-sid; theme=dark')).toBe(`Cookie: ${R}`);
    expect(redactLogText('Set-Cookie: sid=fake-sid; Path=/; HttpOnly')).toBe(`Set-Cookie: ${R}`);
    expect(redactLogText('X-Api-Key: fake-key-123')).toBe(`X-Api-Key: ${R}`);
    expect(redactLogText('Content-Type: application/json\nX-Auth-Token: fake')).toBe(
      `Content-Type: application/json\nX-Auth-Token: ${R}`,
    );
    expect(redactLogText('D/OkHttp: Set-Cookie: sid=fake-sid')).toBe(`D/OkHttp: Set-Cookie: ${R}`);
  });

  it("redacts headers as OkHttp's toMultimap() prints them", () => {
    expect(redactLogText('{Authorization=[Bearer fake-opaque], Accept=[application/json]}')).toBe(
      `{Authorization=[${R}], Accept=[application/json]}`,
    );
    expect(redactLogText('headers={authorization=Bearer fake-opaque}')).toBe(`headers={authorization=${R}}`);
  });

  it('redacts bearer credentials and bare JWTs anywhere in a line', () => {
    expect(redactLogText(`refresh failed for Bearer fake-opaque-token`)).toBe(
      `refresh failed for Bearer ${R}`,
    );
    expect(redactLogText('retry with Basic dXNlcjpmYWtl')).toBe(`retry with Basic ${R}`);
    expect(redactLogText('sent Token fake0token1')).toBe(`sent Token ${R}`);
    expect(redactLogText(`cached id token ${JWT}, expires in 3600 s`)).toBe(
      `cached id token ${R}, expires in 3600 s`,
    );
  });

  it('redacts JSON values, name=value pairs and URL parameters', () => {
    expect(redactLogText('<-- 200 {"access_token":"fake-at","token_type":"bearer","user":"ana"}')).toBe(
      `<-- 200 {"access_token":"${R}","token_type":"${R}","user":"ana"}`,
    );
    expect(redactLogText('login ok access_token=fake-at&state=1')).toBe(`login ok access_token=${R}&state=1`);
    expect(redactLogText('GET https://api.example.com/v1/items?api_key=fake&page=2')).toBe(
      `GET https://api.example.com/v1/items?api_key=${R}&page=2`,
    );
    expect(redactLogText('redirect: myapp://callback?code=fake-code&state=1')).toBe(
      `redirect: myapp://callback?code=${R}&state=1`,
    );
    expect(redactLogText('<password>fake-password</password>')).toBe(`<password>${R}</password>`);
  });

  it('redacts JSON pairs of bodies logged line by line or in 4000-character chunks', () => {
    expect(redactLogText('  "refresh_token": "fake-opaque",')).toBe(`  "refresh_token": "${R}",`);
    expect(redactLogText('ab","refresh_token":"fake-opaque","user":{"id":1}}')).toBe(
      `ab","refresh_token":"${R}","user":{"id":1}}`,
    );
    expect(redactLogText('"expires_in": 3600, "id_token": 12345')).toBe(
      `"expires_in": 3600, "id_token": "${R}"`,
    );
  });

  it('redacts credential-shaped values after a name ending in token, secret, password or api key', () => {
    expect(redactLogText('Refreshed token: fakeFcmToken:APA91bFakeFakeFake')).toBe(`Refreshed token: ${R}`);
    expect(redactLogText('Google access token: ya29.fake0fake')).toBe(`Google access token: ${R}`);
    expect(redactLogText('sent with x-api-key: fake1key2value')).toBe(`sent with x-api-key: ${R}`);
    expect(redactLogText('Invalid token: expired')).toBe('Invalid token: expired');
  });

  it('redacts short passwords and secrets, and short values of sensitive names at the start of a line', () => {
    for (const [line, redacted] of [
      ['password: hunter2', `password: ${R}`],
      ['password: letmein!', `password: ${R}`],
      ['secret: s3cr3t', `secret: ${R}`],
      ['clientSecret: abc', `clientSecret: ${R}`],
      ['Login email: a@b.c password: hunter2', `Login email: a@b.c password: ${R}`],
      ['token: abc123', `token: ${R}`],
      ['apiKey: k3y', `apiKey: ${R}`],
      ['sessionId: 9f8e7d6c', `sessionId: ${R}`],
    ]) {
      expect(redactLogText(line!)).toBe(redacted);
    }
  });

  it('redacts OAuth codes and PKCE verifiers, but not status codes', () => {
    expect(
      redactLogText('grant_type=authorization_code&code=4/0AX4fakeCode&code_verifier=fakeVerifier0123456789'),
    ).toBe(`grant_type=authorization_code&code=${R}&code_verifier=${R}`);
    expect(redactLogText('{"grant_type":"authorization_code","code":"4/0AX4fakeCode"}')).toBe(
      `{"grant_type":"authorization_code","code":"${R}"}`,
    );
  });

  it('leaves ordinary lines alone', () => {
    for (const line of [
      'Displayed com.example.shop/.MainActivity: +412ms',
      'Content-Type: application/json; charset=utf-8',
      'code: 404',
      'Token refresh scheduled in 30 s',
      'Basic information loaded',
      'GET https://api.example.com/v1/items?page=2',
      '{"id":7,"name":"Cart"}',
      'Bundle[{position=3}]',
      'AuthRepository: login failed with 401',
      'SessionManager: restored 3 screens',
      'Session: restored 3 screens',
      'key: R.string.title',
      'HTTP failed code=500 for /cart',
      '<-- 500 {"code":"E401","message":"expired"}',
      'onKeyDown keyCode=4',
      'Caused by: com.example.shop.AuthException: Session invalid',
      'Token expired at 2026-10-30T10:00:00Z',
    ]) {
      expect(redactLogText(line)).toBe(line);
    }
  });

  it('takes linear time on adversarial lines (one character class, 4000 characters)', () => {
    const lines = [
      'a'.repeat(4000),
      '-'.repeat(4000),
      `Token ${'a'.repeat(3993)}!`,
      'eyJ-'.repeat(1000),
      'eyJa.eyJb-'.repeat(400),
      'a-'.repeat(2000),
      '"a":"'.repeat(800),
      ' a="'.repeat(1000),
      'x=[Bearer '.repeat(400),
      '0123456789abcdef'.repeat(250),
    ];
    const start = performance.now();
    for (let i = 0; i < 20; i++) for (const line of lines) redactLogText(line + i);
    // About 0.1 ms per line on a laptop; a backtracking pattern takes 10 ms and more.
    expect((performance.now() - start) / (20 * lines.length)).toBeLessThan(2);
  });
});

describe('dependencies', () => {
  it('imports nothing but the wire contract and itself (the dashboard bundles it under a strict CSP)', () => {
    const dir = new URL('../src/insights/', import.meta.url);
    for (const file of readdirSync(dir)) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\.?\/(?:wire|[a-z]+)\.ts$/);
      }
    }
  });
});
