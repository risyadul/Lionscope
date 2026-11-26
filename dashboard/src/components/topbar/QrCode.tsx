import { useMemo } from 'react';
import { encode } from 'uqr';

type Props = {
  payload: string;
  label: string;
};

/**
 * Crisp inline SVG QR code rendered from a boolean module matrix (via `uqr`), with an explicit
 * white quiet zone so phone cameras read it reliably in both light and dark themes without
 * violating strict CSP rules.
 */
export function QrCode({ payload, label }: Props) {
  const { size, path } = useMemo(() => {
    const matrix = encode(payload, { ecc: 'M', border: 2 });
    const parts: string[] = [];
    for (let y = 0; y < matrix.size; y += 1) {
      const row = matrix.data[y];
      if (!row) continue;
      for (let x = 0; x < matrix.size; x += 1) {
        if (row[x]) parts.push(`M${x} ${y}h1v1h-1z`);
      }
    }
    return { size: matrix.size, path: parts.join('') };
  }, [payload]);

  return (
    <svg
      className="wireless-qr-svg"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#111418" />
    </svg>
  );
}
