/**
 * Shared fixtures of the CredentialLifecyclePage tests. Rows follow what the API answers: lean
 * `credential_inventory` documents (`_id`, the identity's `_id` as `identityId`, `password`, `mfa`,
 * `observedAt`, `certificates`, timestamps, `__v`) and lean `credential_policies` documents (the
 * PATCH and DELETE routes take `_id`). Dates are relative to now, so "Overdue by 3 days" holds on
 * any day. Each test file mocks `@api/data` with the request mocks below and `usePermission`.
 */
import { createElement } from 'react';
import { screen } from '@testing-library/react';
import { vi } from 'vitest';
import { ConfigProvider } from 'antd';
import dayjs from 'dayjs';
import { renderWithProviders } from '../../../test/test-utils';
import { CredentialLifecyclePage } from '../CredentialLifecyclePage';
import type {
  ICredentialCompliance,
  ICredentialPolicy,
  ICredentialRecord,
} from '../../../interfaces';

export const mockGet = vi.fn();
export const mockPost = vi.fn();
export const mockPatch = vi.fn();
export const mockDelete = vi.fn();

const at = (days: number) => dayjs().add(days, 'day').toISOString();
const CHECKED = dayjs().startOf('day').add(3, 'hour').toISOString();

export const SVC_ID = '64b7f0c2a1b2c3d4e5f60111';
export const ADA_ID = '64b7f0c2a1b2c3d4e5f60112';

/** A service account's AD password, due three days ago. */
export const overdueAd: ICredentialRecord & { __v: number; certificates: unknown[] } = {
  _id: '64b7f0c2a1b2c3d4e5f60901',
  tenantId: 'tenant-a',
  identityId: SVC_ID,
  targetSystem: 'ad',
  externalId: 'CN=svc-backup,OU=Service,DC=corp,DC=local',
  password: { lastRotated: at(-93), nextRotation: at(-3), status: 'EXPIRED', rotationCount: 0 },
  certificates: [],
  observedAt: CHECKED,
  createdAt: at(-30),
  updatedAt: CHECKED,
  __v: 0,
};

/** A person's Entra ID password, due in 10 days, MFA registered. */
export const soonEntra: ICredentialRecord & { __v: number; certificates: unknown[] } = {
  _id: '64b7f0c2a1b2c3d4e5f60902',
  tenantId: 'tenant-a',
  identityId: ADA_ID,
  targetSystem: 'entra-id',
  externalId: '0f6c1b9e-6d1a-4c55-9a3e-2f1d7a8b9c01',
  password: {
    lastRotated: at(-80),
    nextRotation: at(10),
    status: 'EXPIRING_SOON',
    rotationCount: 0,
  },
  mfa: { enrolled: true, methods: ['FIDO2', 'TOTP'] },
  certificates: [],
  observedAt: CHECKED,
  createdAt: at(-30),
  updatedAt: CHECKED,
  __v: 0,
};

/** An AD account the nightly check could not judge. */
export const unknownAd: ICredentialRecord & { __v: number; certificates: unknown[] } = {
  _id: '64b7f0c2a1b2c3d4e5f60903',
  tenantId: 'tenant-a',
  identityId: ADA_ID,
  targetSystem: 'ad',
  externalId: 'CN=Ada Lovelace,OU=Staff,DC=corp,DC=local',
  password: {
    status: 'UNKNOWN',
    rotationCount: 0,
    statusReason: 'Active Directory is not configured for this tenant',
  },
  certificates: [],
  observedAt: CHECKED,
  createdAt: at(-30),
  updatedAt: CHECKED,
  __v: 0,
};

export const COMPLIANCE: ICredentialCompliance = {
  compliant: 40,
  expiringSoon: 3,
  expired: 2,
  unknown: 5,
  total: 50,
};

/**
 * A settings object as the API returns it for a policy stored before 2026-11-25: the tenant plugin
 * stamped `tenantId` on every subdocument too, and the update schema refuses that key.
 */
const stamped = <T extends object>(settings: T): T => ({ ...settings, tenantId: 'tenant-a' });

export const standardPolicy: ICredentialPolicy & { __v: number } = {
  _id: '64b7f0c2a1b2c3d4e5f60a01',
  tenantId: 'tenant-a',
  name: 'Standard',
  description: 'Everyone else',
  targetScope: { connectorTypes: [], employmentTypes: [], entitlementTiers: [] },
  passwordPolicy: { maxAgeDays: 90, minLength: 16, requireComplexity: true, preventReuse: 5 },
  rotationPolicy: { enabled: false, intervalDays: 90, notifyDaysBefore: 14, vaultStorage: false },
  mfaRequirement: { required: false, methods: [], gracePeriodDays: 14 },
  isActive: true,
  createdAt: at(-60),
  updatedAt: at(-60),
  __v: 0,
};

export const servicePolicy: ICredentialPolicy & { __v: number } = {
  _id: '64b7f0c2a1b2c3d4e5f60a02',
  tenantId: 'tenant-a',
  name: 'AD service accounts',
  targetScope: stamped({
    connectorTypes: ['ad'],
    employmentTypes: ['SERVICE_ACCOUNT'],
    entitlementTiers: [],
  }),
  passwordPolicy: stamped({
    maxAgeDays: 365,
    minLength: 24,
    requireComplexity: true,
    preventReuse: 10,
  }),
  rotationPolicy: stamped({
    enabled: false,
    intervalDays: 365,
    notifyDaysBefore: 30,
    vaultStorage: false,
  }),
  isActive: false,
  createdAt: at(-20),
  updatedAt: at(-20),
  __v: 0,
};

export const EXPIRING = /\/credential-lifecycle\/expiring$/;
export const BY_STATUS = /\/credential-lifecycle\/inventory$/;
export const COMPLIANCE_URL = /\/credential-lifecycle\/compliance$/;
export const POLICIES = /\/credential-lifecycle\/policies$/;
export const ONE_POLICY = (id: string) => new RegExp(`/credential-lifecycle/policies/${id}$`);

interface Data {
  due?: ICredentialRecord[];
  unknown?: ICredentialRecord[];
  policies?: ICredentialPolicy[];
}

export function serve({
  due = [overdueAd, soonEntra],
  unknown = [unknownAd],
  policies = [standardPolicy, servicePolicy],
}: Data = {}) {
  mockGet.mockImplementation((url: string) => {
    if (EXPIRING.test(url)) return Promise.resolve({ data: due });
    if (BY_STATUS.test(url)) return Promise.resolve({ data: unknown });
    if (COMPLIANCE_URL.test(url)) return Promise.resolve({ data: COMPLIANCE });
    if (POLICIES.test(url)) return Promise.resolve({ data: policies });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  mockPost.mockImplementation((_url: string, body: Record<string, unknown>) =>
    Promise.resolve({ data: { ...body, _id: '64b7f0c2a1b2c3d4e5f60a99', tenantId: 'tenant-a' } }),
  );
  mockPatch.mockResolvedValue({ data: standardPolicy });
  mockDelete.mockResolvedValue({ data: { deleted: true } });
}

export const callsTo = (pattern: RegExp) =>
  mockGet.mock.calls.filter(([url]) => pattern.test(url as string));

export function renderPage(initialRoute = '/credentials') {
  return renderWithProviders(
    // Without virtual scrolling, so jsdom renders every option of a dropdown.
    createElement(ConfigProvider, { virtual: false }, createElement(CredentialLifecyclePage)),
    { initialRoute },
  );
}

/** An API refusal as axios rejects it. */
export function apiError(status: number, message: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { statusCode: status, message } },
  });
}

/**
 * A dialog found by its title text. A confirmation from App.useApp shows its title twice in the
 * same dialog, so the first match is used.
 */
export async function dialog(title: string | RegExp): Promise<HTMLElement> {
  const [heading] = await screen.findAllByText(title);
  return heading.closest('[role="dialog"]') as HTMLElement;
}
