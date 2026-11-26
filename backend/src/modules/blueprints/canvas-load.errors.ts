/**
 * GET /blueprints/latest could not load the saved Design studio canvas. Answered 503, as a
 * connector config this process cannot decrypt is (ConnectorConfigDecryptError), and never with
 * an empty canvas in its place: the studio would show its default layout, and a Save would
 * overwrite the stored canvas with it. The stored canvas is left unchanged. The message says what
 * to check, never a key, the ciphertext or a config value.
 */
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';

export class CanvasLoadError extends ServiceUnavailableException {
  /** `decryption`: a config stored in the canvas could not be decrypted by this process. */
  constructor(readonly decryption: boolean) {
    super(
      decryption
        ? 'The saved Design studio canvas could not be loaded: a connector config stored in it ' +
            'could not be decrypted by this process. Nothing was changed. Check that the ' +
            'encryption keys of every API and worker process (ENCRYPTION_KEY and ' +
            'ENCRYPTION_KEY_ID, ENCRYPTION_KEY_PREVIOUS and ENCRYPTION_KEY_PREVIOUS_ID, or the KMS ' +
            'key) include the key it was saved with, then retry.'
        : 'The saved Design studio canvas could not be loaded. Nothing was changed. Retry ' +
            'shortly; if it keeps failing, the server log names the cause.',
    );
  }
}

/**
 * POST /blueprints/save of a canvas revision that is no longer the stored one: someone saved the
 * canvas after this client loaded it. Answered 409; nothing was saved.
 */
export class CanvasRevisionConflict extends ConflictException {
  constructor(loaded: number, current: number | undefined) {
    super(
      'The canvas was saved by someone else after you loaded it' +
        (current !== undefined ? ` (you loaded revision ${loaded}, it is now ${current})` : '') +
        '. Nothing was saved. Reload the canvas to see their changes, then make yours again.',
    );
  }
}
