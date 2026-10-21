/** 14 px line icons for the device panel (1.5 px strokes, like the rest of the instrument). */
import type { ReactNode } from 'react';

function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const BackIcon = () => (
  <Icon>
    <path d="M10.5 2.5v9L3.5 7z" />
  </Icon>
);

export const HomeIcon = () => (
  <Icon>
    <circle cx="7" cy="7" r="4.5" />
  </Icon>
);

export const RecentsIcon = () => (
  <Icon>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
  </Icon>
);

export const PowerIcon = () => (
  <Icon>
    <path d="M7 1.75v4.5M4.2 3.6a4.5 4.5 0 1 0 5.6 0" />
  </Icon>
);

export const RotateLeftIcon = () => (
  <Icon>
    <path d="M2.5 5.5A5 5 0 1 1 3 9.6M2.5 2v3.5H6" />
  </Icon>
);

export const RotateRightIcon = () => (
  <Icon>
    <path d="M11.5 5.5A5 5 0 1 0 11 9.6M11.5 2v3.5H8" />
  </Icon>
);

export const CameraIcon = () => (
  <Icon>
    <path d="M1.75 4.75h2.5l1-1.5h3.5l1 1.5h2.5v6.5H1.75z" />
    <circle cx="7" cy="7.75" r="2" />
  </Icon>
);

export const CollapseIcon = () => (
  <Icon>
    <path d="M8.5 3.5 5 7l3.5 3.5M11.5 2.5v9" />
  </Icon>
);

export const ExpandIcon = () => (
  <Icon>
    <path d="M5.5 3.5 9 7l-3.5 3.5M2.5 2.5v9" />
  </Icon>
);

export const PhoneIcon = () => (
  <Icon>
    <rect x="3.75" y="1.25" width="6.5" height="11.5" rx="1.5" />
    <path d="M6.25 10.75h1.5" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon size={10}>
    <path d="m3 3 8 8m0-8-8 8" />
  </Icon>
);
