import type { KeyboardEvent } from 'react';

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  title?: string;
  /** Extra `data-*` hooks for styling. */
  data?: Record<`data-${string}`, string | undefined>;
}

type Props<T extends string | number> = {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  /** Every option is inert (the group stays visible to show the current value). */
  disabled?: boolean;
  /** Id of the element explaining why the group is disabled. */
  describedBy?: string;
  /** Held arrow keys don't step: each change is a server request (rate-limited socket). */
  ignoreRepeat?: boolean;
};

const STEP: Partial<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** ARIA radio group: one tab stop, arrow keys move and select (WAI-ARIA radio pattern). */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  className,
  disabled = false,
  describedBy,
  ignoreRepeat = false,
}: Props<T>) {
  const current = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (ignoreRepeat && event.repeat) {
      if (event.key in STEP || event.key === 'Home' || event.key === 'End') event.preventDefault();
      return;
    }
    let next: number | null = null;
    const step = STEP[event.key];
    if (step !== undefined) next = (current + step + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    const option = next === null ? undefined : options[next];
    if (next === null || !option) return;
    event.preventDefault();
    onChange(option.value);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons[next]?.focus();
  };

  return (
    <div
      className={className ? `segmented ${className}` : 'segmented'}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy}
      onKeyDown={handleKeyDown}
    >
      {options.map((option, i) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={i === current ? 0 : -1}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          {...option.data}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
