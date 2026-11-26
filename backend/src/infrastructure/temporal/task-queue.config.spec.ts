/**
 * Workflows route connector activities with QUEUE_NAMES; worker.ts registers each connector's
 * activities only on its manifest's taskQueue. If the two disagree, the activity is scheduled on
 * a queue nobody polls for it and the workflow stalls until its retries run out.
 */
import { QUEUE_NAMES } from './task-queue.config';
import { entraManifest } from '../../modules/connectors/entra-connector/connector.manifest';
import { adManifest } from '../../modules/connectors/ad-connector/connector.manifest';
import { scimManifest } from '../../modules/connectors/scim-connector/connector.manifest';
import { oktaManifest } from '../../modules/connectors/okta-connector/connector.manifest';

describe('QUEUE_NAMES', () => {
  it.each([entraManifest, adManifest, scimManifest, oktaManifest].map((m) => [m.id, m]))(
    'routes %s to the queue its plugin worker polls',
    (_id, manifest) => {
      expect(manifest.taskQueue).toBeDefined();
      expect(QUEUE_NAMES[manifest.id]).toBe(manifest.taskQueue);
    },
  );
});
