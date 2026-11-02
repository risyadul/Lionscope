import { describe, expect, it } from 'vitest';
import { AppPidResolver, PS_COMMAND } from '../src/session/appPids.ts';
import { fixture } from './helpers/fakes.ts';

const PKG = 'io.github.risyadul.lionscope.sample';
const API23_PS = fixture('ps-api23.txt');
const API23_PS_WITHOUT_APP = API23_PS.split('\n')
  .filter((line) => !line.endsWith(` ${PKG}`))
  .join('\n');

function resolverOn(answers: Record<string, string>) {
  const commands: string[] = [];
  const resolver = new AppPidResolver((command) => {
    commands.push(command);
    const answer = answers[command];
    return answer === undefined
      ? Promise.reject(new Error(`unexpected command ${command}`))
      : Promise.resolve(answer);
  }, PKG);
  return { resolver, commands };
}

describe('AppPidResolver', () => {
  it('takes the PIDs of pidof as they are on a device whose pidof works, with no ps', async () => {
    const { resolver, commands } = resolverOn({ [`pidof ${PKG}`]: '3326 3400\n' });
    await expect(resolver.resolve()).resolves.toEqual([3326, 3400]);
    await expect(resolver.resolve()).resolves.toEqual([3326, 3400]);
    expect(commands).toEqual([`pidof ${PKG}`, `pidof ${PKG}`]);
  });

  it('returns no PID, and asks nothing else, when pidof finds nothing (API 24+: no output, exit 1)', async () => {
    const { resolver, commands } = resolverOn({ [`pidof ${PKG}`]: '' });
    await expect(resolver.resolve()).resolves.toEqual([]);
    expect(commands).toEqual([`pidof ${PKG}`]);
  });

  it('falls back to the exact name in ps when pidof prints every PID (toybox of API 23), then skips pidof', async () => {
    const { resolver, commands } = resolverOn({
      [`pidof ${PKG}`]: fixture('pidof-api23.txt'),
      [PS_COMMAND]: API23_PS,
    });
    await expect(resolver.resolve()).resolves.toEqual([2455]);
    await expect(resolver.resolve()).resolves.toEqual([2455]);
    expect(commands).toEqual([`pidof ${PKG}`, PS_COMMAND, PS_COMMAND]);
  });

  it('returns no PID on API 23 while the app is not in ps (pidof must not turn into PID 1)', async () => {
    const { resolver } = resolverOn({
      [`pidof ${PKG}`]: fixture('pidof-api23.txt'),
      [PS_COMMAND]: API23_PS_WITHOUT_APP,
    });
    await expect(resolver.resolve()).resolves.toEqual([]);
  });

  it('treats `pidof -s` printing 1 as the same ignored name', async () => {
    const { resolver } = resolverOn({ [`pidof ${PKG}`]: '1\n', [PS_COMMAND]: API23_PS });
    await expect(resolver.resolve()).resolves.toEqual([2455]);
  });

  it('finds the app in the output of `ps -A` of newer toybox as well', async () => {
    const { resolver } = resolverOn({
      [`pidof ${PKG}`]: '1 2 3\n',
      [PS_COMMAND]: `USER PID NAME\n  4001 ${PKG}\n`,
    });
    await expect(resolver.resolve()).resolves.toEqual([4001]);
  });
});
