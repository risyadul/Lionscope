import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLayoutPreviewCommand } from '../src/cli/layoutPreviewCommand.ts';
import { rgbPng } from './helpers/png.ts';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

describe('lionscope render-layout', () => {
  let project: string;
  let output: string;
  let args: string[];

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'lionscope preview project '));
    const layout = 'app/src/main/res/layout/row.xml';
    output = join(project, 'preview.png');
    for (const file of [join(project, layout), join(project, 'gradle/wrapper/gradle-wrapper.jar')]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '');
    }
    args = ['--project', project, '--module', ':app', '--layout', layout, '--out', output];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    spawn.mockReset();
    rmSync(project, { recursive: true, force: true });
  });

  it('renders the named variant using temporary sources and reports the resulting PNG', async () => {
    const image = rgbPng(2, 3, () => [128, 0, 0]);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    let sources = '';
    spawn.mockImplementation((_java, args: string[], options: { env: Record<string, string> }) => {
      expect(args).toContain(':app:testDemoDebugUnitTest');
      expect(args).toContain('io.github.risyadul.lionscope.preview.XmlLayoutPreview');
      expect(options.env.LIONSCOPE_PREVIEW_LAYOUT).toBe(join(project, 'app/src/main/res/layout/row.xml'));
      sources = options.env.LIONSCOPE_PREVIEW_SOURCE!;
      expect(readFileSync(join(sources, 'XmlLayoutPreview.java'), 'utf8')).toContain('public void render()');
      const images = join(options.env.LIONSCOPE_PREVIEW_REPORT!, 'images');
      mkdirSync(images, { recursive: true });
      writeFileSync(join(images, 'snapshot.png'), image);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });

    expect(await runLayoutPreviewCommand([...args, '--variant', 'demoDebug'])).toBe(0);
    expect(readFileSync(output)).toEqual(image);
    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify({ path: output, width: 2, height: 3 })}\n`);
    expect(() => readFileSync(join(sources, 'XmlLayoutPreview.java'))).toThrow();
  });

  it('keeps the previous image when Gradle fails', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    writeFileSync(output, 'previous image');
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 1, null));
      return child;
    });

    expect(await runLayoutPreviewCommand(args)).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Gradle layout render failed (exit 1)'));
    expect(readFileSync(output, 'utf8')).toBe('previous image');
  });
});
