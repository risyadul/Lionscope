import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { permissionPatchSchema, permissionsSchema } from '../src/index.ts';

describe('permission wire state', () => {
  it('accepts the golden enabled, disabled and read-only dashboard states', () => {
    const lines = readFileSync(new URL('../fixtures/dashboard-permissions.ndjson', import.meta.url), 'utf8')
      .trim()
      .split('\n');
    const schema = z.object({ type: z.literal('permissions'), permissions: permissionsSchema }).strict();
    expect(lines.map((line) => schema.safeParse(JSON.parse(line)).success)).toEqual([true, true, true]);
  });
  it.each([{}, { storageRead: 'false' }, { extra: true }, { storageRead: false, storageWrite: true }])(
    'rejects invalid patches: %j',
    (value) => {
      expect(permissionPatchSchema.safeParse(value).success).toBe(false);
    },
  );
});
