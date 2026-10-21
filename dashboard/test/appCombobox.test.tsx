import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppInfo } from '@lionscope/protocol/wire';
import { AppCombobox, buildAppOptions } from '../src/components/topbar/AppCombobox.tsx';

const APPS: AppInfo[] = [
  { packageName: 'com.example.shop', pid: 4821, thirdParty: true },
  { packageName: 'com.example.courier', pid: null, thirdParty: true },
  { packageName: 'com.android.launcher3', pid: 900, thirdParty: false },
  { packageName: 'com.android.settings', pid: null, thirdParty: false },
];

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => cleanup());

describe('buildAppOptions', () => {
  it('hides system packages behind a reveal option when third-party matches exist', () => {
    const result = buildAppOptions(APPS, 'com', true);
    expect(result.options.map((o) => o.kind)).toEqual(['app', 'app', 'reveal']);
    expect(result.hiddenSystem).toBe(2);
    expect(result.autoRevealed).toBe(false);
  });

  it('shows system matches anyway when no third-party package matches the query', () => {
    const result = buildAppOptions(APPS, 'launcher3', true);
    expect(result.autoRevealed).toBe(true);
    expect(result.options).toEqual([{ kind: 'app', app: APPS[2] }]);
  });

  it('offers "Use <name>" for a valid package that is not visible', () => {
    const result = buildAppOptions(APPS, 'com.example.new', true);
    expect(result.options).toEqual([{ kind: 'custom', packageName: 'com.example.new' }]);
    expect(buildAppOptions(APPS, 'not a package', true).options).toEqual([]);
    expect(buildAppOptions(APPS, 'com.example.shop', true).options.map((o) => o.kind)).toEqual(['app']);
  });

  it('lists running apps first', () => {
    const names = buildAppOptions(APPS, '', false).options.map((o) =>
      o.kind === 'app' ? o.app.packageName : '',
    );
    expect(names).toEqual([
      'com.android.launcher3',
      'com.example.shop',
      'com.android.settings',
      'com.example.courier',
    ]);
  });
});

function setup(value: string | null = null) {
  const onChange = vi.fn();
  const onOpen = vi.fn();
  render(<AppCombobox apps={APPS} value={value} onChange={onChange} onOpen={onOpen} isDisabled={false} />);
  const input = screen.getByRole('combobox', { name: 'App' });
  return { input, onChange, onOpen };
}

const listbox = () => screen.getByRole('listbox', { name: 'Apps' });
const optionTexts = () =>
  within(listbox())
    .getAllByRole('option')
    .map((o) => o.textContent);

describe('AppCombobox', () => {
  it('does not open (or fetch) on focus; opens on click and ArrowDown', () => {
    const { input, onOpen } = setup();
    fireEvent.focus(input);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-controls')).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(input);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(listbox().id);
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('marks the keyboard-active option with aria-selected and moves it with arrows', () => {
    const { input } = setup('com.example.courier');
    fireEvent.click(input);
    const options = within(listbox()).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    // The chosen value is marked separately from the active option.
    expect(options[1]?.hasAttribute('data-current')).toBe(true);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'End' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[2]?.id);
    fireEvent.keyDown(input, { key: 'Home' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
  });

  it('reaches a system package by typing, with third-party only still on', () => {
    const { input, onChange } = setup();
    fireEvent.change(input, { target: { value: 'launcher3' } });
    expect(screen.getByText(/No third-party match/)).toBeTruthy();
    expect(optionTexts()).toEqual(['com.android.launcher3PID 900system']);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('com.android.launcher3');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('reveals hidden system apps from the keyboard via the reveal option or Alt+S', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'com' } });
    expect(optionTexts()).toEqual(['com.example.shopPID 4821', 'com.example.courier', 'Show 2 system apps']);

    fireEvent.keyDown(input, { key: 'End' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(optionTexts()).toHaveLength(4);
    expect(input.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(input, { key: 's', code: 'KeyS', altKey: true });
    expect(optionTexts()).toHaveLength(3);
    fireEvent.keyDown(input, { key: 's', code: 'KeyS', altKey: true });
    expect(optionTexts()).toHaveLength(4);
  });

  it('selects a typed, unlisted package through "Use <name>"', () => {
    const { input, onChange } = setup();
    fireEvent.change(input, { target: { value: 'com.example.new' } });
    expect(optionTexts()).toEqual(['Use com.example.newnot listed']);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('com.example.new');
  });

  it('closes on Tab and selects with a click', () => {
    const { input, onChange } = setup();
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(input);
    fireEvent.click(screen.getByText('com.example.courier'));
    expect(onChange).toHaveBeenCalledWith('com.example.courier');
  });

  it('shows the disabled reason as the placeholder', () => {
    render(
      <AppCombobox
        apps={null}
        value={null}
        onChange={() => {}}
        onOpen={() => {}}
        isDisabled
        disabledReason="Offline — waiting for the server"
      />,
    );
    const input = screen.getAllByRole('combobox', { name: 'App' }).at(-1) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('Offline — waiting for the server');
  });
});
