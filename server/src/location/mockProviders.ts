/**
 * Mock locations on a physical device (Android 12+), through the `cmd location` shell commands: the shell gets
 * the MOCK_LOCATION app op, adds test providers that replace `gps`, `network` and `fused`, and pushes the point to
 * them. A marker file on the device remembers the shell's app op mode from before and which server set it, so the
 * device can be restored by whoever finds it there after a crash.
 */
import { adbShell } from '../adb/adb.ts';
import type { Adb } from '../adb/adb.ts';

/** `fused` last: older builds may refuse it, and gps + network are enough for most apps. */
export const MOCK_PROVIDERS = ['gps', 'network', 'fused'] as const;
export type MockProvider = (typeof MOCK_PROVIDERS)[number];

const PROVIDER_FLAGS: Readonly<Record<MockProvider, string>> = {
  gps: ' --supportsAltitude --supportsSpeed --supportsBearing',
  network: ' --requiresNetwork',
  fused: '',
};
/** Metres; small enough that apps waiting for a precise fix take it. */
const ACCURACY_M = 5;
export const MARKER_PATH = '/data/local/tmp/lionscope-location';
const APP_OP = 'com.android.shell android:mock_location';
const APP_OP_MODES = ['allow', 'ignore', 'deny', 'default', 'foreground'] as const;
export type AppOpMode = (typeof APP_OP_MODES)[number];
const ADB_TIMEOUT_MS = 10_000;

/** What `probeDevice` read: the API level, the location switch, the shell's app op and our marker (if any). */
export interface DeviceProbe {
  sdk: number | null;
  locationEnabled: boolean | null;
  appOp: AppOpMode;
  marker: LocationMarker | null;
}

export interface LocationMarker {
  /** The host pid of the Lionscope server that set it. */
  pid: number;
  /** Which machine that server runs on (`hostId`): a pid means nothing on another one. */
  host: string;
  /** The shell's app op mode before it was set. */
  mode: AppOpMode;
}

/** Degrees as the shell commands take them: fixed-point, never `1e-7`. */
export function formatDegrees(value: number): string {
  return value.toFixed(7);
}

export function formatMarker(marker: LocationMarker): string {
  return `lionscope-location pid=${marker.pid} host=${marker.host} mode=${marker.mode}`;
}

export function parseMarker(text: string): LocationMarker | null {
  const match = /^lionscope-location pid=(\d{1,10}) host=([0-9a-f]{1,64}) mode=([a-z]+)$/.exec(text.trim());
  const mode = APP_OP_MODES.find((candidate) => candidate === match?.[3]);
  return match && mode ? { pid: Number(match[1]), host: match[2] ?? '', mode } : null;
}

/** `MOCK_LOCATION: allow; time=…` or, never set, `No operations.` (the default mode). */
export function parseAppOpMode(output: string): AppOpMode {
  const match = /MOCK_LOCATION: ([a-z]+)/.exec(output);
  return APP_OP_MODES.find((mode) => mode === match?.[1]) ?? 'default';
}

const PROBE_COMMAND = [
  'echo "LS_SDK=$(getprop ro.build.version.sdk)"',
  'echo "LS_ENABLED=$(cmd location is-location-enabled 2>/dev/null)"',
  `echo "LS_MARKER=$(cat ${MARKER_PATH} 2>/dev/null)"`,
  `appops get ${APP_OP}`,
].join('; ');

function field(output: string, name: string): string | null {
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}=`));
  return line === undefined ? null : line.slice(name.length + 1).trim();
}

export function parseProbe(output: string): DeviceProbe {
  const sdk = Number.parseInt(field(output, 'LS_SDK') ?? '', 10);
  const enabled = field(output, 'LS_ENABLED');
  return {
    sdk: Number.isFinite(sdk) ? sdk : null,
    locationEnabled: enabled === 'true' ? true : enabled === 'false' ? false : null,
    appOp: parseAppOpMode(output),
    marker: parseMarker(field(output, 'LS_MARKER') ?? ''),
  };
}

export async function probeDevice(adb: Adb, serial: string): Promise<DeviceProbe> {
  return parseProbe(await adbShell(adb, serial, PROBE_COMMAND, { timeoutMs: ADB_TIMEOUT_MS }));
}

function setLocationCommand(provider: MockProvider, latitude: number, longitude: number): string {
  const at = `${formatDegrees(latitude)},${formatDegrees(longitude)}`;
  return `cmd location providers set-test-provider-location ${provider} --location ${at} --accuracy ${ACCURACY_M}`;
}

/**
 * Write the marker, allow the shell mock locations and add the providers; nothing changes unless the marker (what to
 * restore) was written first. Resolves with the providers that took; rejects with the device's own words when gps or
 * network did not.
 */
export async function installProviders(
  adb: Adb,
  serial: string,
  marker: LocationMarker,
): Promise<MockProvider[]> {
  const providers = MOCK_PROVIDERS.map(
    (provider) =>
      `{ cmd location providers add-test-provider ${provider}${PROVIDER_FLAGS[provider]} && ` +
      `cmd location providers set-test-provider-enabled ${provider} true && echo LS_ADDED=${provider}; } 2>&1`,
  );
  const command =
    `if echo '${formatMarker(marker)}' > ${MARKER_PATH} && appops set ${APP_OP} allow; ` +
    `then ${providers.join('; ')}; else echo 'error: could not write ${MARKER_PATH}'; fi`;
  const output = await adbShell(adb, serial, command, { timeoutMs: ADB_TIMEOUT_MS });
  const added = MOCK_PROVIDERS.filter((provider) => output.includes(`LS_ADDED=${provider}`));
  if (!added.includes('gps') || !added.includes('network')) {
    await removeProviders(adb, serial, marker.mode).catch(() => undefined);
    throw new MockLocationRefused(refusalReason(output));
  }
  return added;
}

/** The device refused mock locations; `message` is the device's own first error line, cleaned up. */
export class MockLocationRefused extends Error {
  override name = 'MockLocationRefused';
}

const MAX_REASON_CHARS = 160;

function refusalReason(output: string): string {
  const line = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => /exception|denied|not allowed|error/i.test(candidate));
  return (line ?? 'the device did not add the test providers')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .slice(0, MAX_REASON_CHARS);
}

/** Send the point to every provider (also every second, as a GPS does, so apps that wait for a fresh fix get one). */
export async function pushLocation(
  adb: Adb,
  serial: string,
  providers: readonly MockProvider[],
  latitude: number,
  longitude: number,
): Promise<void> {
  const command = providers.map((provider) => setLocationCommand(provider, latitude, longitude)).join('; ');
  await adbShell(adb, serial, command, { timeoutMs: ADB_TIMEOUT_MS });
}

/** Remove every test provider (gives the device its real location back), restore the app op, drop the marker. */
export async function removeProviders(adb: Adb, serial: string, mode: AppOpMode): Promise<void> {
  const steps = [
    ...MOCK_PROVIDERS.map(
      (provider) => `cmd location providers remove-test-provider ${provider} >/dev/null 2>&1`,
    ),
    `appops set ${APP_OP} ${mode}`,
    `rm -f ${MARKER_PATH}`,
  ];
  await adbShell(adb, serial, steps.join('; '), { timeoutMs: ADB_TIMEOUT_MS });
}
