import { ForbiddenException } from '@nestjs/common';
import { TenantStatusService, TENANT_INACTIVE_MESSAGE } from './tenant-status.service';

/** Which tenants may sign in, call the API and receive webhooks: a status other than active stops them. */
describe('TenantStatusService', () => {
  const statuses = new Map<string, string>();
  const findOne = jest.fn((filter: { tenantId: string }) => ({
    lean: () =>
      Promise.resolve(
        statuses.has(filter.tenantId) ? { status: statuses.get(filter.tenantId) } : null,
      ),
  }));
  const model = { findOne } as never;
  const savedTtl = process.env.TENANT_STATUS_CACHE_MS;

  beforeEach(() => {
    statuses.clear();
    findOne.mockClear();
    delete process.env.TENANT_STATUS_CACHE_MS;
  });

  afterAll(() => {
    process.env.TENANT_STATUS_CACHE_MS = savedTtl;
  });

  it('refuses a suspended and a deprovisioned tenant', async () => {
    statuses.set('acme', 'suspended');
    statuses.set('gone', 'deprovisioned');
    const service = new TenantStatusService(model);
    expect(await service.isActive('acme')).toBe(false);
    expect(await service.isActive('gone')).toBe(false);
    await expect(service.assertActive('acme')).rejects.toThrow(ForbiddenException);
    await expect(service.assertActive('acme')).rejects.toThrow(TENANT_INACTIVE_MESSAGE);
  });

  it('lets an active tenant and a tenant without a tenants document through', async () => {
    statuses.set('acme', 'active');
    const service = new TenantStatusService(model);
    expect(await service.isActive('acme')).toBe(true);
    // A single-tenant deployment has no tenants document for its DEFAULT_TENANT_ID.
    expect(await service.isActive('default')).toBe(true);
    await expect(service.assertActive('default')).resolves.toBeUndefined();
  });

  it('reads each tenant once per cache period, and forget() drops the cached status', async () => {
    statuses.set('acme', 'active');
    const service = new TenantStatusService(model);
    await service.isActive('acme');
    statuses.set('acme', 'suspended');
    expect(await service.isActive('acme')).toBe(true);
    expect(findOne).toHaveBeenCalledTimes(1);

    service.forget('acme');
    expect(await service.isActive('acme')).toBe(false);
    expect(findOne).toHaveBeenCalledTimes(2);
  });

  it('reads the database again once TENANT_STATUS_CACHE_MS has passed', async () => {
    process.env.TENANT_STATUS_CACHE_MS = '1000';
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      statuses.set('acme', 'active');
      const service = new TenantStatusService(model);
      await service.isActive('acme');
      statuses.set('acme', 'suspended');
      now.mockReturnValue(1_000_999);
      expect(await service.isActive('acme')).toBe(true);
      now.mockReturnValue(1_001_001);
      expect(await service.isActive('acme')).toBe(false);
    } finally {
      now.mockRestore();
    }
  });
});
