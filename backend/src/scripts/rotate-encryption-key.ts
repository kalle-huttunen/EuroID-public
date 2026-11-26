/**
 * Encryption key rotation: re-encrypts every stored secret under the current key
 * (infrastructure/secrets/key-rotation.ts lists where secrets are stored and what a run checks).
 *
 *   --generate    Print a new ENCRYPTION_KEY and ENCRYPTION_KEY_ID and the steps. No database.
 *   --dry-run     Report what a run would re-encrypt, or why it would refuse. Writes nothing.
 *
 * Steps (backend/src/infrastructure/secrets/docs/ARCHITECTURE.md, Key Rotation):
 *   1. --generate.
 *   2. ENCRYPTION_KEY_PREVIOUS = the current ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS_ID = the current
 *      ENCRYPTION_KEY_ID (unset if there was none), ENCRYPTION_KEY and ENCRYPTION_KEY_ID = the
 *      generated values. Restart the API and the worker with them; the worker re-encodes its
 *      Temporal schedules under the new key at that start (its log names each one "updated").
 *   3. --dry-run, then a run, with the same settings.
 *   4. When it reports every secret under the new key id, the schedules were re-encoded (step 2)
 *      and no Temporal workflow started before step 2 is still running (its payloads stay
 *      encrypted under the previous key): remove
 *      ENCRYPTION_KEY_PREVIOUS and ENCRYPTION_KEY_PREVIOUS_ID, keep ENCRYPTION_KEY_ID, restart the
 *      API and the worker.
 * Settings that would lose secrets (ENCRYPTION_KEY_PREVIOUS without a new ENCRYPTION_KEY_ID, a
 * missing previous key id, a wrong previous key) are refused with what to set; exit code 1.
 *
 * Usage: npx ts-node -r tsconfig-paths/register src/scripts/rotate-encryption-key.ts [--dry-run|--generate]
 */

import { Logger } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import {
  ROTATION_STEPS,
  describeRotation,
  encryptionFromEnv,
  generateKeySettings,
  rotateStoredSecrets,
} from '@infrastructure/secrets/key-rotation';

const logger = new Logger('RotateEncryptionKey');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/euroid';
const DRY_RUN = process.argv.includes('--dry-run');
const GENERATE = process.argv.includes('--generate');

async function rotate(): Promise<void> {
  if (GENERATE) {
    const generated = generateKeySettings();
    logger.log('Generated a new encryption key (base64, 32 bytes) and key id:');
    logger.log(`  ENCRYPTION_KEY=${generated.ENCRYPTION_KEY}`);
    logger.log(`  ENCRYPTION_KEY_ID=${generated.ENCRYPTION_KEY_ID}`);
    logger.log('To rotate:');
    for (const line of ROTATION_STEPS) logger.log(`  ${line}`);
    return;
  }

  // Refuses settings that would lose secrets before the database is touched.
  const encryption = await encryptionFromEnv(process.env);
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const report = await rotateStoredSecrets(client.db(), encryption, { dryRun: DRY_RUN });
    for (const line of describeRotation(report)) logger.log(line);
    if (report.undecryptable.length > 0 || (!DRY_RUN && report.remaining > 0)) {
      process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

rotate().catch((err) => {
  logger.error('Rotation failed', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
