import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, DeviceLocation, ServerMessage } from '@lionscope/protocol/wire';
import { DevicePanel } from '../src/components/device/DevicePanel.tsx';
import { LocationContext } from '../src/components/location/LocationContext.tsx';
import { useDeviceLocations, type LocationsController } from '../src/hooks/useDeviceLocations.ts';
import {
  addSavedPlace,
  formatLatLng,
  parseLocationInput,
  parseSavedPlaces,
  removeSavedPlace,
  serializeSavedPlaces,
} from '../src/lib/location.ts';
import { applyServerMessage, createInitialState, type ServerError } from '../src/lib/store.ts';
import { emulator, FakeScreenSocket, installCanvasStubs, installWebCodecs } from './screenFakes.ts';

// The map needs a real layout engine: a stub picks a point when its button is pressed.
vi.mock('../src/components/location/LocationMap.tsx', () => ({
  LocationMap: ({
    onPick,
    draft,
  }: {
    onPick: (p: { latitude: number; longitude: number }) => void;
    draft: unknown;
  }) => (
    <div data-testid="map" data-draft={JSON.stringify(draft)}>
      <button type="button" onClick={() => onPick({ latitude: -7.2575, longitude: 112.7521 })}>
        Pick on map
      </button>
    </div>
  ),
}));

const SERIAL = 'emulator-5554';
const SET: DeviceLocation = {
  serial: SERIAL,
  latitude: -6.1754,
  longitude: 106.8272,
  method: 'emulator',
  since: Date.UTC(2026, 9, 26, 8, 0),
  warning: null,
};

describe('parseLocationInput', () => {
  it.each([
    ['-6.1754, 106.8272', -6.1754, 106.8272],
    ['  -6.1754 106.8272 ', -6.1754, 106.8272],
    ['-6.1754;106.8272', -6.1754, 106.8272],
    ['https://www.google.com/maps/@-6.1753924,106.8271528,17z', -6.175392, 106.827153],
    [
      'https://www.google.com/maps/place/Monas/@-6.17,106.82,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-6.1753924!4d106.8271528',
      -6.175392,
      106.827153,
    ],
    ['https://maps.google.com/?q=-6.2,106.8', -6.2, 106.8],
    ['https://www.google.com/maps/search/?api=1&query=-6.2%2C106.8', -6.2, 106.8],
    ['geo:-6.2,106.8?z=12', -6.2, 106.8],
    ['https://www.openstreetmap.org/#map=15/-6.2/106.8', -6.2, 106.8],
  ])('reads %s', (text, latitude, longitude) => {
    expect(parseLocationInput(text)).toEqual({ ok: true, point: { latitude, longitude } });
  });

  it('explains what it cannot read', () => {
    expect(parseLocationInput('')).toMatchObject({ ok: false, error: expect.stringContaining('Enter') });
    expect(parseLocationInput('91, 0')).toMatchObject({
      ok: false,
      error: expect.stringContaining('-90 to 90'),
    });
    expect(parseLocationInput('https://maps.app.goo.gl/abc123')).toMatchObject({
      ok: false,
      error: expect.stringContaining('Short links'),
    });
    expect(parseLocationInput('Monas, Jakarta')).toMatchObject({ ok: false });
  });

  it('formats with 6 decimals at most, without -0', () => {
    expect(formatLatLng({ latitude: -0.0000001, longitude: 106.82715284 })).toBe('0, 106.827153');
  });
});

describe('saved places', () => {
  it('adds new places first, replaces one with the same name, and drops malformed stored ones', () => {
    let places = addSavedPlace([], { name: ' Office ', latitude: 1, longitude: 2 });
    places = addSavedPlace(places, { name: 'Home', latitude: 3, longitude: 4 });
    places = addSavedPlace(places, { name: 'Office', latitude: 5, longitude: 6 });
    expect(places).toEqual([
      { name: 'Office', latitude: 5, longitude: 6 },
      { name: 'Home', latitude: 3, longitude: 4 },
    ]);
    expect(parseSavedPlaces(serializeSavedPlaces(places))).toEqual(places);
    expect(removeSavedPlace(places, 'Office')).toEqual([{ name: 'Home', latitude: 3, longitude: 4 }]);
    expect(
      parseSavedPlaces(
        '[{"name":"x","latitude":95,"longitude":0},{"name":"ok","latitude":1,"longitude":1},3]',
      ),
    ).toEqual([{ name: 'ok', latitude: 1, longitude: 1 }]);
    expect(parseSavedPlaces('not json')).toEqual([]);
  });
});

describe('store', () => {
  it('keeps the locations and the last refused change', () => {
    let state = createInitialState();
    expect(state.locations).toBeNull();
    state = applyServerMessage(state, { type: 'locations', locations: [SET] });
    expect(state.locations).toEqual([SET]);
    const refused: ServerMessage = { type: 'error', code: 'setLocation_failed', message: 'needs Android 12' };
    state = applyServerMessage(state, refused);
    expect(state.locationError).toMatchObject({ message: 'needs Android 12' });
    expect(state.lastError).toMatchObject({ message: 'needs Android 12' });
    state = applyServerMessage(state, { type: 'error', code: 'inspect_failed', message: 'other' });
    expect(state.locationError).toMatchObject({ message: 'needs Android 12' });
  });
});

describe('useDeviceLocations', () => {
  it('is pending until the server answers with new locations or an error', () => {
    const sent: ClientMessage[] = [];
    const send = (msg: ClientMessage) => {
      sent.push(msg);
      return true;
    };
    const { result, rerender } = renderHook(
      (props: { locations: DeviceLocation[] | null; locationError: ServerError | null }) =>
        useDeviceLocations({ send, isOpen: true, ...props }),
      {
        initialProps: { locations: [], locationError: null } as {
          locations: DeviceLocation[] | null;
          locationError: ServerError | null;
        },
      },
    );
    expect(result.current.blocker).toBeNull();
    act(() => result.current.set(SERIAL, { latitude: 1, longitude: 2 }));
    expect(sent).toEqual([{ type: 'setLocation', serial: SERIAL, latitude: 1, longitude: 2 }]);
    expect(result.current.pendingSerial).toBe(SERIAL);
    rerender({ locations: [SET], locationError: null });
    expect(result.current.pendingSerial).toBeNull();

    act(() => result.current.clear(SERIAL));
    expect(result.current.pendingSerial).toBe(SERIAL);
    rerender({
      locations: [SET],
      locationError: { id: 1, message: 'refused', code: 'clearLocation_failed' },
    });
    expect(result.current.pendingSerial).toBeNull();
    expect(result.current.error).toBe('refused');
    // A new request hides the old refusal.
    act(() => result.current.set(SERIAL, { latitude: 1, longitude: 2 }));
    expect(result.current.error).toBeNull();
  });

  it('says why nothing can change offline or with an older server', () => {
    const send = () => true;
    expect(
      renderHook(() => useDeviceLocations({ send, isOpen: false, locations: [], locationError: null })).result
        .current.blocker,
    ).toContain('Offline');
    expect(
      renderHook(() => useDeviceLocations({ send, isOpen: true, locations: null, locationError: null }))
        .result.current.blocker,
    ).toContain('0.10.0');
  });
});

describe('Location panel in the device column', () => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    FakeScreenSocket.reset();
    vi.stubGlobal('WebSocket', FakeScreenSocket);
    installCanvasStubs();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function controller(overrides: Partial<LocationsController> = {}): LocationsController {
    return {
      locations: [],
      blocker: null,
      pendingSerial: null,
      error: null,
      set: vi.fn(),
      clear: vi.fn(),
      ...overrides,
    };
  }

  function renderPanel(value: LocationsController) {
    return render(
      <LocationContext.Provider value={value}>
        <DevicePanel
          target={{ serial: SERIAL, emulator: emulator({ serial: SERIAL }) }}
          isOnline
          isVisible
          pending={null}
          onBoot={() => {}}
        />
      </LocationContext.Provider>,
    );
  }

  it('opens from the toolbar, sets a typed point, a map pick or a saved place, and closes on Escape', () => {
    const value = controller();
    renderPanel(value);
    const toggle = screen.getByRole('button', { name: 'Location' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const dialog = screen.getByRole('dialog', { name: 'Location' });
    const input = screen.getByLabelText('Coordinates or a Google Maps link');
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'nowhere' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set location' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/No coordinates found/);
    expect(value.set).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'https://www.google.com/maps/@-6.1754,106.8272,17z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set location' }));
    expect(value.set).toHaveBeenLastCalledWith(SERIAL, { latitude: -6.1754, longitude: 106.8272 });
    expect((input as HTMLInputElement).value).toBe('-6.1754, 106.8272');

    fireEvent.click(screen.getByRole('button', { name: 'Pick on map' }));
    expect((input as HTMLInputElement).value).toBe('-7.2575, 112.7521');
    fireEvent.click(screen.getByRole('button', { name: 'Save this point' }));
    const name = screen.getByLabelText('Place name');
    fireEvent.change(name, { target: { value: 'Surabaya' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(JSON.parse(window.localStorage.getItem('lionscope.location.places') ?? '[]')).toEqual([
      { name: 'Surabaya', latitude: -7.2575, longitude: 112.7521 },
    ]);

    fireEvent.change(input, { target: { value: '1, 2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Surabaya/ }));
    expect((input as HTMLInputElement).value).toBe('-7.2575, 112.7521');

    expect(toggle.getAttribute('aria-controls')).toBe(dialog.id);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it('shows the set location with Reset, the warning and the refusal, and marks the toolbar button', () => {
    const value = controller({
      locations: [{ ...SET, method: 'mock_provider', warning: 'Location is off on the device' }],
      error: 'The device refused mock locations',
    });
    renderPanel(value);
    const toggle = screen.getByRole('button', { name: 'Location' });
    expect(toggle.className).toContain('is-set');
    fireEvent.click(toggle);
    expect((screen.getByLabelText('Coordinates or a Google Maps link') as HTMLInputElement).value).toBe(
      '-6.1754, 106.8272',
    );
    expect(screen.getByRole('button', { name: 'Set again' })).toBeTruthy();
    expect(screen.getByText(/apps see Location.isMock/)).toBeTruthy();
    expect(screen.getByText('Location is off on the device')).toBeTruthy();
    expect(screen.getByText('The device refused mock locations')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(value.clear).toHaveBeenCalledWith(SERIAL);
  });

  it('disables changes while one is on its way or the server cannot change locations', () => {
    renderPanel(controller({ locations: [SET], pendingSerial: SERIAL }));
    fireEvent.click(screen.getByRole('button', { name: 'Location' }));
    expect(screen.getByRole('button', { name: 'Setting…' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Reset' }).hasAttribute('disabled')).toBe(true);
    cleanup();

    renderPanel(controller({ locations: null, blocker: 'This Lionscope server can’t change locations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Location' }));
    expect(screen.getByText('This Lionscope server can’t change locations')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Coordinates or a Google Maps link'), {
      target: { value: '1, 2' },
    });
    expect(screen.getByRole('button', { name: 'Set location' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('Location panel on a phone another server holds', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    FakeScreenSocket.reset();
    vi.stubGlobal('WebSocket', FakeScreenSocket);
    installCanvasStubs();
    installWebCodecs();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('offers Reset next to the refusal', () => {
    const clear = vi.fn();
    render(
      <LocationContext.Provider
        value={{
          locations: [],
          blocker: null,
          pendingSerial: null,
          error: 'Another Lionscope server (pid 99) is changing the location of R58M123ABC',
          set: vi.fn(),
          clear,
        }}
      >
        <DevicePanel
          target={{ serial: 'R58M123ABC', emulator: null }}
          device={{ serial: 'R58M123ABC', state: 'device' }}
          isOnline
          isVisible
          pending={null}
          onBoot={() => {}}
        />
      </LocationContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Location' }));
    expect(screen.getByText(/Mock location|Real location/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset the device’s location' }));
    expect(clear).toHaveBeenCalledWith('R58M123ABC');
  });
});
