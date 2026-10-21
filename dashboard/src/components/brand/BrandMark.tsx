/** Lionscope mark: a reticle (the "scope") around a single brand-red point. */
export function BrandMark() {
  return (
    <span className="brand">
      <svg className="brand-mark" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M11 0.75v4M11 17.25v4M0.75 11h4M17.25 11h4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <circle cx="11" cy="11" r="2.6" className="brand-dot" />
      </svg>
      <span className="brand-word">
        Lion<span>scope</span>
      </span>
    </span>
  );
}
