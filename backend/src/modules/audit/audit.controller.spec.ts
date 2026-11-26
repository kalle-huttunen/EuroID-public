/**
 * Audit routes: Zod at the gate on every input, and the create-checkpoint route.
 *
 * Before: the integrity, Merkle and anchor routes took their query, params and body as they came,
 * so a bad date or id reached the database (a 500 or a meaningless answer) and `limit` had no
 * bound. A ZodError from a route is answered 400 by the global ZodErrorFilter with the lines
 * zodIssueMessages builds, which these tests read.
 */
import { ZodError } from 'zod';
import { zodIssueMessages } from '@shared/filters/zod-error.filter';
import { AuditController } from './audit.controller';
import type { AuditService } from './audit.service';
import type { AuditMerkleService } from './audit-merkle.service';
import type { AuditAnchorService } from './audit-anchor.service';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'tenant-a' }),
}));

const CHECKPOINT_ID = '9b2f6c1e-4d3a-4f5b-8c7d-1e2f3a4b5c6d';

/** The 400 lines the global filter would answer, or [] when the call passed validation. */
async function issues(call: () => Promise<unknown>): Promise<string[]> {
  try {
    await call();
    return [];
  } catch (err) {
    if (err instanceof ZodError) return zodIssueMessages(err);
    throw err;
  }
}

describe('AuditController', () => {
  const auditService = {
    verifyIntegrity: jest.fn().mockResolvedValue({ valid: true }),
    query: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    log: jest.fn().mockResolvedValue(undefined),
    logFireAndForget: jest.fn(),
  };
  const merkle = {
    getMerkleRoots: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    verifyEvent: jest.fn().mockResolvedValue({ valid: true }),
    verifyRange: jest.fn().mockResolvedValue({ valid: true }),
    getCheckpoint: jest.fn().mockResolvedValue(null),
    createCheckpoint: jest.fn(),
  };
  const controller = new AuditController(
    auditService as unknown as AuditService,
    merkle as unknown as AuditMerkleService,
    {} as AuditAnchorService,
  );

  afterEach(() => jest.clearAllMocks());

  describe('GET /audit/verify-integrity', () => {
    it('passes a valid window to the check', async () => {
      await controller.verifyIntegrity('2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z');

      expect(auditService.verifyIntegrity).toHaveBeenCalledWith(
        'tenant-a',
        '2026-11-01T00:00:00.000Z',
        '2026-11-02T00:00:00.000Z',
      );
    });

    it('answers 400 for a time that is not ISO 8601, and for a reversed window', async () => {
      expect(await issues(() => controller.verifyIntegrity('yesterday'))).toEqual([
        'from: must be an ISO 8601 date and time, for example 2026-11-24T10:00:00.000Z',
      ]);
      expect(
        await issues(() =>
          controller.verifyIntegrity('2026-11-02T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
        ),
      ).toEqual(['from: must not be after to']);
      expect(auditService.verifyIntegrity).not.toHaveBeenCalled();
    });
  });

  describe('GET /audit/merkle-roots', () => {
    it('bounds page and limit', async () => {
      expect(await issues(() => controller.getMerkleRoots('0', '500'))).toEqual([
        'page: Number must be greater than or equal to 1',
        'limit: Number must be less than or equal to 100',
      ]);
      expect(await issues(() => controller.getMerkleRoots('abc'))).toEqual([
        'page: Expected number, received nan',
      ]);
      await controller.getMerkleRoots();
      expect(merkle.getMerkleRoots).toHaveBeenCalledWith('tenant-a', 1, 50);
    });
  });

  describe('ids in the path', () => {
    it('POST /audit/verify-event/:eventId takes an audit event _id only', async () => {
      expect(await issues(() => controller.verifyEvent('not-an-id'))).toEqual([
        'eventId: must be an audit event id (24 hexadecimal characters)',
      ]);
      await controller.verifyEvent('64b7f0c2a1b2c3d4e5f60a01');
      expect(merkle.verifyEvent).toHaveBeenCalledWith('tenant-a', '64b7f0c2a1b2c3d4e5f60a01');
    });

    it('GET /audit/merkle-roots/:checkpointId/anchor takes a checkpoint UUID only', async () => {
      expect(await issues(() => controller.getAnchorEnvelope('../roots'))).toEqual([
        'checkpointId: must be a checkpoint id (a UUID)',
      ]);
      expect(merkle.getCheckpoint).not.toHaveBeenCalled();
      await expect(controller.getAnchorEnvelope(CHECKPOINT_ID)).rejects.toThrow(
        `Checkpoint ${CHECKPOINT_ID} not found`,
      );
    });
  });

  describe('POST /audit/verify', () => {
    it('takes no body (Express 5 leaves it undefined) or a valid window', async () => {
      await controller.verifyRange(undefined);
      expect(merkle.verifyRange).toHaveBeenCalledWith('tenant-a', undefined, undefined);

      await controller.verifyRange({ from: '2026-11-01T00:00:00.000Z' });
      expect(merkle.verifyRange).toHaveBeenLastCalledWith(
        'tenant-a',
        new Date('2026-11-01T00:00:00.000Z'),
        undefined,
      );
    });

    it('answers 400 for a bad date', async () => {
      expect(await issues(() => controller.verifyRange({ to: 'soon' }))).toEqual([
        'to: must be an ISO 8601 date and time, for example 2026-11-24T10:00:00.000Z',
      ]);
    });
  });

  describe('GET /audit', () => {
    it('answers 400 for a date range that is not ISO 8601 or reversed', async () => {
      const query = (dateFrom?: string, dateTo?: string) => () =>
        controller.queryEvents(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          dateFrom,
          dateTo,
        );
      expect(await issues(query('32/13/2026'))).toEqual([
        'dateFrom: must be an ISO 8601 date and time, for example 2026-11-24T10:00:00.000Z',
      ]);
      expect(await issues(query('2026-11-02', '2026-11-01'))).toEqual([
        'dateFrom: must not be after dateTo',
      ]);
      expect(auditService.query).not.toHaveBeenCalled();
    });
  });

  describe('POST /audit/merkle-roots', () => {
    it('creates a checkpoint, audits who made it and answers without its event hashes', async () => {
      const checkpoint = {
        checkpointId: CHECKPOINT_ID,
        rootHash: 'r'.repeat(64),
        eventCount: 3,
        firstSeq: 1,
        lastSeq: 3,
        anchorSignature: undefined,
      };
      merkle.createCheckpoint.mockResolvedValue({
        ...checkpoint,
        toObject: () => ({ ...checkpoint, eventHashes: ['h1', 'h2', 'h3'] }),
      });

      const answer = await controller.createCheckpoint({
        sub: 'u-1',
        email: 'root@tenant-a.example',
        roles: ['super-admin'],
      } as never);

      expect(merkle.createCheckpoint).toHaveBeenCalledWith('tenant-a');
      expect(answer).toEqual(checkpoint);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'AUDIT_CHECKPOINT_CREATED',
          actor: 'root@tenant-a.example',
          resourceType: 'audit_checkpoint',
          resourceId: CHECKPOINT_ID,
          tenantId: 'tenant-a',
          payload: {
            metadata: {
              rootHash: checkpoint.rootHash,
              eventCount: 3,
              firstSeq: 1,
              lastSeq: 3,
              signed: false,
            },
          },
        }),
      );
    });

    it('audits nothing when no checkpoint was made', async () => {
      merkle.createCheckpoint.mockRejectedValue(
        new Error('No audit events since the last checkpoint'),
      );

      await expect(controller.createCheckpoint()).rejects.toThrow('No audit events');
      expect(auditService.log).not.toHaveBeenCalled();
    });
  });
});
