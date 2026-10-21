import { describe, expect, it } from 'vitest';
import { IS_BUNDLE, loadConfig, parseCliArgs, parsePort, SERVER_VERSION, USAGE } from '../src/config.ts';

const NO_ARGS = parseCliArgs([]);

describe('config', () => {
  it('defaults to port 8701 on 127.0.0.1 (SDK gateway 8700), not in dev mode', () => {
    expect(loadConfig({}, NO_ARGS)).toEqual({
      host: '127.0.0.1',
      port: 8701,
      devicePort: 8700,
      dashboardDir: undefined,
      adb: undefined,
      dev: false,
    });
  });

  it('reads env overrides', () => {
    expect(
      loadConfig(
        { LIONSCOPE_PORT: '0', LIONSCOPE_DEVICE_PORT: '9700', LIONSCOPE_DASHBOARD_DIR: '/d' },
        NO_ARGS,
      ),
    ).toEqual({
      host: '127.0.0.1',
      port: 0,
      devicePort: 9700,
      dashboardDir: '/d',
      adb: undefined,
      dev: false,
    });
    expect(parsePort(' ')).toBe(8701);
    expect(() => loadConfig({ LIONSCOPE_DEVICE_PORT: '70000' }, NO_ARGS)).toThrow(/LIONSCOPE_DEVICE_PORT/);
  });

  it('enables dev mode with --dev or LIONSCOPE_DEV=1', () => {
    expect(loadConfig({}, parseCliArgs(['--dev'])).dev).toBe(true);
    expect(loadConfig({ LIONSCOPE_DEV: '1' }, NO_ARGS).dev).toBe(true);
    expect(loadConfig({ LIONSCOPE_DEV: 'true' }, NO_ARGS).dev).toBe(false);
  });

  it.each(['0', '8701', '65535', '00080'])('accepts port %j', (raw) => {
    expect(parsePort(raw)).toBe(Number(raw));
  });

  it.each(['abc', '-1', '70000', '1.5', '0x1f', '1e3', ' 8701', '8701 ', '+80', '123456', '1_000'])(
    'rejects port %j',
    (raw) => {
      expect(() => parsePort(raw)).toThrow(/LIONSCOPE_PORT must be an integer between 0 and 65535/);
    },
  );

  it('reads the server version from package.json', () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('knows it is not the bundled npm package when running from source', () => {
    expect(IS_BUNDLE).toBe(false);
  });
});

describe('command-line flags', () => {
  it('parses every flag', () => {
    expect(NO_ARGS).toEqual({
      help: false,
      version: false,
      dev: false,
      port: undefined,
      devicePort: undefined,
      adb: undefined,
    });
    expect(
      parseCliArgs(['--port', '9000', '--device-port=9001', '--adb', '/opt/adb', '--dev', '-h', '-v']),
    ).toEqual({ help: true, version: true, dev: true, port: '9000', devicePort: '9001', adb: '/opt/adb' });
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs(['--version']).version).toBe(true);
  });

  it('trims --adb and treats a blank one as absent', () => {
    expect(parseCliArgs(['--adb', '  /opt/sdk/adb  ']).adb).toBe('/opt/sdk/adb');
    expect(parseCliArgs(['--adb', ' ']).adb).toBeUndefined();
  });

  // Node's own wording varies between versions: check the key part and the shape.
  it.each([
    [['--host', '0.0.0.0'], "Unknown option '--host'"],
    [['--port'], 'argument missing'],
    [['--port', '--dev'], 'argument is ambiguous'],
    [['serve'], "Unexpected argument 'serve'"],
    [['--port', '1', '--port', '2'], "Option '--port' given more than once"],
    [['--dev', '--dev'], "Option '--dev' given more than once"],
    [['-v', '--version'], "Option '--version' given more than once"],
  ])('rejects %j with a one-line message', (argv, fragment) => {
    let message = '';
    try {
      parseCliArgs(argv);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(fragment);
    expect(message).toMatch(/^[^\n]*[^.]\. Run lionscope --help for the options\.$/);
  });

  it('lets flags win over environment variables', () => {
    const env = { LIONSCOPE_PORT: '1000', LIONSCOPE_DEVICE_PORT: '1001', LIONSCOPE_ADB: '/env/adb' };
    const args = parseCliArgs(['--port', '0', '--device-port', '9700', '--adb', '/flag/adb']);
    expect(loadConfig(env, args)).toMatchObject({
      host: '127.0.0.1',
      port: 0,
      devicePort: 9700,
      adb: '/flag/adb',
    });
    // LIONSCOPE_ADB itself is read by resolveAdbPath.
    expect(loadConfig(env, NO_ARGS)).toMatchObject({ port: 1000, devicePort: 1001, adb: undefined });
  });

  it('validates port flags strictly', () => {
    const load = (argv: string[]) => () => loadConfig({}, parseCliArgs(argv));
    expect(load(['--port', '70000'])).toThrow(/--port must be an integer/);
    expect(load(['--port', '0x1f'])).toThrow(/--port must be an integer/);
    expect(load(['--device-port', '1e3'])).toThrow(/--device-port must be an integer/);
    expect(load(['--port', ''])).toThrow('--port needs a port number');
  });

  it('documents the user-facing flags, but not --dev', () => {
    for (const flag of ['--port', '--device-port', '--adb', '--help', '--version']) {
      expect(USAGE).toContain(flag);
    }
    expect(USAGE).not.toContain('--dev ');
    expect(USAGE).toContain('127.0.0.1 only');
  });
});
