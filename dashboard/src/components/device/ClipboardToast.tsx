import type { ClipboardToast as Toast } from './useClipboardShare.ts';

type Props = {
  toast: Toast | null;
  /** What the screen is: "emulator" or "device". */
  noun: string;
  onCopy: () => void;
};

/** Android → desktop clipboard feedback. The copied text never enters the DOM. */
export function ClipboardToast({ toast, noun, onCopy }: Props) {
  return (
    <div className="device-toast-region" role="status">
      {toast !== null && (
        <div className="device-toast" data-kind={toast.kind}>
          {toast.kind === 'copied' && `Copied from the ${noun}`}
          {toast.kind === 'failed' && 'Copying isn’t allowed here'}
          {toast.kind === 'manual' && (
            <>
              <span>{`Copied in the ${noun}`}</span>
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
