import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Permissions } from '@lionscope/protocol/wire';
import './permissions.css';

const ROWS: { key: keyof Permissions; title: string; description: string }[] = [
  {
    key: 'deviceControl',
    title: 'Agent device control',
    description: 'Let agents inspect and operate devices, edit Views, mock requests and change location.',
  },
  {
    key: 'networkBodies',
    title: 'Network bodies for agents',
    description: 'Let agents read captured request and response bodies. Dashboard capture is independent.',
  },
  {
    key: 'storageRead',
    title: 'Storage read',
    description:
      'Browse preferences and registered databases, and run SELECT queries in the dashboard and tools.',
  },
  {
    key: 'storageWrite',
    title: 'Storage write',
    description: 'Edit or delete data and run INSERT, UPDATE and DELETE. Requires Storage read.',
  },
];

export function PermissionsMenu({
  permissions,
  isOnline,
}: {
  permissions: Permissions | null;
  isOnline: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        className="btn permissions-trigger"
        onClick={() => setOpen(true)}
        disabled={!isOnline || permissions === null}
        aria-haspopup="dialog"
        title={
          !isOnline
            ? 'Offline — waiting for the server'
            : permissions === null
              ? 'Update the server to manage permissions'
              : 'Manage debugging permissions'
        }
      >
        Permissions
      </button>
      {open && permissions && (
        <PermissionDialog permissions={permissions} isOnline={isOnline} onClose={close} />
      )}
    </>
  );
}

function PermissionDialog({
  permissions,
  isOnline,
  onClose,
}: {
  permissions: Permissions;
  isOnline: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const changedInput = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', escape, true);
    dialog?.showModal();
    return () => {
      dialog?.close();
      document.removeEventListener('keydown', escape, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose]);
  useEffect(() => {
    if (
      !pending &&
      changedInput.current?.isConnected &&
      (document.activeElement === document.body || document.activeElement === ref.current)
    ) {
      changedInput.current.focus();
    }
  }, [pending]);
  const change = async (key: keyof Permissions, value: boolean) => {
    if (pending || !isOnline) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lionscope-Settings': '1' },
        body: JSON.stringify({ [key]: value }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('save failed');
      // The server broadcasts the accepted state to every dashboard; a late HTTP answer must not replace it.
    } catch {
      setError(
        'Could not confirm the change. Check the current switches after reconnecting before trying again.',
      );
    } finally {
      setPending(false);
    }
  };
  return createPortal(
    <dialog
      ref={ref}
      className="permissions-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="permissions-heading">
        <h2 id={`${id}-title`}>Permissions</h2>
        <button type="button" className="btn" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
      <p className="permissions-note">
        Changes apply without restarting Lionscope and are remembered on this computer for this server port.
      </p>
      <div className="permissions-rows" aria-busy={pending}>
        {ROWS.map(({ key, title, description }) => (
          <label className="permissions-row" key={key}>
            <span>
              <span className="permissions-label">{title}</span>
              <span id={`${id}-${key}`} className="permissions-description">
                {description}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={permissions[key]}
              disabled={!isOnline || pending || (key === 'storageWrite' && !permissions.storageRead)}
              aria-label={title}
              aria-describedby={`${id}-${key}`}
              onChange={(event) => {
                changedInput.current = event.target;
                void change(key, event.target.checked);
              }}
            />
          </label>
        ))}
      </div>
      <p className="permissions-note" role="status">
        {!isOnline
          ? 'Offline — waiting for the server.'
          : pending
            ? 'Saving permissions…'
            : 'Actions already running may finish. Disabling Storage read also disables writes.'}
      </p>
      {error && (
        <p className="permissions-error" role="alert">
          {error}
        </p>
      )}
    </dialog>,
    document.body,
  );
}
