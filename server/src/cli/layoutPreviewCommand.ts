import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pngSize } from '../agent/png.ts';
import { errorMessage } from '../log.ts';
import { GRADLE_INIT, JAVA_PREVIEW, PREVIEW_TEST } from './layoutPreviewSources.ts';

const USAGE = `Usage: lionscope render-layout --module <:module> --layout <file.xml> --out <file.png> [options]

Render an Android View layout on this computer with Gradle and Layoutlib.
Requires JDK 21, the Android SDK and an Android Gradle project with a wrapper.

  --project <dir>     Gradle project root (default: current directory)
  --module <:module>  Android app or library module (use : for the root module)
  --layout <file>     Layout XML path relative to the Gradle root, or absolute
  --variant <name>    Android build variant (default: debug)
  --theme <name>      Android style name (default: android:Theme.Material.NoActionBar.Fullscreen)
  --out <file>        PNG output path, relative to the current directory or absolute
  -h, --help          Show this help
`;

async function requireFile(path: string, description: string): Promise<void> {
  if (!(await stat(path).catch(() => null))?.isFile()) {
    throw new Error(`${description} not found: ${path}`);
  }
}

async function runGradle(project: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const wrapper = join(project, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  await requireFile(wrapper, 'Gradle wrapper JAR');
  const java = env.JAVA_HOME ? join(env.JAVA_HOME, 'bin', 'java') : 'java';
  await new Promise<void>((done, reject) => {
    const child = spawn(java, ['-classpath', wrapper, 'org.gradle.wrapper.GradleWrapperMain', ...args], {
      cwd: project,
      env,
      stdio: ['ignore', process.stderr, process.stderr],
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) done();
      else reject(new Error(`Gradle layout render failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

export async function runLayoutPreviewCommand(argv: readonly string[]): Promise<number> {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h' },
        project: { type: 'string', default: '.' },
        module: { type: 'string' },
        layout: { type: 'string' },
        variant: { type: 'string', default: 'debug' },
        theme: { type: 'string', default: 'android:Theme.Material.NoActionBar.Fullscreen' },
        out: { type: 'string' },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (!values.module || !values.layout || !values.out) {
      throw new Error('Specify --module, --layout and --out. See render-layout --help.');
    }
    if (!/^:(?:[\w.-]+(?::[\w.-]+)*)?$/.test(values.module)) {
      throw new Error('Expected an absolute Gradle module path such as :app or :feature:home.');
    }
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(values.variant)) {
      throw new Error('Expected an Android variant name such as debug or demoDebug.');
    }
    const project = resolve(values.project);
    const layout = resolve(project, values.layout);
    const directory = basename(dirname(layout));
    if (
      !(directory === 'layout' || directory.startsWith('layout-')) ||
      !/^[a-z0-9_]+\.xml$/.test(basename(layout))
    ) {
      throw new Error('Choose a layout XML file in a layout or layout-<qualifiers> resource directory.');
    }
    const out = resolve(values.out);
    if (!out.toLowerCase().endsWith('.png')) throw new Error('--out must end in .png.');
    await requireFile(layout, 'Layout XML');

    const temp = await mkdtemp(join(tmpdir(), 'lionscope-layout-'));
    try {
      const init = join(temp, 'preview.init.gradle');
      const report = join(temp, 'report');
      const variant = values.variant[0]!.toUpperCase() + values.variant.slice(1);
      const task = `test${variant}UnitTest`;
      const modulePath = values.module === ':' ? '' : values.module;
      await Promise.all([
        writeFile(init, GRADLE_INIT),
        writeFile(join(temp, 'XmlLayoutPreview.java'), JAVA_PREVIEW),
      ]);
      await runGradle(
        project,
        [
          '--init-script',
          init,
          '--console=plain',
          '--no-configuration-cache',
          `${modulePath}:${task}`,
          '--tests',
          PREVIEW_TEST,
        ],
        {
          ...process.env,
          LIONSCOPE_PREVIEW_MODULE: values.module,
          LIONSCOPE_PREVIEW_SOURCE: temp,
          LIONSCOPE_PREVIEW_TASK: task,
          LIONSCOPE_PREVIEW_LAYOUT: layout,
          LIONSCOPE_PREVIEW_THEME: values.theme,
          LIONSCOPE_PREVIEW_REPORT: report,
        },
      );
      const images = join(report, 'images');
      const pngs = (await readdir(images).catch(() => [])).filter((file) => file.endsWith('.png'));
      if (pngs.length !== 1) throw new Error(`Expected one rendered PNG, received ${pngs.length}.`);
      const image = await readFile(join(images, pngs[0]!));
      const size = pngSize(image);
      await writeFile(out, image);
      process.stdout.write(`${JSON.stringify({ path: out, ...size })}\n`);
      return 0;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}
