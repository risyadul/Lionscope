import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SdkStatus as SdkState, SessionState } from '@lionscope/protocol/wire';
import { SdkStatus } from '../src/components/topbar/SdkStatus.tsx';
import { SessionButton, StatusPill } from '../src/components/topbar/SessionControls.tsx';

const NOW = 1_700_000_000_000;
const PKG = 'com.example.shop';
const SDK: SdkState = {
  connected: true,
  sdkVersion: '0.3.0',
  processName: PKG,
  apiLevel: 34,
  framesActive: false,
};
const running = (pid: number | null, elapsedMs: number): SessionState => ({
  status: 'running',
  serial: 'emulator-5554',
  packageName: PKG,
  pid,
  startedAt: NOW - elapsedMs,
});

afterEach(() => cleanup());

// The top bar collapses these parts visually on narrow widths (CSS container queries); they must stay in
// the DOM, in the accessible text and in the tooltip, never be removed.
describe('top bar status pills', () => {
  it('keeps the PID in the live status text and the tooltip; the ticking time is visual only', () => {
    render(<StatusPill session={running(9048, 5_940_000)} now={NOW} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Recording PID 9048');
    const pill = status.closest('.status-pill') as HTMLElement;
    expect(pill.title).toBe('Recording · PID 9048');
    const elapsed = pill.querySelector('.status-elapsed') as HTMLElement;
    expect(elapsed.textContent).toBe('1 h 39 m');
    expect(elapsed.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the same pill nodes while the elapsed time ticks', () => {
    const { rerender } = render(<StatusPill session={running(9048, 5_000)} now={NOW} />);
    const pill = screen.getByRole('status').closest('.status-pill');
    const nodes = pill?.querySelectorAll('*').length;
    rerender(<StatusPill session={running(9048, 725_000)} now={NOW} />);
    expect(screen.getByRole('status').closest('.status-pill')).toBe(pill);
    expect(pill?.querySelectorAll('*').length).toBe(nodes);
    expect(pill?.querySelector('.status-elapsed')?.textContent).toBe('12 m 05 s');
  });

  it('puts every SDK detail in the tooltip and keeps them as text for screen readers', () => {
    const { rerender } = render(
      <SdkStatus sdk={{ ...SDK, framesActive: true }} linkError={null} isSessionActive />,
    );
    const pill = document.querySelector('.sdk-pill') as HTMLElement;
    expect(pill.textContent).toBe('SDK v0.3.0 connected frames from SDK');
    expect(pill.title).toBe(`SDK v0.3.0 · connected · frames from SDK · ${PKG} · API 34`);
    for (const part of ['.sdk-version', '.sdk-connected', '.sdk-frames']) {
      expect(pill.querySelector(part)).not.toBeNull();
    }

    // Frames idling: only the frames part goes, the pill itself stays the same element.
    rerender(<SdkStatus sdk={SDK} linkError={null} isSessionActive />);
    expect(document.querySelector('.sdk-pill')).toBe(pill);
    expect(pill.textContent).toBe('SDK v0.3.0 connected');
    expect(pill.title).toBe(`SDK v0.3.0 · connected · ${PKG} · API 34`);
  });

  it('names the version in the tooltip of a dropped link', () => {
    render(<SdkStatus sdk={{ ...SDK, connected: false }} linkError={null} isSessionActive />);
    const pill = document.querySelector('.sdk-pill') as HTMLElement;
    expect(pill.textContent).toBe('SDK v0.3.0 disconnected');
    expect(pill.title).toMatch(/^SDK v0\.3\.0 · disconnected\. /);
  });

  it('keeps the session button named by its label when it shrinks to the icon', () => {
    const noop = () => {};
    const { rerender } = render(
      <SessionButton
        isActive
        canStart
        startHint={null}
        isPending={false}
        isOffline={false}
        onStart={noop}
        onStop={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    rerender(
      <SessionButton
        isActive
        canStart
        startHint={null}
        isPending
        isOffline={false}
        onStart={noop}
        onStop={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeTruthy();
  });
});
