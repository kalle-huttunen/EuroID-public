/**
 * POST /batch-provision/seed and /batch-provision/entra bodies (hunt 2026-11-25 03 F3): batchSize
 * was any number, so -1 made the batch loop of bulkProvisioningWorkflow never end (an empty slice
 * and a sleep per round); count was unbounded, so seeding allocated without limit; and
 * continueOnError was coerced with Boolean(), so the string "false" turned it on.
 */
import { EntraProvisionRequestSchema, SeedRequestSchema } from './batch-provision.dtos';

const refuses = (schema: { safeParse: (v: unknown) => { success: boolean } }, body: unknown) =>
  !schema.safeParse(body).success;

describe('batch provisioning request bodies', () => {
  it.each([-1, 0, 0.5, 1001, 'many'])('refuses batchSize %s', (batchSize) => {
    expect(refuses(EntraProvisionRequestSchema, { batchSize })).toBe(true);
  });

  it('takes a whole batchSize from 1 to 1000, as a number or a numeric string', () => {
    expect(EntraProvisionRequestSchema.parse({ batchSize: 1 }).batchSize).toBe(1);
    expect(EntraProvisionRequestSchema.parse({ batchSize: '1000' }).batchSize).toBe(1000);
    expect(EntraProvisionRequestSchema.parse({}).batchSize).toBeUndefined();
  });

  it('reads continueOnError "false" as false', () => {
    expect(EntraProvisionRequestSchema.parse({ continueOnError: 'false' }).continueOnError).toBe(
      false,
    );
    expect(EntraProvisionRequestSchema.parse({ continueOnError: 'true' }).continueOnError).toBe(
      true,
    );
    expect(EntraProvisionRequestSchema.parse({ continueOnError: false }).continueOnError).toBe(
      false,
    );
    expect(refuses(EntraProvisionRequestSchema, { continueOnError: 'maybe' })).toBe(true);
  });

  it.each([0, -5, 2.5, 1e9])('refuses a seed count of %s', (count) => {
    expect(refuses(SeedRequestSchema, { count })).toBe(true);
  });

  it('takes a seed count up to 10000', () => {
    expect(SeedRequestSchema.parse({ count: '10000' }).count).toBe(10000);
  });
});
