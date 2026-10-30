import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SCREEN_WS_PATH, WS_PATH } from '@lionscope/protocol';
import { adbShell } from './adb/adb.ts';
import type { Adb } from './adb/adb.ts';
import { screencap } from './agent/deviceTools.ts';
import { createAgentHttp } from './agent/http.ts';
import { dumpUi, parseTopPackage, TOP_ACTIVITY_COMMAND } from './agent/uiDump.ts';
import { DontKeepActivities } from './agent/dontKeepActivities.ts';
import { UiHelpers } from './agent/uiHelper.ts';
import type { AgentBaseContext } from './agent/tool.ts';
import { BUFFER_WINDOW_MS, HOST, SERVER_VERSION } from './config.ts';
import { createDeviceGateway, SHARED_HELLO_BURST, SHARED_HELLOS_PER_SECOND } from './device/deviceGateway.ts';
import type { DeviceGatewayLimits } from './device/deviceGateway.ts';
import { InspectLinks } from './device/inspectLinks.ts';
import { LocationService } from './location/locationService.ts';
import { createEmulatorHost } from './emulator/emulatorHost.ts';
import type { EmulatorHost } from './emulator/emulatorHost.ts';
import { EmulatorManager } from './emulator/emulatorManager.ts';
import { createScreenGateway, isEmulatorSerial } from './emulator/screenGateway.ts';
import { cleanupScrcpyLeftovers } from './scrcpy/scrcpyServer.ts';
import { errorMessage, log } from './log.ts';
import { INSPECTOR_PATH_PREFIX, serveInspectorPng } from './http/inspectorFiles.ts';
import { applySecurityHeaders } from './http/securityHeaders.ts';
import { InspectorService } from './inspector/inspectorService.ts';
import { ViewEdits } from './inspector/viewEdits.ts';
import { TokenBucket } from './net/tokenBucket.ts';
import { createStaticHandler, resolveDashboardDir } from './http/staticFiles.ts';
import { buildAllowedOrigins, createWsGateway, isAllowedHost } from './http/wsGateway.ts';
import type { WsGateway } from './http/wsGateway.ts';
import { SessionManager } from './session/sessionManager.ts';
import type { CollectorIntervals } from './session/profilingSession.ts';

export interface LionscopeServerOptions {
  /** 0 picks a free port (tests). */
  port: number;
  /** In-app SDK gateway port (`adb reverse` target); 0 picks a free port. */
  devicePort: number;
  deviceLimits?: Partial<DeviceGatewayLimits>;
  adb: Adb;
  /** Defaults to LIONSCOPE_DASHBOARD_DIR resolution / dashboard/dist. */
  dashboardDir?: string;
  devicePollMs?: number;
  bufferWindowMs?: number;
  sessionIntervals?: Partial<CollectorIntervals>;
  pingIntervalMs?: number;
  /** Also accept WebSocket connections from the Vite dev server origins. */
  dev?: boolean;
  /** Defaults to the emulator of adb's SDK (tests pass a fake). */
  emulatorHost?: EmulatorHost;
  emulatorPollMs?: number;
  /** scrcpy-server for physical devices; defaults to the vendored one (tests pass a fixture). */
  scrcpyJarPath?: string;
  /** --allow-device-control: the agent endpoints list and run the device-control tools. */
  allowDeviceControl?: boolean;
  /** --allow-network-bodies: the agent endpoints return HTTP body texts (get_network_request). */
  allowNetworkBodies?: boolean;
  /** The UI helper tried before `uiautomator dump`; defaults to the vendored one. */
  uiHelperJarPath?: string;
}

export interface LionscopeServer {
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
  readonly address: AddressInfo | null;
  /** Bound SDK gateway address; null when it could not listen (sessions then run ADB-only). */
  readonly deviceAddress: AddressInfo | null;
  readonly manager: SessionManager;
  readonly emulators: EmulatorManager;
  /** What the agent tools run against (`lionscope mcp` calls them in-process). */
  readonly agent: AgentBaseContext;
}

/** Longest an Inspector snapshot may wait for uiautomator (it retries while the screen is not idle). */
const INSPECT_UI_DUMP_MS = 20_000;
const FOREGROUND_TIMEOUT_MS = 5000;

function sendPlain(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

export function createLionscopeServer(options: LionscopeServerOptions): LionscopeServer {
  const bufferWindowMs = options.bufferWindowMs ?? BUFFER_WINDOW_MS;
  const serveStatic = createStaticHandler(resolveDashboardDir(options.dashboardDir));
  let gateway: WsGateway | null = null;
  let address: AddressInfo | null = null;
  // Empty until listen() knows the real port (port 0 picks one).
  let allowedOrigins: ReadonlySet<string> = new Set();

  const emulatorHost = options.emulatorHost ?? createEmulatorHost(options.adb.path);
  const emulators = new EmulatorManager({
    adb: options.adb,
    host: emulatorHost,
    broadcast: (message) => gateway?.broadcast(message),
    pollMs: options.emulatorPollMs,
    stopSessionOn: (serial) => manager.stopSessionOn(serial),
  });
  const locations = new LocationService({
    adb: options.adb,
    emulatorClient: (serial) => {
      const target = emulators.mirrorTarget(serial);
      return target.ok && emulatorHost.createClient ? emulatorHost.createClient(target.endpoint) : null;
    },
    broadcast: (message) => gateway?.broadcast(message),
  });
  // Every inspect-only listener shares one hello budget (the session gateway keeps its own: inspect traffic must
  // not starve the session's app).
  const sharedHellos = new TokenBucket(SHARED_HELLO_BURST, SHARED_HELLOS_PER_SECOND);
  const inspectLinks: InspectLinks = new InspectLinks({
    adb: options.adb,
    createListener: (target) =>
      createDeviceGateway({ port: 0, target, limits: options.deviceLimits, sharedHellos }),
    route: (serial, hello, link) => manager.attachSdkOn(serial, hello, link),
    sessionPort: () => deviceGateway.address?.port ?? null,
  });
  // "Don't keep activities" this server turned on: put back when the device's session stops or the server closes.
  const dontKeepActivities = new DontKeepActivities({ adb: options.adb, helpers: () => uiHelper });
  const manager: SessionManager = new SessionManager({
    adb: options.adb,
    broadcast: (message) => {
      // A change in the adb device list can be an emulator starting or stopping.
      if (message.type === 'devices') {
        emulators.setDevices(message.devices);
        locations.setDevices(message.devices);
        dontKeepActivities.setDevices(message.devices, () => manager.getSessionState());
      }
      if (message.type === 'session')
        dontKeepActivities.sessionChanged(message.session, () => manager.getSessionState());
      gateway?.broadcast(message);
    },
    devicePollMs: options.devicePollMs,
    bufferWindowMs,
    sessionIntervals: options.sessionIntervals,
    deviceGatewayPort: () => deviceGateway.address?.port ?? null,
    inspectLinks,
  });
  const deviceGateway = createDeviceGateway({
    port: options.devicePort,
    target: manager,
    limits: options.deviceLimits,
  });

  const uiHelper = new UiHelpers({
    adb: options.adb,
    ...(options.uiHelperJarPath ? { jarPath: options.uiHelperJarPath } : {}),
  });
  const inspector = new InspectorService({
    sessions: manager,
    links: inspectLinks,
    // The agent's dump: it also refreshes what the element tools know of the screen.
    dumpUi: async (serial) =>
      (
        await dumpUi({ ...agent, deviceControl: false, networkBodies: false }, serial, {
          deadline: performance.now() + INSPECT_UI_DUMP_MS,
        })
      ).tree,
    screencap: (serial) => screencap({ adb: options.adb }, serial),
    foregroundPackage: async (serial) =>
      parseTopPackage(
        await adbShell(options.adb, serial, TOP_ACTIVITY_COMMAND, { timeoutMs: FOREGROUND_TIMEOUT_MS }),
      ),
    broadcast: (message, payload) => gateway?.broadcast(message, payload),
  });
  const viewEdits = new ViewEdits({ inspector });
  const agent: AgentBaseContext = {
    sessions: manager,
    emulators,
    inspector,
    viewEdits,
    locations,
    adb: options.adb,
    serverVersion: SERVER_VERSION,
    bufferWindowMs,
    dashboardUrl: () => (address ? `http://localhost:${address.port}` : null),
    sdkGatewayPort: () => deviceGateway.address?.port ?? null,
    now: Date.now,
    screenshots: new Map(),
    uiDumps: new Map(),
    activityInstances: new Map(),
    uiHelper,
    dontKeepActivities,
    deviceCalls: new Map(),
  };
  const agentHttp = createAgentHttp({
    ctx: agent,
    deviceControl: options.allowDeviceControl ?? false,
    networkBodies: options.allowNetworkBodies ?? false,
    port: () => address?.port ?? null,
  });

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    applySecurityHeaders(res);
    if (!isAllowedHost(req.headers.host)) {
      sendPlain(res, 403, 'Forbidden\n');
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendPlain(res, 400, 'Bad request\n');
      return;
    }
    if (agentHttp.handles(pathname)) {
      await agentHttp.handle(req, res, pathname);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendPlain(res, 405, 'Method not allowed\n');
      return;
    }
    if (pathname.startsWith(INSPECTOR_PATH_PREFIX)) {
      serveInspectorPng(req, res, pathname, {
        png: (id) => inspector.png(id),
        allowedOrigins: () => allowedOrigins,
      });
      return;
    }
    if (pathname === WS_PATH || pathname === SCREEN_WS_PATH) {
      sendPlain(res, 426, 'WebSocket upgrade required\n');
      return;
    }
    await serveStatic(req, res, pathname);
  };

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      log.error('HTTP request failed:', errorMessage(error));
      if (!res.headersSent) sendPlain(res, 500, 'Internal server error\n');
      else res.destroy();
    });
  });

  gateway = createWsGateway({
    server,
    manager,
    emulators,
    inspector,
    inspectLinks,
    viewEdits,
    locations,
    serverVersion: SERVER_VERSION,
    bufferWindowMs,
    allowedOrigins: () => allowedOrigins,
    pingIntervalMs: options.pingIntervalMs,
    delegatedPaths: new Set([SCREEN_WS_PATH]),
  });
  const screenGateway = createScreenGateway({
    server,
    emulators,
    createClient: emulatorHost.createClient,
    devices: {
      adb: options.adb,
      devices: () => manager.getDevices(),
      ...(options.scrcpyJarPath ? { jarPath: options.scrcpyJarPath } : {}),
    },
    allowedOrigins: () => allowedOrigins,
    pingIntervalMs: options.pingIntervalMs,
  });

  return {
    manager,
    emulators,
    agent,
    get address() {
      return address;
    },
    get deviceAddress() {
      return deviceGateway.address;
    },
    async listen() {
      const bound = await new Promise<AddressInfo>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, HOST, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      });
      address = bound;
      allowedOrigins = buildAllowedOrigins(bound.port, options.dev ?? false);
      try {
        await deviceGateway.listen();
      } catch (error) {
        log.warn(`SDK gateway cannot listen on ${HOST}:${options.devicePort}: ${errorMessage(error)}`);
        // `adb reverse` can target any host port, so a free one does just as well (e.g. 8700 is taken by
        // another Lionscope). Failing that, the dashboard stays useful without the SDK link.
        if (isAddressInUse(error)) {
          try {
            const fallback = await deviceGateway.listen(0);
            log.info(`SDK gateway listening on ${HOST}:${fallback.port} instead`);
          } catch (retryError) {
            log.warn(`SDK gateway cannot listen at all: ${errorMessage(retryError)}`);
          }
        }
      }
      manager.startDevicePolling();
      void emulators.refresh();
      // Servers an earlier, killed Lionscope left on physical devices (emulators never run scrcpy).
      void manager.refreshDevices().then((devices) =>
        cleanupScrcpyLeftovers(
          options.adb,
          devices
            .filter((device) => device.state === 'device' && !isEmulatorSerial(device.serial))
            .map((device) => device.serial),
        ),
      );
      return bound;
    },
    async close() {
      // In parallel: device screens (scrcpy cleanup), UI helpers, inspect-only links, the session, the emulators
      // this server booted, and the real locations of physical devices.
      await Promise.all([
        locations.close(),
        screenGateway.close(),
        // "Don't keep activities" is put back through the UI helper (at most 5 s), so the helpers close after it.
        dontKeepActivities.close().finally(() => uiHelper.close()),
        inspectLinks.close(),
        manager.close(),
        emulators.close(),
        agentHttp.close(),
      ]);
      viewEdits.close();
      await deviceGateway.close();
      await gateway?.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      address = null;
    },
  };
}
