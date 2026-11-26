/**
 * Bulk validation messages name the operation, never the person. The bulk provisioning workflow
 * joins the error messages into its ValidationFailed failure, and failure messages are stored in
 * clear in the Temporal history: the payload codec covers payloads only.
 */
import {
  BulkOperationType,
  OperationPriority,
  type BulkOperationInput,
} from '@shared/dtos/bulk-operation.dto';
import type { PolicyEngineService } from '../modules/policy/policy-engine.service';
import { validateBulkBatch } from './bulk-provisioning-validation';

const operation = (
  id: string,
  type: BulkOperationType,
  user: Record<string, unknown>,
): BulkOperationInput =>
  ({
    id,
    type,
    user: { firstName: 'Ada', lastName: 'Lovelace', ...user },
    targetSystems: ['entra-id'],
    priority: OperationPriority.NORMAL,
  }) as BulkOperationInput;

describe('validateBulkBatch messages', () => {
  // No tenant: the SoD check is skipped, so no policy engine is called
  const validate = (operations: BulkOperationInput[]) =>
    validateBulkBatch(operations, undefined, {} as PolicyEngineService);

  it('names an invalid address by its operation, not by the address', async () => {
    const result = await validate([
      operation('op-7', BulkOperationType.CREATE, { email: 'ada lovelace@example.com' }),
    ]);

    expect(result.errors).toEqual([
      expect.objectContaining({ operationId: 'op-7', field: 'email' }),
    ]);
    expect(result.errors[0].message).toBe('Invalid email format in operation op-7');
  });

  it('names a destructive operation on a VIP by its operation, not by the address', async () => {
    const result = await validate([
      operation('op-3', BulkOperationType.DELETE, { email: 'vip@example.com', priority: 'VIP' }),
    ]);

    expect(result.warnings).toEqual([
      expect.objectContaining({
        operationId: 'op-3',
        message: 'Destructive operation on a VIP user in operation op-3',
      }),
    ]);
    expect(result.risk.vipUsersAffected).toBe(1);
  });

  it('keeps every address out of the messages the workflow can put in its failure', async () => {
    const result = await validate([
      operation('op-1', BulkOperationType.CREATE, { email: 'bad address@example.com' }),
      operation('op-2', BulkOperationType.DISABLE, { email: 'vip@example.com', priority: 'VIP' }),
      operation('op-4', BulkOperationType.CREATE, { email: 'grace@example.com', lastName: '' }),
    ]);

    const messages = [...result.errors, ...result.warnings].map((m) => m.message).join('\n');
    expect(messages).not.toMatch(/@/);
    expect(result.safe).toBe(false); // the missing last name is CRITICAL: the workflow fails
  });
});
