import { useEffect, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import type { LatLng } from '../../lib/location.ts';

/**
 * OpenStreetMap's own tiles: the only thing the dashboard loads from the internet, and only while a map is open.
 * The CSP allows this host for images (securityHeaders.ts); tiles carry a Referer (OSM's tile policy asks for one).
 */
export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';
const LEAFLET_PREFIX =
  '<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>';
const MAX_ZOOM = 19;
/** A point picked outside the map's view is shown at least this close. */
const FOCUS_ZOOM = 14;
const WORLD_ZOOM = 1;

type LeafletModule = typeof Leaflet;

/** Leaflet and its stylesheet, fetched the first time a map opens (they are not in the main bundle). */
function loadLeaflet(): Promise<LeafletModule> {
  return Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]).then(([module]) => module);
}

interface MapParts {
  L: LeafletModule;
  map: Leaflet.Map;
  draft: Leaflet.Marker;
  active: Leaflet.Marker;
}

function pin(L: LeafletModule, kind: 'draft' | 'active'): Leaflet.DivIcon {
  return L.divIcon({
    className: `loc-pin loc-pin--${kind}`,
    html: '<span class="loc-pin-head"></span>',
    iconSize: [22, 30],
    iconAnchor: [11, 29],
  });
}

function toLeaflet({ latitude, longitude }: LatLng): Leaflet.LatLngExpression {
  return [latitude, longitude];
}

function showMarker(parts: MapParts, marker: Leaflet.Marker, point: LatLng | null): void {
  if (point === null) {
    marker.remove();
    return;
  }
  marker.setLatLng(toLeaflet(point));
  if (!parts.map.hasLayer(marker)) marker.addTo(parts.map);
}

type Props = {
  /** The point that Set location would send (moved by a click or a drag on the map). */
  draft: LatLng | null;
  /** The location Lionscope put on the device. */
  active: LatLng | null;
  onPick: (point: LatLng) => void;
  /** Bumped when the draft comes from outside the map (typed, a saved place): the map centres on it. */
  focusSeq: number;
  label: string;
};

/** A slippy map: click or drag the pin to pick a point. Shows the device's set location as a second pin. */
export function LocationMap({ draft, active, onPick, focusSeq, label }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const partsRef = useRef<MapParts | null>(null);
  const onPickRef = useRef(onPick);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    onPickRef.current = onPick;
  });

  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    loadLeaflet().then(
      (L) => {
        const container = containerRef.current;
        if (cancelled || container === null) return;
        const map = L.map(container, { worldCopyJump: true, maxZoom: MAX_ZOOM });
        map.attributionControl.setPrefix(LEAFLET_PREFIX);
        L.tileLayer(OSM_TILE_URL, {
          maxZoom: MAX_ZOOM,
          attribution: ATTRIBUTION,
          referrerPolicy: 'strict-origin-when-cross-origin',
        }).addTo(map);
        const pick = (latlng: Leaflet.LatLng) => {
          const wrapped = latlng.wrap();
          onPickRef.current({ latitude: wrapped.lat, longitude: wrapped.lng });
        };
        const draftMarker = L.marker([0, 0], {
          icon: pin(L, 'draft'),
          draggable: true,
          keyboard: false,
          zIndexOffset: 1000,
        });
        draftMarker.on('dragend', () => pick(draftMarker.getLatLng()));
        const activeMarker = L.marker([0, 0], {
          icon: pin(L, 'active'),
          interactive: false,
          keyboard: false,
        });
        map.on('click', (event: Leaflet.LeafletMouseEvent) => pick(event.latlng));
        partsRef.current = { L, map, draft: draftMarker, active: activeMarker };
        observer = new ResizeObserver(() => map.invalidateSize());
        observer.observe(container);
        setStatus('ready');
      },
      () => !cancelled && setStatus('failed'),
    );
    return () => {
      cancelled = true;
      observer?.disconnect();
      partsRef.current?.map.remove();
      partsRef.current = null;
    };
  }, []);

  useEffect(() => {
    const parts = partsRef.current;
    if (status !== 'ready' || parts === null) return;
    showMarker(parts, parts.draft, draft);
    showMarker(parts, parts.active, active);
  }, [status, draft, active]);

  // Centred on the draft when it comes from outside the map (a click on the map never moves the map), and on the
  // first view; the whole world while there is no point at all.
  const focus = draft ?? active;
  const focusRef = useRef(focus);
  useEffect(() => {
    focusRef.current = focus;
  });
  useEffect(() => {
    const parts = partsRef.current;
    if (status !== 'ready' || parts === null) return;
    const point = focusRef.current;
    if (point === null) {
      parts.map.setView([20, 0], WORLD_ZOOM);
      return;
    }
    const zoom = focusSeq === 0 ? FOCUS_ZOOM : Math.max(parts.map.getZoom(), FOCUS_ZOOM);
    parts.map.setView([point.latitude, point.longitude], zoom);
  }, [status, focusSeq]);

  return (
    <div className="loc-map-frame" data-status={status}>
      <div
        ref={containerRef}
        className="loc-map"
        role="application"
        aria-label={`Map: click to put ${label} there`}
      />
      {status !== 'ready' && (
        <p className="loc-map-status" role="status">
          {status === 'loading' ? 'Loading the map…' : 'The map couldn’t load. Type coordinates below.'}
        </p>
      )}
    </div>
  );
}
