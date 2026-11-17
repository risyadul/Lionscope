import { useEffect } from 'react';
import { App } from '../../src/App.tsx';
import { useServices } from '../../src/app/services.ts';
import { DEFAULT_PERMISSIONS } from '@lionscope/protocol/wire';

export function PermissionsFixture() {
  const { store } = useServices();
  useEffect(() => {
    store.dispatch({
      kind: 'connection',
      connection: { status: 'open', attempt: 0, retryAt: null, closeReason: null },
    });
    store.dispatch({ kind: 'server', msg: { type: 'permissions', permissions: { ...DEFAULT_PERMISSIONS } } });
    const changed = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const value: unknown = event.detail;
      if (
        typeof value !== 'object' ||
        value === null ||
        !('deviceControl' in value) ||
        typeof value.deviceControl !== 'boolean' ||
        !('networkBodies' in value) ||
        typeof value.networkBodies !== 'boolean' ||
        !('storageRead' in value) ||
        typeof value.storageRead !== 'boolean' ||
        !('storageWrite' in value) ||
        typeof value.storageWrite !== 'boolean'
      )
        return;
      store.dispatch({
        kind: 'server',
        msg: {
          type: 'permissions',
          permissions: {
            deviceControl: value.deviceControl,
            networkBodies: value.networkBodies,
            storageRead: value.storageRead,
            storageWrite: value.storageWrite,
          },
        },
      });
    };
    window.addEventListener('fixture-permissions', changed);
    return () => window.removeEventListener('fixture-permissions', changed);
  }, [store]);
  return <App />;
}
