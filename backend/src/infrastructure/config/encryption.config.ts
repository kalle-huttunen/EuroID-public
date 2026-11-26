import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const encryptionSchema = z
  .object({
    KMS_PROVIDER: z.enum(['aws', 'azure']).optional(),
    ENCRYPTION_KEY: z.string().optional(),
    ENCRYPTION_KEY_PASSPHRASE: z.string().optional(),
    ENCRYPTION_KEY_SALT: z.string().optional(),
    ENCRYPTION_KEY_ID: z.string().default('default'),
    ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
    ENCRYPTION_KEY_PREVIOUS_ID: z.string().default('previous'),
    AWS_KMS_KEY_ARN: z.string().optional(),
    AZURE_KEYVAULT_URL: z.string().optional(),
    AZURE_KEYVAULT_KEY_NAME: z.string().default('euroid-encryption-key'),
    AZURE_KEYVAULT_WRAPPED_DEK: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.KMS_PROVIDER === 'aws') return !!data.AWS_KMS_KEY_ARN;
      if (data.KMS_PROVIDER === 'azure') return !!data.AZURE_KEYVAULT_URL;
      return true;
    },
    { message: 'KMS_PROVIDER requires AWS_KMS_KEY_ARN (aws) or AZURE_KEYVAULT_URL (azure)' },
  )
  .refine(
    (data) => {
      if (data.KMS_PROVIDER) return true;
      return !!(data.ENCRYPTION_KEY || data.ENCRYPTION_KEY_PASSPHRASE);
    },
    {
      message:
        'No encryption key configured. Set ENCRYPTION_KEY, ENCRYPTION_KEY_PASSPHRASE, or KMS_PROVIDER.',
    },
  );

export type EncryptionConfig = z.infer<typeof encryptionSchema>;

export const encryptionConfig = registerAs('encryption', (): EncryptionConfig => {
  const parsed = encryptionSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`Encryption config validation failed: ${msg}`);
  }
  return parsed.data;
});
