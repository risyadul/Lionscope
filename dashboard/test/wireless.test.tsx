// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceInfo } from '@lionscope/protocol/wire';
import { DevicePicker } from '../src/components/topbar/DevicePicker.tsx';
import { WirelessDialog } from '../src/components/topbar/WirelessDialog.tsx';

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
});

describe('WirelessDialog', () => {
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
      <WirelessDialog isOnline={true} onConnect={onConnect} onConnected={onConnected} onClose={onClose} />,
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

    render(<WirelessDialog isOnline={true} onConnect={onConnect} onConnected={vi.fn()} onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('IP address and port'), {
      target: { value: '192.168.1.42:5555' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Connection refused/);
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
