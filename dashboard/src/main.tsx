import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './styles/tokens.css';
import './styles/base.css';
import { App } from './App.tsx';
import { ErrorBoundary } from './app/ErrorBoundary.tsx';
import { ServicesContext, type DashboardServices } from './app/services.ts';
import { createConnection, wsUrl } from './lib/connection.ts';
import { createSignal } from './lib/signal.ts';
import { createStore } from './lib/store.ts';

const store = createStore();
const connection = createConnection({
  url: wsUrl(window.location),
  onMessage: (msg) => store.dispatch({ kind: 'server', msg }),
  onStatus: (state) => store.dispatch({ kind: 'connection', connection: state }),
});

const services: DashboardServices = {
  store,
  send: connection.send,
  probeTs: createSignal<number | null>(null),
  cursorX: createSignal<number | null>(null),
};

// Close on the way into the back-forward cache (an open socket blocks it, and a restored page
// must not show a stale "Connected"); reconnect when the page is restored.
window.addEventListener('pagehide', () => connection.close());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) connection.reconnect();
});

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <ServicesContext.Provider value={services}>
        <App />
      </ServicesContext.Provider>
    </ErrorBoundary>
  </StrictMode>,
);
