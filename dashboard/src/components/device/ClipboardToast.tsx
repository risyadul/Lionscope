import type { ClipboardToast as Toast } from './useClipboardShare.ts';

type Props = {
  toast: Toast | null;
  onCopy: () => void;
};

/** Android → desktop clipboard feedback. The copied text never enters the DOM. */
export function ClipboardToast({ toast, onCopy }: Props) {
  return (
    <div className="device-toast-region" role="status">
      {toast !== null && (
        <div className="device-toast" data-kind={toast.kind}>
          {toast.kind === 'copied' && 'Copied from the emulator'}
          {toast.kind === 'failed' && 'Copying isn’t allowed here'}
          {toast.kind === 'manual' && (
            <>
              <span>Copied in the emulator</span>
              <button type="button" className="btn device-toast-copy" onClick={onCopy}>
                Copy
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
