import type { EmulatorHost } from '../../src/emulator/emulatorHost.ts';

/** A machine without the Android Emulator: keeps server tests away from the real SDK and running emulators. */
export function noEmulatorHost(): EmulatorHost {
  return {
    emulatorPath: null,
    createClient: null,
    avdHome: '/nonexistent/avd',
    discoveryDirs: [],
    runEmulator: () => Promise.reject(new Error('no Android Emulator')),
    spawnEmulator: () => {
      throw new Error('no Android Emulator');
    },
    isAlive: () => false,
    isPortFree: async () => true,
  };
}
