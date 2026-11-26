/**
 * A stored connector config this process cannot decrypt (ConnectorConfigService). The stored
 * config is left as it is: the key may be missing only in this process (another ENCRYPTION_KEY,
 * a key id its key ring lacks, keys not loaded yet), so the same read can succeed on a process
 * that holds the right key. That makes it 503, which Temporal retries, and never 4xx: nothing is
 * wrong with what the caller sent. The message names the connector and the settings to check,
 * never a key, the ciphertext or a config value.
 */
import { ServiceUnavailableException } from '@nestjs/common';

export class ConnectorConfigDecryptError extends ServiceUnavailableException {
  /** `keysLoaded` false: read before this process loaded its encryption keys. */
  constructor(
    readonly connectorName: string,
    keysLoaded = true,
  ) {
    super(
      keysLoaded
        ? `The stored config of connector "${connectorName}" could not be decrypted by this ` +
            'process; it was left unchanged. Check that the encryption keys of every API and ' +
            'worker process (ENCRYPTION_KEY and ENCRYPTION_KEY_ID, ENCRYPTION_KEY_PREVIOUS and ' +
            'ENCRYPTION_KEY_PREVIOUS_ID, or the KMS key) include the key it was saved with. If ' +
            'that key is lost, install the connector again with its full config.'
        : `The stored config of connector "${connectorName}" cannot be read yet: this process ` +
            'has not loaded its encryption keys. Retry shortly.',
    );
  }
}
