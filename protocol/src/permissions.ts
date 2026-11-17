import { z } from 'zod';

export const permissionsSchema = z
  .object({
    deviceControl: z.boolean(),
    networkBodies: z.boolean(),
    storageRead: z.boolean(),
    storageWrite: z.boolean(),
  })
  .strict()
  .refine((value) => value.storageRead || !value.storageWrite, {
    message: 'Storage write requires Storage read',
  });

export const permissionPatchSchema = z
  .object({
    deviceControl: z.boolean().optional(),
    networkBodies: z.boolean().optional(),
    storageRead: z.boolean().optional(),
    storageWrite: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one permission',
  })
  .refine((value) => value.storageRead !== false || value.storageWrite !== true, {
    message: 'Storage write requires Storage read',
  });
