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
};

const STEP: Partial<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** ARIA radio group: one tab stop, arrow keys move and select (WAI-ARIA radio pattern). */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  className,
}: Props<T>) {
  const current = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
          onClick={() => onChange(option.value)}
          {...option.data}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
