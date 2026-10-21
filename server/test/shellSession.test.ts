import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_QUEUED_COMMANDS, ShellSession } from '../src/adb/shellSession.ts';
import { FakeChild, FakeShellChild } from './helpers/fakes.ts';
import type { ShellHandler } from './helpers/fakes.ts';

function sessionWith(handler: ShellHandler) {
  const children: FakeShellChild[] = [];
  const session = new ShellSession(() => {
    const child = new FakeShellChild(handler);
    children.push(child);
    return child;
  });
  return { session, children };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ShellSession', () => {
  it('runs commands in FIFO order on one persistent process', async () => {
    const { session, children } = sessionWith((command) => {
      if (command === 'slow') return { output: 'slow-out\n', delayMs: 20 };
      return `${command}-out\n`;
    });
    const results = await Promise.all([session.run('slow'), session.run('a'), session.run('b')]);
    expect(results).toEqual(['slow-out\n', 'a-out\n', 'b-out\n']);
    expect(children).toHaveLength(1);
    expect(children[0]?.commands).toEqual(['slow', 'a', 'b']);
    expect(children[0]?.input.startsWith('exec 2>&1\n')).toBe(true);
    session.close();
  });

  it(`rejects commands beyond ${MAX_QUEUED_COMMANDS} waiting ones, and accepts more once drained`, async () => {
    const { session } = sessionWith((command) =>
      command === 'slow' ? { output: 'slow\n', delayMs: 20 } : `${command}\n`,
    );
    const running = session.run('slow');
    const queued = Array.from({ length: MAX_QUEUED_COMMANDS }, (_, i) => session.run(`q${i}`));
    await expect(session.run('one too many')).rejects.toThrow('adb shell queue full');
    expect(await running).toBe('slow\n');
    expect(await Promise.all(queued)).toHaveLength(MAX_QUEUED_COMMANDS);
    expect(await session.run('later')).toBe('later\n');
    session.close();
  });

  function nonceOf(child: FakeChild): string {
    const match = /printf '\\n__LS_([0-9a-f]{16})_%s__\\n' \d+\n/.exec(child.input);
    if (!match?.[1]) throw new Error(`no marker command in ${JSON.stringify(child.input)}`);
    return match[1];
  }

  it('frames output correctly when the marker is split across chunks', async () => {
    const child = new FakeChild();
    const session = new ShellSession(() => child);
    const result = session.run('cmd');
    await Promise.resolve();
    expect(child.input).toMatch(/^exec 2>&1\ncmd\nprintf '\\n__LS_[0-9a-f]{16}_%s__\\n' 1\n$/);
    const marker = `\n__LS_${nonceOf(child)}_1__\n`;
    const chunks = [
      'line one\nline',
      ' two\n',
      marker.slice(0, 7),
      marker.slice(7, 20),
      `${marker.slice(20)}left`,
    ];
    for (const chunk of chunks) child.stdout.write(chunk);
    await expect(result).resolves.toBe('line one\nline two\n');
    session.close();
  });

  it('uses a random nonce per session, so output cannot forge the end marker', async () => {
    const a = new FakeChild();
    const b = new FakeChild();
    const sessionA = new ShellSession(() => a);
    const sessionB = new ShellSession(() => b);
    const first = sessionA.run('one');
    void sessionB.run('one').catch(() => undefined);
    await Promise.resolve();
    expect(nonceOf(a)).not.toBe(nonceOf(b));
    a.stdout.write('x\n__LS_DONE_1__\n');
    a.stdout.write(`y\n__LS_${nonceOf(b)}_1__\n`);
    a.stdout.write(`z\n__LS_${nonceOf(a)}_7__\n`);
    a.stdout.write(`end\n__LS_${nonceOf(a)}_1__\n`);
    await expect(first).resolves.toBe(
      `x\n__LS_DONE_1__\ny\n__LS_${nonceOf(b)}_1__\nz\n__LS_${nonceOf(a)}_7__\nend`,
    );
    sessionA.close();
    sessionB.close();
  });

  it('accepts CRLF line endings from PTY shells', async () => {
    const children: FakeShellChild[] = [];
    const session = new ShellSession(() => {
      const child = new FakeShellChild((command) => `${command}-out\n`);
      child.crlf = true;
      children.push(child);
      return child;
    });
    await expect(session.run('a')).resolves.toBe('a-out\r\n');
    await expect(session.run('b')).resolves.toBe('b-out\r\n');
    expect(children).toHaveLength(1);
    session.close();
  });

  it('times out, rejects, kills the process and respawns lazily', async () => {
    vi.useFakeTimers();
    let hang = true;
    const { session, children } = sessionWith(() => (hang ? 'hang' : 'ok\n'));
    const pending = session.run('stuck', 1000);
    const rejection = expect(pending).rejects.toThrow(/timed out after 1000 ms: stuck/);
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(children[0]?.killed).toBe(true);

    hang = false;
    const next = session.run('again');
    await vi.advanceTimersByTimeAsync(0);
    await expect(next).resolves.toBe('ok\n');
    expect(children).toHaveLength(2);
    session.close();
  });

  it('rejects in-flight and queued commands when the process exits', async () => {
    const child = new FakeChild();
    child.stderr.write('error: device offline\n');
    const session = new ShellSession(() => child);
    const first = session.run('a');
    const second = session.run('b');
    await new Promise((resolve) => setImmediate(resolve));
    child.exit(1);
    await expect(first).rejects.toThrow(/exited \(code 1.*device offline/);
    await expect(second).rejects.toThrow(/exited/);
    session.close();
  });

  it('rejects when the process emits an error (e.g. adb not found)', async () => {
    const child = new FakeChild();
    const session = new ShellSession(() => child);
    const pending = session.run('a');
    child.emit('error', new Error('spawn adb ENOENT'));
    await expect(pending).rejects.toThrow(/ENOENT/);
    session.close();
  });

  it('rejects when spawning throws', async () => {
    const session = new ShellSession(() => {
      throw new Error('boom');
    });
    await expect(session.run('a')).rejects.toThrow('failed to start adb shell');
  });

  it('rejects everything after close()', async () => {
    const { session, children } = sessionWith(() => 'hang');
    const pending = session.run('a');
    await Promise.resolve();
    session.close();
    session.close();
    await expect(pending).rejects.toThrow('shell session closed');
    await expect(session.run('b')).rejects.toThrow('shell session closed');
    expect(children[0]?.killed).toBe(true);
  });

  it('aborts a command whose output exceeds the limit', async () => {
    const child = new FakeChild();
    const session = new ShellSession(() => child);
    const pending = session.run('flood');
    const chunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 33; i += 1) child.stdout.write(chunk);
    await expect(pending).rejects.toThrow(/exceeded limit/);
    expect(child.killed).toBe(true);
    session.close();
  });
});
