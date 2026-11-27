import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import './fixture.css';
import { ServicesContext, useDashboardState } from '../../src/app/services.ts';
import { StoragePanel } from '../../src/components/storage/StoragePanel.tsx';
import { StatStrip } from '../../src/components/stats/StatStrip.tsx';
import { DeviceColumn, DeviceToggle } from '../../src/components/device/DeviceColumn.tsx';
import { useDeviceColumn } from '../../src/hooks/useDeviceColumn.ts';
import { createFixtureServices, stats } from './data.ts';
import { InspectorFixture } from './InspectorFixture.tsx';
import { NetworkFixture } from './NetworkFixture.tsx';
import { PermissionsFixture } from './PermissionsFixture.tsx';

const services = createFixtureServices();
const query = new URLSearchParams(location.search);

function StorageFixture() {
  const [workspace, setWorkspace] = useState<'storage' | 'network'>(
    query.get('workspace') === 'network' ? 'network' : 'storage',
  );
  const device = useDeviceColumn(false, workspace);
  const state = useDashboardState();
  return (
    <div className="fixture-shell">
      <header className="fixture-header">
        <h1>Synthetic layout regression</h1>
        <DeviceToggle isOpen={device.isOpen} onOpenChange={device.setOpen} />
      </header>
      <div className="fixture-workspace">
        <nav className="fixture-navigation" aria-label="Fixture workspaces">
          <button
            type="button"
            className="btn"
            aria-pressed={workspace === 'storage'}
            onClick={() => setWorkspace('storage')}
          >
            Storage
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={workspace === 'network'}
            onClick={() => setWorkspace('network')}
          >
            Network
          </button>
        </nav>
        <DeviceColumn
          mode={device.mode}
          isOpen={device.isOpen}
          onOpenChange={device.setOpen}
          subtitle="Synthetic emulator"
        >
          <div className="fixture-device" role="img" aria-label="Synthetic emulator placeholder">
            Synthetic emulator
          </div>
        </DeviceColumn>
        <main className="fixture-main">
          <div className="fixture-storage" hidden={workspace !== 'storage'}>
            <StoragePanel
              consent="read_write"
              answers={state.storageAnswers}
              outcomes={state.storageOutcomes}
              isRunning
              sessionKey="synthetic-layout-link"
            />
          </div>
          {workspace === 'network' && (
            <p className="fixture-note">Synthetic Network workspace for mirror state checks.</p>
          )}
        </main>
      </div>
    </div>
  );
}

function StatsFixture() {
  const requested = Number(query.get('panelWidth') ?? 680);
  const width = Number.isInteger(requested) && requested >= 240 && requested <= 1000 ? requested : 680;
  return (
    <main className="fixture-stats">
      <h1>Synthetic readout layout regression</h1>
      <p>Panel width is independent of the browser viewport.</p>
      <div data-testid="stats-panel" style={{ width, maxWidth: '100%' }}>
        <StatStrip stats={stats} />
      </div>
    </main>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Fixture root is missing');
const root = createRoot(container);
function Fixture() {
  switch (query.get('scenario')) {
    case 'inspector':
      return <InspectorFixture state={query.get('state')} />;
    case 'permissions':
      return <PermissionsFixture />;
    case 'network':
      return <NetworkFixture state={query.get('state')} />;
    case 'stats':
      return <StatsFixture />;
    default:
      return <StorageFixture />;
  }
}
root.render(
  <ServicesContext.Provider value={services}>
    <Fixture />
  </ServicesContext.Provider>,
);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
