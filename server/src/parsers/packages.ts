import { isValidPackageName } from '@lionscope/protocol';
import type { AppInfo } from '@lionscope/protocol';

/** Parse `pm list packages` output (`package:<name>` per line), keeping only valid names. */
export function parsePackageList(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('package:')) continue;
    const name = trimmed.slice('package:'.length).trim();
    if (isValidPackageName(name)) names.add(name);
  }
  return [...names];
}

/** Merge package lists and running processes; running first, then third-party, then alphabetical. */
export function buildAppList(
  allPackages: readonly string[],
  thirdPartyPackages: readonly string[],
  pidsByName: ReadonlyMap<string, number>,
): AppInfo[] {
  const thirdParty = new Set(thirdPartyPackages);
  const names = new Set([...allPackages, ...thirdPartyPackages]);
  const apps: AppInfo[] = [...names].filter(isValidPackageName).map((packageName) => ({
    packageName,
    pid: pidsByName.get(packageName) ?? null,
    thirdParty: thirdParty.has(packageName),
  }));
  return apps.sort((a, b) => {
    const running = Number(b.pid !== null) - Number(a.pid !== null);
    if (running !== 0) return running;
    const third = Number(b.thirdParty) - Number(a.thirdParty);
    if (third !== 0) return third;
    return a.packageName.localeCompare(b.packageName);
  });
}
