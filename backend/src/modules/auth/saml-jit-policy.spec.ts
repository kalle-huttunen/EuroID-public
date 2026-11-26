/**
 * The tenant and role of an admin SAML creates on a first sign-in (saml-jit-policy.ts). The IdP
 * names them through SAML_TENANT_ATTR and SAML_ROLE_ATTR, and an IdP admin of one tenant must not
 * place a super-admin in another tenant, or in a tenant that does not exist (which would count
 * as active).
 */
import { UnauthorizedException } from '@nestjs/common';
import { jitRole, jitTenant, samlJitConfig } from './saml-jit-policy';

const logger = { error: jest.fn(), warn: jest.fn() };
const configOf = (env: Record<string, string | undefined>) =>
  samlJitConfig((key) => env[key], logger);

describe('SAML JIT policy', () => {
  afterEach(() => jest.clearAllMocks());

  describe('the role', () => {
    it('is never super-admin, whatever the IdP asserts', () => {
      const config = configOf({ SAML_JIT_MAX_ROLE: 'connector-admin' });

      expect(jitRole('super-admin', config)).toBe('connector-admin');
    });

    it('is capped at viewer, the lowest console role, by default', () => {
      const config = configOf({});

      expect(jitRole('super-admin', config)).toBe('viewer');
      expect(jitRole('operator', config)).toBe('viewer');
      expect(jitRole(undefined, config)).toBe('viewer');
    });

    it('takes an asserted role the cap grants', () => {
      const config = configOf({ SAML_JIT_MAX_ROLE: 'connector-admin' });

      expect(jitRole('operator', config)).toBe('operator');
      expect(jitRole('connector-admin', config)).toBe('connector-admin');
    });

    it('takes what both grant for a role beside the cap (policy-admin under connector-admin)', () => {
      const config = configOf({ SAML_JIT_MAX_ROLE: 'connector-admin' });

      expect(jitRole('policy-admin', config)).toBe('operator');
    });

    it('caps SAML_DEFAULT_ROLE too', () => {
      const config = configOf({ SAML_DEFAULT_ROLE: 'super-admin', SAML_JIT_MAX_ROLE: 'operator' });

      expect(jitRole(undefined, config)).toBe('operator');
      expect(jitRole('not-a-role', config)).toBe('operator');
    });

    it('refuses super-admin as the cap and uses viewer, with an error logged', () => {
      const config = configOf({ SAML_JIT_MAX_ROLE: 'super-admin' });

      expect(jitRole('super-admin', config)).toBe('viewer');
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('SAML_JIT_MAX_ROLE'));
    });
  });

  describe('the tenant', () => {
    const tenants: Record<string, { status: string }> = {
      'tenant-a': { status: 'active' },
      'tenant-b': { status: 'active' },
      'tenant-s': { status: 'suspended' },
    };
    const find = async (id: string) => tenants[id] ?? null;

    it('is the default tenant when the assertion names none', async () => {
      const config = configOf({ SAML_DEFAULT_TENANT_ID: 'tenant-a' });

      await expect(jitTenant(undefined, config, find)).resolves.toBe('tenant-a');
    });

    it('accepts the default tenant without a tenants document (a single-tenant deployment)', async () => {
      const config = configOf({ SAML_DEFAULT_TENANT_ID: 'single' });

      await expect(jitTenant('single', config, find)).resolves.toBe('single');
    });

    it('refuses another tenant when no allow-list is set: only the default tenant', async () => {
      const config = configOf({ SAML_DEFAULT_TENANT_ID: 'tenant-a' });

      await expect(jitTenant('tenant-b', config, find)).rejects.toThrow(UnauthorizedException);
    });

    it('accepts an allow-listed tenant that exists and is active', async () => {
      const config = configOf({
        SAML_DEFAULT_TENANT_ID: 'tenant-a',
        SAML_ALLOWED_TENANT_IDS: 'tenant-b, tenant-s,ghost',
      });

      await expect(jitTenant('tenant-b', config, find)).resolves.toBe('tenant-b');
    });

    it.each([
      ['not on the allow-list', 'tenant-c'],
      ['allow-listed but not a tenant', 'ghost'],
      ['allow-listed but suspended', 'tenant-s'],
    ])('refuses a tenant %s', async (_case, tenantId) => {
      const config = configOf({
        SAML_DEFAULT_TENANT_ID: 'tenant-a',
        SAML_ALLOWED_TENANT_IDS: 'tenant-b,tenant-s,ghost',
      });

      await expect(jitTenant(tenantId, config, find)).rejects.toThrow(UnauthorizedException);
    });

    it('refuses the default tenant when its tenants document is suspended', async () => {
      const config = configOf({ SAML_DEFAULT_TENANT_ID: 'tenant-s' });

      await expect(jitTenant(undefined, config, find)).rejects.toThrow(UnauthorizedException);
    });
  });
});
