import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_PERMISSIONS, permissionPatchSchema, permissionsSchema } from '@lionscope/protocol';
import type { Permissions } from '@lionscope/protocol';

export function mergePermissions(current: Readonly<Permissions>, patch: Partial<Permissions>): Permissions {
  if (Object.keys(patch).length === 0) return permissionsSchema.parse(current);
  const parsed = permissionPatchSchema.parse(patch);
  const next = { ...current, ...parsed };
  if (parsed.storageRead === false) next.storageWrite = false;
  if (parsed.storageWrite === true) next.storageRead = true;
  return permissionsSchema.parse(next);
}

export function permissionSettings(port: number, env: NodeJS.ProcessEnv = process.env) {
  const dir = env.LIONSCOPE_STATE_DIR || path.join(homedir(), '.lionscope');
  const file = path.join(dir, `${port}.permissions.json`);
  return {
    async load(): Promise<Permissions> {
      try {
        return permissionsSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          return { ...DEFAULT_PERMISSIONS };
        throw new Error(`Cannot read permission settings at ${file}; fix or remove that file.`, {
          cause: error,
        });
      }
    },
    async save(value: Readonly<Permissions>): Promise<void> {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(permissionsSchema.parse(value)), {
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

export class PermissionSettings {
  private current: Readonly<Permissions>;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    initial: Permissions,
    private readonly options: {
      save?: (permissions: Readonly<Permissions>) => Promise<void>;
      changed: (permissions: Readonly<Permissions>) => void;
    },
  ) {
    this.current = Object.freeze(permissionsSchema.parse(initial));
  }

  get value(): Readonly<Permissions> {
    return this.current;
  }

  update(patch: unknown): Promise<Readonly<Permissions>> {
    const parsed = permissionPatchSchema.parse(patch);
    const update = this.pending.then(async () => {
      const next = mergePermissions(this.current, parsed);
      await this.options.save?.(next);
      this.current = Object.freeze(next);
      this.options.changed(this.current);
      return this.current;
    });
    this.pending = update.catch(() => undefined);
    return update;
  }
}
