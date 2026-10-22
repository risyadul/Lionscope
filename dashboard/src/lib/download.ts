/** Saving server-sent files (screenshots) through a temporary blob URL. */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `Pixel_9a-20261021-142530.png`, in local time. AVD names are already filename-safe (AVD_NAME_PATTERN); the
 * device panel makes a physical device's model or serial so.
 */
export function screenshotFileName(name: string, at: Date): string {
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${name}-${date}-${time}.png`;
}

/** How long the blob URL outlives the click; the download has started by then. */
const REVOKE_AFTER_MS = 10_000;

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
