/**
 * Prints a workflow history, or a part of one, with every payload the Temporal payload codec
 * encrypted replaced by the value it holds. The Temporal UI and CLI show those payloads as
 * ciphertext and EuroID runs no codec server (secrets docs/ARCHITECTURE.md, Temporal Payloads).
 *
 *   temporal workflow show --workflow-id <id> --namespace <ns> --output json > history.json
 *   npx ts-node -r tsconfig-paths/register src/scripts/decode-temporal-payloads.ts history.json
 *
 * Reads the file (stdin without one) as protobuf JSON and writes the result to stdout. Run it with
 * the worker's encryption settings (ENCRYPTION_KEY, ENCRYPTION_KEY_ID, ENCRYPTION_KEY_PREVIOUS,
 * ENCRYPTION_KEY_PREVIOUS_ID, or the passphrase or KMS settings). A payload those keys cannot
 * decrypt stops it with an error that names the payload's key id; exit code 1.
 * The output holds personal data: read it, do not store or share it.
 */

import * as fs from 'fs';
import { Logger } from '@nestjs/common';
import { encryptionFromEnv } from '@infrastructure/secrets/key-rotation';
import { temporalPayloadCodec } from '@infrastructure/temporal/temporal-payload-codec';
import { decryptPayloadsInJson } from '@infrastructure/temporal/temporal-payload-json';

async function main(): Promise<void> {
  // stdout carries the JSON only: no key-loading log lines
  Logger.overrideLogger(['error']);
  const input = fs.readFileSync(process.argv[2] ?? 0, 'utf8');
  const codec = temporalPayloadCodec(await encryptionFromEnv(process.env));
  const decoded = decryptPayloadsInJson(JSON.parse(input), codec);
  process.stdout.write(`${JSON.stringify(decoded, null, 2)}\n`);
}

main().catch((err) => {
  new Logger('DecodeTemporalPayloads').error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
