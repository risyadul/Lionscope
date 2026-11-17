import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageQueryInput, StorageResponse, StorageWriteOutcome } from '@lionscope/protocol/wire';
import { StorageQuery } from '../src/components/storage/StorageQuery.tsx';
import type { StorageRequests } from '../src/hooks/useStorage.ts';

afterEach(cleanup);
const target = { serial: 'emulator-5554', packageName: 'com.example.shop', link: 1 };
const outcome: StorageWriteOutcome = {
  opId: 'op1',
  code: 'ok',
  late: false,
  txMs: 3,
  query: {
    readOnly: true,
    columns: ['id', 'label'],
    rows: [
      [
        { t: 'integer', v: '9223372036854775807' },
        { t: 'string', v: 'synthetic' },
      ],
    ],
    hasMore: true,
    truncated: false,
    offset: 0,
  },
};

function setup(canWrite = true) {
  const query = vi.fn(async (input: StorageQueryInput): Promise<StorageResponse> => ({
    ok: true,
    kind: 'query',
    target,
    outcome: { ...outcome, query: outcome.query && { ...outcome.query, offset: input.offset ?? 0 } },
  }));
  const unused = async (): Promise<StorageResponse> => ({ ok: false, code: 'failed', message: 'Unused' });
  const storage: StorageRequests = { query, list: unused, read: unused, write: unused, audit: unused };
  const onMutation = vi.fn();
  const props = {
    storage,
    databases: [
      { name: 'shop.db', status: 'ok' as const },
      { name: 'other.db', status: 'ok' as const },
    ],
    target,
    initialDatabase: 'shop.db',
    initialTable: 'item',
    canWrite,
    isRunning: true,
    outcomes: [],
    onMutation,
  };
  const view = render(<StorageQuery {...props} />);
  return { ...view, props, query, onMutation, editor: screen.getByRole('textbox', { name: /SQL editor/ }) };
}

describe('SQL workbench', () => {
  it('runs selected SQL with its database and app link; pages the executed statement', async () => {
    const { editor, query } = setup();
    const text = 'SELECT 1;\nSELECT 2';
    fireEvent.change(editor, { target: { value: text } });
    fireEvent.select(editor, { target: { selectionStart: 10, selectionEnd: text.length } });
    await act(async () => fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true }));
    expect(query).toHaveBeenCalledWith({ name: 'shop.db', sql: 'SELECT 2', target, limit: 50, offset: 0 });
    expect(screen.getByRole('cell', { name: '9223372036854775807' })).toBeTruthy();
    fireEvent.change(editor, { target: { value: 'DELETE FROM item' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Next' })));
    expect(query.mock.calls[1]?.[0]).toMatchObject({ sql: 'SELECT 2', offset: 1 });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Next' })));
    expect(query.mock.calls[2]?.[0]).toMatchObject({ sql: 'SELECT 2', offset: 2 });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Previous' })));
    expect(query.mock.calls[3]?.[0]).toMatchObject({ sql: 'SELECT 2', offset: 1 });
  });

  it('requires write access and never reruns a mutation when history is opened', async () => {
    const readOnly = setup(false);
    fireEvent.change(readOnly.editor, { target: { value: 'DELETE FROM item' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })));
    expect(readOnly.query).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('--allow-storage-write');
    cleanup();
    const write = setup();
    write.query.mockResolvedValue({
      ok: true,
      kind: 'query',
      target,
      outcome: {
        opId: 'op2',
        code: 'ok',
        late: false,
        changes: 2,
        query: { readOnly: false, columns: [], rows: [], offset: 0, truncated: false, hasMore: false },
      },
    });
    fireEvent.change(write.editor, { target: { value: 'DELETE FROM item' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })));
    expect(write.onMutation).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').textContent).toContain('2 rows changed');
    fireEvent.click(screen.getByRole('button', { name: 'History 1' }));
    fireEvent.click(screen.getByRole('button', { name: /Load query from shop.db: DELETE FROM item/ }));
    expect(write.query).toHaveBeenCalledOnce();
    expect(screen.queryByText('2 rows changed')).toBeNull();
  });

  it('keeps a running statement single-shot and accepts its late final outcome', async () => {
    const { query, props, rerender } = setup();
    query.mockResolvedValue({
      ok: true,
      kind: 'query',
      target,
      outcome: { opId: 'op1', code: 'timeout', late: false },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })));
    rerender(
      <StorageQuery
        {...props}
        outcomes={[{ serial: target.serial, outcome: { opId: 'op1', code: 'ok', late: true, changes: 3 } }]}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('3 rows changed');
    expect(query).toHaveBeenCalledOnce();
    expect(screen.getByText(/Final outcome received/)).toBeTruthy();
  });

  it('clears results on database changes and clears history on a new session mount', async () => {
    const { query, props, rerender } = setup();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })));
    fireEvent.change(screen.getByRole('combobox', { name: 'Query database' }), {
      target: { value: 'other.db' },
    });
    expect(screen.queryByRole('cell', { name: 'synthetic' })).toBeNull();
    expect(query).toHaveBeenCalledOnce();
    rerender(<StorageQuery key="new-link" {...props} />);
    expect(screen.getByRole('button', { name: 'History 0' })).toBeTruthy();
  });
});
