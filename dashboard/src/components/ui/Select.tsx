import type { SelectHTMLAttributes } from 'react';

/**
 * A native select (its menu, keyboard handling and label stay the browser's) that wears the panel's chevron: the
 * browser's own arrow sits flush against the right edge and differs between engines.
 */
export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select-wrap">
      <select {...props}>{children}</select>
      <svg className="select-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </span>
  );
}
