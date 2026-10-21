import type { EmulatorRenderer } from '@lionscope/protocol';

/** Software GL implementations the emulator falls back to (SwiftShader; lavapipe / llvmpipe on some hosts). */
const SOFTWARE_GL = /swiftshader|lavapipe|llvmpipe/i;

/** `-gpu <mode>` from the discovery file's quoted command line, lowercased; null when not given. */
export function gpuModeOf(cmdline: string): string | null {
  const args = [...cmdline.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? '');
  const index = args.indexOf('-gpu');
  return index !== -1 && index + 1 < args.length ? (args[index + 1] ?? '').toLowerCase() : null;
}

/** `-gpu swiftshader_indirect` / `-gpu guest` (software rendering in the guest) say it outright. */
export function rendererFromCmdline(cmdline: string): EmulatorRenderer {
  const mode = gpuModeOf(cmdline);
  return mode !== null && (SOFTWARE_GL.test(mode) || mode === 'guest') ? 'software' : 'unknown';
}

/**
 * The `GLES: <vendor>, <renderer>, <version>` line of `dumpsys SurfaceFlinger`: `software` for SwiftShader,
 * `host` for anything else; `unknown` without the line (SurfaceFlinger not up yet).
 */
export function rendererFromSurfaceFlinger(dumpsys: string): EmulatorRenderer {
  const gles = dumpsys.split('\n').find((line) => line.trimStart().startsWith('GLES:'));
  if (!gles) return 'unknown';
  return SOFTWARE_GL.test(gles) ? 'software' : 'host';
}
