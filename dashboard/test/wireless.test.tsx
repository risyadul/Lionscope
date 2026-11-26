// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, DeviceInfo, WirelessActionResult } from '@lionscope/protocol/wire';
import { DevicePicker } from '../src/components/topbar/DevicePicker.tsx';
import { WirelessDialog } from '../src/components/topbar/WirelessDialog.tsx';
import { useWirelessActions, WIRELESS_ACTION_TIMEOUTS_MS } from '../src/hooks/useWirelessActions.ts';
import { createInitialState, reduce, type WirelessAnswer } from '../src/lib/store.ts';

afterEach(cleanup);

describe('DevicePicker wireless badges & disconnect', () => {
  const usbDevice: DeviceInfo = {
    serial: 'R58M123ABC',
    state: 'device',
    model: 'Pixel_7',
    transport: 'usb',
  };
  const wifiDevice: DeviceInfo = {
    serial: '192.168.1.42:5555',
    state: 'device',
    model: 'Pixel_7',
    transport: 'wireless',
  };

  it('shows USB badge for USB devices and Wi-Fi badge + Disconnect button for wireless devices', () => {
    const onDisconnect = vi.fn();
    const onOpenWireless = vi.fn();
    const { rerender } = render(
      <DevicePicker
        devices={[usbDevice, wifiDevice]}
        emulators={[]}
        value={usbDevice.serial}
        emulator={null}
        onChange={vi.fn()}
        onAvdChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenWireless={onOpenWireless}
        onDisconnectWireless={onDisconnect}
        isLocked={false}
        isOffline={false}
      />,
    );

    expect(screen.getByText('USB')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect wireless device' }));
    expect(onOpenWireless).toHaveBeenCalledTimes(1);

    rerender(
      <DevicePicker
        devices={[usbDevice, wifiDevice]}
        emulators={[]}
        value={wifiDevice.serial}
        emulator={null}
        onChange={vi.fn()}
        onAvdChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenWireless={onOpenWireless}
        onDisconnectWireless={onDisconnect}
        isLocked={false}
        isOffline={false}
      />,
    );

    expect(screen.getByText('Wi-Fi')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith('192.168.1.42:5555');
  });

  it('asks for confirmation before disconnecting when a profiling session is active', () => {
    const onDisconnect = vi.fn();
    render(
      <DevicePicker
        devices={[wifiDevice]}
        emulators={[]}
        value={wifiDevice.serial}
        emulator={null}
        onChange={vi.fn()}
        onAvdChange={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnectWireless={onDisconnect}
        isLocked={true}
        isOffline={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Disconnect' });
    fireEvent.click(buttons.at(-1)!);
    expect(onDisconnect).toHaveBeenCalledWith('192.168.1.42:5555');
  });

  it('asks for confirmation explaining port 5555 stays open until reboot before USB to Wi-Fi handoff', () => {
    const onSwitchToWifi = vi.fn();
    render(
      <DevicePicker
        devices={[usbDevice]}
        emulators={[]}
        value={usbDevice.serial}
        emulator={null}
        onChange={vi.fn()}
        onAvdChange={vi.fn()}
        onRefresh={vi.fn()}
        onSwitchToWifi={onSwitchToWifi}
        isLocked={false}
        isOffline={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use Wi-Fi' }));
    expect(onSwitchToWifi).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toMatch(/5555 stays open.*until.*reboot/i);
    fireEvent.click(screen.getByRole('button', { name: 'Enable Wi-Fi ADB' }));
    expect(onSwitchToWifi).toHaveBeenCalledWith('R58M123ABC');
  });

  it('shows USB badge and Use Wi-Fi for a ready USB device even when libusb adb omits transport', () => {
    const libusbDevice: DeviceInfo = { serial: 'LIBUSB999', state: 'device', model: 'Pixel_8' };
    render(
      <DevicePicker
        devices={[libusbDevice]}
        emulators={[]}
        value={libusbDevice.serial}
        emulator={null}
        onChange={vi.fn()}
        onAvdChange={vi.fn()}
        onRefresh={vi.fn()}
        onSwitchToWifi={vi.fn()}
        isLocked={false}
        isOffline={false}
      />,
    );

    expect(screen.getByText('USB')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use Wi-Fi' })).toBeTruthy();
  });

  it('pins USB handoff and disconnect confirmations to the captured serial and dismisses if it disappears', () => {
    const usbA: DeviceInfo = { serial: 'USB_A', state: 'device', model: 'Pixel_A', transport: 'usb' };
    const usbB: DeviceInfo = { serial: 'USB_B', state: 'device', model: 'Pixel_B', transport: 'usb' };
    const onSwitchToWifi = vi.fn();
    const { rerender } = render(
      <DevicePicker
        devices={[usbA, usbB]}
        emulators={[]}
        value={usbA.serial}
        emulator={null}
        onChange={vi.fn()}
        onAvdChange={vi.fn()}
        onRefresh={vi.fn()}
        onSwitchToWifi={onSwitchToWifi}
        isLocked={false}
        isOffline={false}
      />,
    );

    // Open confirmation on USB_A, then change selection to USB_B before confirming.
    fireEvent.click(screen.getByRole('button', { name: 'Use Wi-Fi' }));
    rerender(
      <DevicePicker
        devices={[usbA, usbB]}
        emulators={[]}
        value={usbB.serial}
        emulator={null}
        onChange={vi.fn()}
        onAvdChange={vi.fn()}
        onRefresh={vi.fn()}
        onSwitchToWifi={onSwitchToWifi}
        isLocked={false}
        isOffline={false}
      />,
    );
    expect(screen.getByRole('alertdialog').textContent).toContain('Pixel A');
    fireEvent.click(screen.getByRole('button', { name: 'Enable Wi-Fi ADB' }));
    expect(onSwitchToWifi).toHaveBeenCalledWith('USB_A');

    // Open confirmation on USB_B, then remove USB_B: dialog dismisses and does not reappear if USB_B returns.
    fireEvent.click(screen.getByRole('button', { name: 'Use Wi-Fi' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    rerender(
      <DevicePicker
        devices={[usbA]}
        emulators={[]}
        value={usbA.serial}
        emulator={null}
        onChange={vi.fn()}
        onAvdChange={vi.fn()}
        onRefresh={vi.fn()}
        onSwitchToWifi={onSwitchToWifi}
        isLocked={false}
        isOffline={false}
      />,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    rerender(
      <DevicePicker
        devices={[usbA, usbB]}
        emulators={[]}
        value={usbB.serial}
        emulator={null}
        onChange={vi.fn()}
        onAvdChange={vi.fn()}
        onRefresh={vi.fn()}
        onSwitchToWifi={onSwitchToWifi}
        isLocked={false}
        isOffline={false}
      />,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // Same pinning guarantee for wireless Disconnect confirmation.
    const wifiA: DeviceInfo = {
      serial: '192.168.1.10:5555',
      state: 'device',
      model: 'Phone_A',
      transport: 'wireless',
    };
    const wifiB: DeviceInfo = {
      serial: '192.168.1.20:5555',
      state: 'device',
      model: 'Phone_B',
      transport: 'wireless',
    };
    const onDisconnect = vi.fn();
    rerender(
      <DevicePicker
        devices={[wifiA, wifiB]}
        emulators={[]}
        value={wifiA.serial}
        emulator={null}
        onChange={vi.fn()}
        onAvdChange={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnectWireless={onDisconnect}
        isLocked={true}
        isOffline={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    rerender(
      <DevicePicker
        devices={[wifiA, wifiB]}
        emulators={[]}
        value={wifiB.serial}
        emulator={null}
        onChange={vi.fn()}
        onAvdChange={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnectWireless={onDisconnect}
        isLocked={true}
        isOffline={false}
      />,
    );
    expect(screen.getByRole('alertdialog').textContent).toContain('192.168.1.10:5555');
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' }).at(-1)!);
    expect(onDisconnect).toHaveBeenCalledWith('192.168.1.10:5555');
  });

  it('shows exact serial, public IP and port confirmation for public-IP USB handoff and confirms bound values', () => {
    const onConfirmPublic = vi.fn();
    const onCancelPublic = vi.fn();
    render(
      <DevicePicker
        devices={[usbDevice]}
        emulators={[]}
        value={usbDevice.serial}
        emulator={null}
        onChange={vi.fn()}
        onAvdChange={vi.fn()}
        onRefresh={vi.fn()}
        onSwitchToWifi={vi.fn()}
        pendingPublicTcpip={{
          confirmationId: '0123456789abcdef',
          usbSerial: 'R58M123ABC',
          host: '192.0.2.15',
          port: 5555,
          target: '192.0.2.15:5555',
        }}
        onConfirmPublicTcpip={onConfirmPublic}
        onCancelPublicTcpip={onCancelPublic}
        isLocked={false}
        isOffline={false}
      />,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('R58M123ABC');
    expect(dialog.textContent).toContain('192.0.2.15');
    expect(dialog.textContent).toContain('5555');
    fireEvent.click(screen.getByRole('button', { name: 'Enable on 192.0.2.15:5555' }));
    expect(onConfirmPublic).toHaveBeenCalledWith('R58M123ABC', 5555, '0123456789abcdef', '192.0.2.15:5555');
  });
});

describe('WirelessDialog', () => {
  const noopPair = vi.fn(async () => ({
    action: 'pair' as const,
    ok: true as const,
    target: '192.168.1.42:37123',
    host: '192.168.1.42',
    connectedSerial: '192.168.1.42:41234',
  }));

  it('validates input, warns on public IPs, and connects cleanly', async () => {
    const onConnect = vi.fn(async (address: string) => ({
      action: 'connect' as const,
      ok: true as const,
      serial: address,
      target: address,
      alreadyConnected: false,
    }));
    const onConnected = vi.fn();
    const onClose = vi.fn();

    render(
      <WirelessDialog
        isOnline={true}
        onConnect={onConnect}
        onPair={noopPair}
        onConnected={onConnected}
        onClose={onClose}
      />,
    );

    const input = screen.getByLabelText('IP address and port');
    const submit = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // Invalid syntax shows alert and keeps submit disabled.
    fireEvent.change(input, { target: { value: '-192.168.1.5:5555' } });
    expect(screen.getByRole('alert').textContent).toMatch(/must not start with -/i);
    expect(submit.disabled).toBe(true);

    // Public IP shows warning but still allows user to connect.
    fireEvent.change(input, { target: { value: '8.8.8.8:5555' } });
    expect(screen.getByText(/Public IP address\./i)).toBeTruthy();
    expect(submit.disabled).toBe(false);

    // Private IP hides warning and submits.
    fireEvent.change(input, { target: { value: '192.168.1.42:5555' } });
    expect(screen.queryByText(/Public IP address\./i)).toBeNull();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith('192.168.1.42:5555');
      expect(onConnected).toHaveBeenCalledWith('192.168.1.42:5555');
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('displays server errors inline without closing', async () => {
    const onConnect = vi.fn(async () => ({
      action: 'connect' as const,
      ok: false as const,
      message: 'cannot connect to 192.168.1.42:5555: Connection refused',
    }));
    const onClose = vi.fn();

    render(
      <WirelessDialog
        isOnline={true}
        onConnect={onConnect}
        onPair={noopPair}
        onConnected={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByLabelText('IP address and port'), {
      target: { value: '192.168.1.42:5555' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Connection refused/);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('pairs with a 6-digit code, clears the code immediately, and falls back to Connect tab when connect port is separate', async () => {
    const onPair = vi.fn(async () => ({
      action: 'pair' as const,
      ok: true as const,
      target: '192.168.1.42:37123',
      host: '192.168.1.42',
      connectedSerial: null,
      connectNote: 'Paired successfully. Enter the separate connect port.',
    }));
    const onClose = vi.fn();

    render(
      <WirelessDialog
        isOnline={true}
        onConnect={vi.fn()}
        onPair={onPair}
        onConnected={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Pair with code' }));
    const pairAddr = screen.getByLabelText('Pairing IP address and port');
    const codeInput = screen.getByLabelText('6-digit pairing code') as HTMLInputElement;
    const submit = screen.getByRole('button', { name: 'Pair & connect' }) as HTMLButtonElement;

    fireEvent.change(pairAddr, { target: { value: '192.168.1.42:37123' } });
    fireEvent.change(codeInput, { target: { value: '12345' } });
    expect(screen.getByRole('alert').textContent).toMatch(/6 digits/i);
    expect(submit.disabled).toBe(true);

    fireEvent.change(codeInput, { target: { value: '482910' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(onPair).toHaveBeenCalledWith('192.168.1.42:37123', '482910', undefined);
      expect((screen.getByLabelText('IP address and port') as HTMLInputElement).value).toBe('192.168.1.42:');
    });
    expect(screen.getByText(/Paired successfully/i)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('lists discovered mDNS devices for one-click connect and renders QR pairing SVG', async () => {
    const onConnect = vi.fn(async (address: string) => ({
      action: 'connect' as const,
      ok: true as const,
      serial: address,
      target: address,
      alreadyConnected: false,
    }));
    const onListMdns = vi.fn(async () => ({
      action: 'mdns' as const,
      ok: true as const,
      services: [
        {
          instanceName: 'adb-PIXEL8-abc',
          host: '192.168.1.50',
          port: 42000,
          target: '192.168.1.50:42000',
          serial: 'adb-PIXEL8-abc._adb-tls-connect._tcp',
          connected: false,
        },
      ],
    }));
    const onStartQrPairing = vi.fn(async () => ({
      action: 'startQr' as const,
      ok: true as const,
      sessionId: '0123456789abcdef',
      payload: 'WIFI:T:ADB;S:ADB_WIFI_aabbccddeeff;P:TestPass12345678;;',
      serviceName: 'ADB_WIFI_aabbccddeeff',
      expiresAt: Date.now() + 120_000,
    }));
    const onCancelQrPairing = vi.fn();
    const onConnected = vi.fn();
    const onClose = vi.fn();

    render(
      <WirelessDialog
        isOnline={true}
        onConnect={onConnect}
        onPair={noopPair}
        onListMdns={onListMdns}
        onStartQrPairing={onStartQrPairing}
        onCancelQrPairing={onCancelQrPairing}
        onConnected={onConnected}
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('adb-PIXEL8-abc')).toBeTruthy();
      expect(screen.getByText('192.168.1.50:42000')).toBeTruthy();
    });

    // Switch to QR tab and verify SVG QR code is rendered.
    fireEvent.click(screen.getByRole('tab', { name: 'Pair with QR' }));
    await waitFor(() => {
      expect(onStartQrPairing).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('img', { name: 'Android wireless debugging pairing QR code' })).toBeTruthy();
    });

    // Switching back cancels the active QR session.
    fireEvent.click(screen.getByRole('tab', { name: 'Connect' }));
    expect(onCancelQrPairing).toHaveBeenCalledWith('0123456789abcdef');

    // One-click connect on the discovered mDNS device.
    await waitFor(() => {
      expect(screen.getByText('adb-PIXEL8-abc')).toBeTruthy();
    });
    const connectButtons = screen.getAllByRole('button', { name: 'Connect' });
    fireEvent.click(connectButtons.at(-1)!);
    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith('192.168.1.50:42000');
      expect(onConnected).toHaveBeenCalledWith('192.168.1.50:42000');
    });
  });

  it('does not cancel QR pairing or steal focus when parent re-renders with a new onClose callback', async () => {
    const onStartQrPairing = vi.fn(async () => ({
      action: 'startQr' as const,
      ok: true as const,
      sessionId: 'fedcba9876543210',
      payload: 'WIFI:T:ADB;S:ADB_WIFI_112233445566;P:SecretPass999999;;',
      serviceName: 'ADB_WIFI_112233445566',
      expiresAt: Date.now() + 120_000,
    }));
    const onCancelQrPairing = vi.fn();

    const { rerender, unmount } = render(
      <WirelessDialog
        isOnline={true}
        onConnect={vi.fn()}
        onPair={noopPair}
        onStartQrPairing={onStartQrPairing}
        onCancelQrPairing={onCancelQrPairing}
        onConnected={vi.fn()}
        onClose={() => undefined}
      />,
    );

    // Focus pairing code input and rerender with new inline onClose (simulating a clock tick).
    fireEvent.click(screen.getByRole('tab', { name: 'Pair with code' }));
    const codeInput = screen.getByLabelText('6-digit pairing code');
    codeInput.focus();
    expect(document.activeElement).toBe(codeInput);

    rerender(
      <WirelessDialog
        isOnline={true}
        onConnect={vi.fn()}
        onPair={noopPair}
        onStartQrPairing={onStartQrPairing}
        onCancelQrPairing={onCancelQrPairing}
        onConnected={vi.fn()}
        onClose={() => undefined}
      />,
    );
    expect(document.activeElement).toBe(codeInput);

    // Start QR pairing and rerender multiple times with new inline callbacks: must NEVER cancel QR.
    fireEvent.click(screen.getByRole('tab', { name: 'Pair with QR' }));
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Android wireless debugging pairing QR code' })).toBeTruthy();
    });
    for (let i = 0; i < 3; i += 1) {
      rerender(
        <WirelessDialog
          isOnline={true}
          onConnect={vi.fn()}
          onPair={noopPair}
          onStartQrPairing={onStartQrPairing}
          onCancelQrPairing={onCancelQrPairing}
          onConnected={vi.fn()}
          onClose={() => undefined}
        />,
      );
    }
    expect(onCancelQrPairing).not.toHaveBeenCalled();

    // Only real unmount cancels the active QR session.
    unmount();
    expect(onCancelQrPairing).toHaveBeenCalledTimes(1);
    expect(onCancelQrPairing).toHaveBeenCalledWith('fedcba9876543210');
  });

  it('warns before connecting to a public IP from mDNS discovery and rejects legacy numeric IPv4 spellings', async () => {
    const onConnect = vi.fn(async (address: string) => ({
      action: 'connect' as const,
      ok: true as const,
      serial: address,
      target: address,
      alreadyConnected: false,
    }));
    const onListMdns = vi.fn(async () => ({
      action: 'mdns' as const,
      ok: true as const,
      services: [
        {
          instanceName: 'adb-PUBLIC-xyz',
          host: '8.8.8.8',
          port: 41234,
          target: '8.8.8.8:41234',
          serial: 'adb-PUBLIC-xyz._adb-tls-connect._tcp',
          connected: false,
        },
      ],
    }));

    const onClose = vi.fn();
    render(
      <WirelessDialog
        isOnline={true}
        onConnect={onConnect}
        onPair={noopPair}
        onListMdns={onListMdns}
        onConnected={vi.fn()}
        onClose={onClose}
      />,
    );

    // Legacy numeric IPv4 forms are rejected with a clear validation error.
    const input = screen.getByLabelText('IP address and port');
    fireEvent.change(input, { target: { value: '0x7f.1:5555' } });
    expect(screen.getByRole('alert').textContent).toMatch(/dotted-decimal IPv4/i);
    fireEvent.change(input, { target: { value: '3232235777:5555' } });
    expect(screen.getByRole('alert').textContent).toMatch(/dotted-decimal IPv4/i);

    // Public IP in discovery list requires explicit warning confirmation before calling onConnect,
    // moves keyboard focus to Cancel, dismisses only the confirmation on Escape, and restores focus to the row.
    await waitFor(() => {
      expect(screen.getByText('adb-PUBLIC-xyz')).toBeTruthy();
      expect(screen.getByText('Public IP')).toBeTruthy();
    });
    const rowConnectBtn = screen.getAllByRole('button', { name: 'Connect' }).at(-1)!;
    rowConnectBtn.focus();
    fireEvent.click(rowConnectBtn);
    expect(onConnect).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'Confirm public IP connection' }).textContent).toContain(
      '8.8.8.8:41234',
    );
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancelBtn);

    // Pressing Escape dismisses ONLY the confirmation (keeps WirelessDialog open) and restores focus to the row.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog', { name: 'Confirm public IP connection' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.activeElement).toBe(rowConnectBtn);
    });

    // Reopen and confirm "Connect anyway".
    fireEvent.click(rowConnectBtn);
    fireEvent.click(screen.getByRole('button', { name: 'Connect anyway' }));
    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith('8.8.8.8:41234');
    });
  });

  it('cancels an in-flight startQrPairing when the dialog is dismissed before it resolves and clears QR on disconnect', async () => {
    let resolveQr!: (value: Extract<WirelessActionResult, { action: 'startQr' }>) => void;
    const onStartQrPairing = vi.fn(
      () =>
        new Promise<Extract<WirelessActionResult, { action: 'startQr' }>>((resolve) => {
          resolveQr = resolve;
        }),
    );
    const onCancelQrPairing = vi.fn();

    const first = render(
      <WirelessDialog
        isOnline={true}
        onConnect={vi.fn()}
        onPair={noopPair}
        onStartQrPairing={onStartQrPairing}
        onCancelQrPairing={onCancelQrPairing}
        onConnected={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Pair with QR' }));
    expect(onStartQrPairing).toHaveBeenCalledTimes(1);

    // Dismiss dialog BEFORE startQrPairing resolves.
    first.unmount();
    expect(onCancelQrPairing).not.toHaveBeenCalled();

    // Late startQr resolution must immediately cancel the orphaned server session.
    await act(async () => {
      resolveQr({
        action: 'startQr',
        ok: true,
        sessionId: 'orphaned12345678',
        payload: 'WIFI:T:ADB;S:ADB_WIFI_deadbeef0000;P:OrphanSecret1234;;',
        serviceName: 'ADB_WIFI_deadbeef0000',
        expiresAt: Date.now() + 120_000,
      });
    });
    expect(onCancelQrPairing).toHaveBeenCalledWith('orphaned12345678');

    // Socket disconnect + reconnect clears obsolete QR image and "waiting" status.
    const onStartImmediate = vi.fn(async () => ({
      action: 'startQr' as const,
      ok: true as const,
      sessionId: 'conn111122223333',
      payload: 'WIFI:T:ADB;S:ADB_WIFI_111122223333;P:SocketDropPass12;;',
      serviceName: 'ADB_WIFI_111122223333',
      expiresAt: Date.now() + 120_000,
    }));
    const second = render(
      <WirelessDialog
        isOnline={true}
        onConnect={vi.fn()}
        onPair={noopPair}
        onStartQrPairing={onStartImmediate}
        onCancelQrPairing={vi.fn()}
        onConnected={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Pair with QR' }));
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Android wireless debugging pairing QR code' })).toBeTruthy();
    });

    // Disconnect clears QR image immediately.
    second.rerender(
      <WirelessDialog
        isOnline={false}
        onConnect={vi.fn()}
        onPair={noopPair}
        onStartQrPairing={onStartImmediate}
        onCancelQrPairing={vi.fn()}
        onConnected={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('img', { name: 'Android wireless debugging pairing QR code' })).toBeNull();

    // Reconnect does NOT resurrect the dead QR image or "Waiting for your phone..." text.
    second.rerender(
      <WirelessDialog
        isOnline={true}
        onConnect={vi.fn()}
        onPair={noopPair}
        onStartQrPairing={onStartImmediate}
        onCancelQrPairing={vi.fn()}
        onConnected={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('img', { name: 'Android wireless debugging pairing QR code' })).toBeNull();
    expect(screen.queryByText(/Waiting for your phone/i)).toBeNull();
    expect(screen.getByText(/connection reset/i)).toBeTruthy();
  });

  it('ignores late results belonging to an earlier dialog instance delivered after mount so a newer dialog is never closed', () => {
    const onConnected = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <WirelessDialog
        dialogInstanceId={2}
        isOnline={true}
        onConnect={vi.fn()}
        onPair={noopPair}
        lateResult={null}
        onConnected={onConnected}
        onClose={onClose}
      />,
    );
    rerender(
      <WirelessDialog
        dialogInstanceId={2}
        isOnline={true}
        onConnect={vi.fn()}
        onPair={noopPair}
        lateResult={{
          requestId: 1,
          dialogInstanceId: 1,
          result: {
            action: 'connect',
            ok: true,
            serial: '192.168.1.10:5555',
            target: '192.168.1.10:5555',
            alreadyConnected: false,
          },
        }}
        onConnected={onConnected}
        onClose={onClose}
      />,
    );
    expect(onConnected).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not let a late connect cancel a newer QR workflow in the same dialog', async () => {
    const onConnected = vi.fn();
    const onClose = vi.fn();
    const onCancelQrPairing = vi.fn();
    const onSupersedeDialog = vi.fn();
    const onStartQrPairing = vi.fn(async () => ({
      action: 'startQr' as const,
      ok: true as const,
      sessionId: 'qrnewer123456789',
      payload: 'WIFI:T:ADB;S:ADB_WIFI_newer1234567;P:NewQrSecret12345;;',
      serviceName: 'ADB_WIFI_newer1234567',
      expiresAt: Date.now() + 120_000,
    }));

    const { rerender } = render(
      <WirelessDialog
        dialogInstanceId={1}
        isOnline={true}
        onConnect={vi.fn(async () => ({
          action: 'connect' as const,
          ok: false as const,
          message: 'Still waiting',
        }))}
        onPair={noopPair}
        onStartQrPairing={onStartQrPairing}
        onCancelQrPairing={onCancelQrPairing}
        onSupersedeDialog={onSupersedeDialog}
        lateResult={null}
        onConnected={onConnected}
        onClose={onClose}
      />,
    );

    // Start Connect A (times out), then switch to Pair with QR in the same dialog.
    fireEvent.change(screen.getByLabelText('IP address and port'), {
      target: { value: '192.168.1.10:5555' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: 'Pair with QR' }));
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Android wireless debugging pairing QR code' })).toBeTruthy();
    });
    expect(onSupersedeDialog).toHaveBeenCalledWith(1);

    // Even if a late connect result arrives for dialogInstanceId=1, the active QR workflow survives untouched.
    rerender(
      <WirelessDialog
        dialogInstanceId={1}
        isOnline={true}
        onConnect={vi.fn()}
        onPair={noopPair}
        onStartQrPairing={onStartQrPairing}
        onCancelQrPairing={onCancelQrPairing}
        onSupersedeDialog={onSupersedeDialog}
        lateResult={{
          requestId: 1,
          dialogInstanceId: 1,
          result: {
            action: 'connect',
            ok: true,
            serial: '192.168.1.10:5555',
            target: '192.168.1.10:5555',
            alreadyConnected: false,
          },
        }}
        onConnected={onConnected}
        onClose={onClose}
      />,
    );
    expect(onConnected).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onCancelQrPairing).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: 'Android wireless debugging pairing QR code' })).toBeTruthy();
  });

  it('prefills Connect tab and shows public-IP warning when pair discovers a public connect target', async () => {
    const onPair = vi.fn(async () => ({
      action: 'pair' as const,
      ok: true as const,
      target: '192.168.1.42:37123',
      host: '192.168.1.42',
      connectedSerial: null,
      discoveredTarget: '8.8.8.8:47777',
      connectNote: 'Paired successfully. Discovered connect address 8.8.8.8:47777 is a public IP.',
    }));
    render(
      <WirelessDialog
        isOnline={true}
        onConnect={vi.fn()}
        onPair={onPair}
        onConnected={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Pair with code' }));
    fireEvent.change(screen.getByLabelText('Pairing IP address and port'), {
      target: { value: '192.168.1.42:37123' },
    });
    fireEvent.change(screen.getByLabelText('6-digit pairing code'), { target: { value: '482910' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair & connect' }));

    await waitFor(() => {
      expect((screen.getByLabelText('IP address and port') as HTMLInputElement).value).toBe('8.8.8.8:47777');
      expect(screen.getByText(/Public IP address\./i)).toBeTruthy();
    });
  });
});

describe('useWirelessActions deadlines, late reconciliation & QR payload scrubbing', () => {
  it('aligns client deadlines with multi-step server operations and reconciles a late tcpip success', async () => {
    expect(WIRELESS_ACTION_TIMEOUTS_MS.pair).toBeGreaterThanOrEqual(45_000);
    expect(WIRELESS_ACTION_TIMEOUTS_MS.tcpip).toBeGreaterThanOrEqual(65_000);

    const sent: ClientMessage[] = [];
    const onLateConnected = vi.fn();
    let answers: WirelessAnswer[] = [];

    const { result, rerender } = renderHook(
      ({ curAnswers }: { curAnswers: WirelessAnswer[] }) =>
        useWirelessActions({
          send: (msg) => {
            sent.push(msg);
            return true;
          },
          answers: curAnswers,
          qrPairing: null,
          isOpen: true,
          onLateConnected,
          timeouts: { tcpip: 25 },
        }),
      { initialProps: { curAnswers: answers } },
    );

    // Start tcpip and let the short test deadline expire while the server is still working.
    let initialOutcome: Extract<WirelessActionResult, { action: 'tcpip' }> | undefined;
    await act(async () => {
      initialOutcome = await result.current.enableTcpip('R58M123ABC');
    });
    expect(initialOutcome?.ok).toBe(false);
    expect(result.current.provisionalTcpipSerial).toBe('R58M123ABC');
    expect(result.current.actionError).toMatch(/Still waiting/i);

    const tcpipReq = sent.find((m) => m.type === 'enableWirelessTcpip');
    expect(tcpipReq && tcpipReq.type === 'enableWirelessTcpip').toBe(true);
    const requestId = tcpipReq?.type === 'enableWirelessTcpip' ? tcpipReq.requestId : 0;

    // Late server success arrives: clears timeout error, clears provisional lock, switches serial, shows notice.
    answers = [
      {
        requestId,
        result: {
          action: 'tcpip',
          ok: true,
          usbSerial: 'R58M123ABC',
          serial: '192.168.1.42:5555',
          target: '192.168.1.42:5555',
          port: 5555,
          alreadyConnected: false,
        },
      },
    ];
    rerender({ curAnswers: answers });

    await waitFor(() => {
      expect(result.current.provisionalTcpipSerial).toBeNull();
      expect(result.current.actionError).toBeNull();
      expect(result.current.actionNotice).toContain('192.168.1.42:5555');
      expect(onLateConnected).toHaveBeenCalledWith('192.168.1.42:5555');
    });
  });

  it('discards password-bearing QR payloads from store wirelessAnswers when expired or consumed', () => {
    let state = createInitialState();
    state = reduce(state, {
      kind: 'server',
      msg: {
        type: 'wirelessResult',
        requestId: 1,
        result: {
          action: 'startQr',
          ok: true,
          sessionId: '0123456789abcdef',
          payload: 'WIFI:T:ADB;S:ADB_WIFI_aabbccddeeff;P:SuperSecretQr123;;',
          serviceName: 'ADB_WIFI_aabbccddeeff',
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    expect(JSON.stringify(state.wirelessAnswers)).toContain('SuperSecretQr123');

    // Expiring the QR session strips the password-bearing payload from store state.
    const afterExpire = reduce(state, {
      kind: 'server',
      msg: { type: 'qrPairing', update: { sessionId: '0123456789abcdef', status: 'expired' } },
    });
    expect(JSON.stringify(afterExpire.wirelessAnswers)).not.toContain('SuperSecretQr123');

    // Explicit clearQrPayload (on consumption/cancel) also strips it immediately.
    const afterConsume = reduce(state, { kind: 'clearQrPayload', sessionId: '0123456789abcdef' });
    expect(JSON.stringify(afterConsume.wirelessAnswers)).not.toContain('SuperSecretQr123');

    // Disconnecting clears both the payload and stale qrPairing status.
    const withStatus = reduce(state, {
      kind: 'server',
      msg: { type: 'qrPairing', update: { sessionId: '0123456789abcdef', status: 'waiting' } },
    });
    const afterDisconnect = reduce(withStatus, {
      kind: 'connection',
      connection: { status: 'reconnecting', attempt: 1, retryAt: null, closeReason: null },
    });
    expect(afterDisconnect.qrPairing).toBeNull();
    expect(JSON.stringify(afterDisconnect.wirelessAnswers)).not.toContain('SuperSecretQr123');
  });

  it('does not hijack selection or close a newer dialog when a timed-out connect succeeds after the user moved on', async () => {
    const sent: ClientMessage[] = [];
    const onLateConnected = vi.fn();
    let props = {
      answers: [] as WirelessAnswer[],
      currentSerial: 'USB_A' as string | null,
      selectionVersion: 0,
      activeDialogId: 1 as number | null,
    };

    const { result, rerender } = renderHook(
      (p: typeof props) =>
        useWirelessActions({
          send: (msg) => {
            sent.push(msg);
            return true;
          },
          answers: p.answers,
          qrPairing: null,
          isOpen: true,
          currentSerial: p.currentSerial,
          selectionVersion: p.selectionVersion,
          activeDialogId: p.activeDialogId,
          onLateConnected,
          timeouts: { connect: 20 },
        }),
      { initialProps: props },
    );

    // Connect A times out in dialog #1.
    await act(async () => {
      await result.current.connect('192.168.1.10:5555', 1);
    });
    const req = sent.find((m) => m.type === 'connectDevice');
    const requestId = req?.type === 'connectDevice' ? req.requestId : 0;

    // User closes dialog #1, selects device B, and opens dialog #2 for C.
    props = {
      ...props,
      currentSerial: 'DEVICE_B',
      selectionVersion: 1,
      activeDialogId: 2,
    };
    rerender(props);

    // Connect A now finishes late: must NOT select A or deliver lateResult to dialog #2; only show notice.
    props = {
      ...props,
      answers: [
        {
          requestId,
          result: {
            action: 'connect',
            ok: true,
            serial: '192.168.1.10:5555',
            target: '192.168.1.10:5555',
            alreadyConnected: false,
          },
        },
      ],
    };
    rerender(props);

    await waitFor(() => {
      expect(result.current.actionNotice).toContain('192.168.1.10:5555');
    });
    expect(onLateConnected).not.toHaveBeenCalled();
    expect(result.current.lateResult).toBeNull();
  });

  it('never retains a timed-out startQr payload in hook lateResult and cancels the orphaned server session', async () => {
    const sent: ClientMessage[] = [];
    const onConsumeQrPayload = vi.fn();
    let answers: WirelessAnswer[] = [];

    const { result, rerender } = renderHook(
      ({ curAnswers }: { curAnswers: WirelessAnswer[] }) =>
        useWirelessActions({
          send: (msg) => {
            sent.push(msg);
            return true;
          },
          answers: curAnswers,
          qrPairing: null,
          isOpen: true,
          onConsumeQrPayload,
          timeouts: { startQr: 20 },
        }),
      { initialProps: { curAnswers: answers } },
    );

    await act(async () => {
      await result.current.startQrPairing();
    });
    const req = sent.find((m) => m.type === 'startQrPairing');
    const requestId = req?.type === 'startQrPairing' ? req.requestId : 0;

    // Late startQr reply arrives after timeout with a password-bearing payload.
    answers = [
      {
        requestId,
        result: {
          action: 'startQr',
          ok: true,
          sessionId: 'lateqr0123456789',
          payload: 'WIFI:T:ADB;S:ADB_WIFI_late;P:TimedOutSecret99;;',
          serviceName: 'ADB_WIFI_late',
          expiresAt: Date.now() + 120_000,
        },
      },
    ];
    rerender({ curAnswers: answers });

    await waitFor(() => {
      expect(onConsumeQrPayload).toHaveBeenCalledWith('lateqr0123456789');
      expect(sent).toContainEqual({ type: 'cancelQrPairing', sessionId: 'lateqr0123456789' });
    });
    expect(result.current.lateResult).toBeNull();
    expect(JSON.stringify(result.current)).not.toContain('TimedOutSecret99');
  });

  it('supersedes an earlier timed-out connect when the same dialog switches to QR and guards pre-deadline handoff completion', async () => {
    const sent: ClientMessage[] = [];
    const onLateConnected = vi.fn();
    let props = {
      answers: [] as WirelessAnswer[],
      currentSerial: 'R58M123ABC' as string | null,
      selectionVersion: 0,
      activeDialogId: 1 as number | null,
    };

    const { result, rerender } = renderHook(
      (p: typeof props) =>
        useWirelessActions({
          send: (msg) => {
            sent.push(msg);
            return true;
          },
          answers: p.answers,
          qrPairing: null,
          isOpen: true,
          currentSerial: p.currentSerial,
          selectionVersion: p.selectionVersion,
          activeDialogId: p.activeDialogId,
          onLateConnected,
          timeouts: { connect: 20, tcpip: 5_000 },
        }),
      { initialProps: props },
    );

    // 1) Connect A times out in dialog #1, then dialog #1 switches to QR (superseding Connect A).
    await act(async () => {
      await result.current.connect('192.168.1.10:5555', 1);
    });
    const connectReq = sent.find((m) => m.type === 'connectDevice');
    const connectReqId = connectReq?.type === 'connectDevice' ? connectReq.requestId : 0;

    act(() => {
      result.current.supersedeDialog(1);
    });

    props = {
      ...props,
      answers: [
        {
          requestId: connectReqId,
          result: {
            action: 'connect',
            ok: true,
            serial: '192.168.1.10:5555',
            target: '192.168.1.10:5555',
            alreadyConnected: false,
          },
        },
      ],
    };
    rerender(props);
    await waitFor(() => {
      expect(result.current.actionNotice).toContain('192.168.1.10:5555');
    });
    expect(result.current.lateResult).toBeNull();

    // 2) Confirmed public USB handoff completes BEFORE deadline after user switched selection to 192.168.1.42:5555.
    let handoffPromise!: Promise<Extract<WirelessActionResult, { action: 'tcpip' }>>;
    act(() => {
      handoffPromise = result.current.enableTcpip('R58M123ABC', 5555, {
        confirmationId: 'aabbccdd11223344',
        target: '192.0.2.15:5555',
      });
    });
    const tcpipReq = sent.find((m) => m.type === 'enableWirelessTcpip');
    const tcpipReqId = tcpipReq?.type === 'enableWirelessTcpip' ? tcpipReq.requestId : 0;

    // User switches to another device while handoff is still in flight (before deadline).
    props = { ...props, currentSerial: '192.168.1.42:5555', selectionVersion: 1 };
    rerender(props);

    // Handoff succeeds before deadline: must NOT override newer selection; reports background notice only.
    props = {
      ...props,
      answers: [
        ...props.answers,
        {
          requestId: tcpipReqId,
          result: {
            action: 'tcpip',
            ok: true,
            usbSerial: 'R58M123ABC',
            serial: '192.0.2.15:5555',
            target: '192.0.2.15:5555',
            port: 5555,
            alreadyConnected: false,
          },
        },
      ],
    };
    rerender(props);
    await act(async () => {
      await handoffPromise;
    });
    expect(onLateConnected).not.toHaveBeenCalled();
    expect(result.current.actionNotice).toContain(
      'Switched R58M123ABC to Wi-Fi (192.0.2.15:5555) in the background',
    );
  });
});
