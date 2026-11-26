/**
 * Shared fixtures of the GdprPage tests, split by subject into GdprPage*.test.tsx. Each test file
 * mocks `@api/data` with the request mocks below and `usePermission` itself (vi.mock is hoisted
 * per file). The responses are shaped as the backend answers them: GET /identity flattens the
 * profile next to `_id`; the GDPR routes take that `_id`.
 */
import { expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import type {
  IConsent,
  IConsentReport,
  IDsarExportPackage,
  IErasureAttestation,
} from '../../../interfaces';

export const mockGet = vi.fn();
export const mockPost = vi.fn();
export const mockDelete = vi.fn();

export const ADA_ID = '64b7f0c2a1b2c3d4e5f60a01';
export const BOB_ID = '64b7f0c2a1b2c3d4e5f60a02';
export const ADA_EMAIL = 'ada.virtanen@corp.example';
export const ADA_LABEL = `Ada Virtanen (${ADA_EMAIL})`;

/** As GET /identity lists them (profile fields flattened, PII fields masked). */
export const ada = {
  _id: ADA_ID,
  firstName: 'Ada',
  lastName: 'Virtanen',
  email: ADA_EMAIL,
  mobilePhone: '+358 •• ••• 4567',
  departmentName: 'Finance',
  status: 'active',
  metadata: { sourceSystem: 'csv-hr' },
  tenantId: 'tenant-a',
};
export const bob = {
  ...ada,
  _id: BOB_ID,
  firstName: 'Bob',
  lastName: 'Laine',
  email: 'bob.laine@corp.example',
};
export const LEO_ID = '64b7f0c2a1b2c3d4e5f60a03';
export const LEO_LABEL = 'Leo Lahti (leo.lahti@corp.example), offboarded';
/** Offboarded: listed only with includeDeleted=true, carrying its deletedAt. */
export const leo = {
  ...ada,
  _id: LEO_ID,
  firstName: 'Leo',
  lastName: 'Lahti',
  email: 'leo.lahti@corp.example',
  deletedAt: '2026-10-01T08:00:00.000Z',
};

/** As GET /identity/:id/consent lists them (lean documents, sorted by purpose). */
export const analytics: IConsent = {
  _id: '64b7f0c2a1b2c3d4e5f60b01',
  identityId: ADA_ID,
  purpose: 'product analytics',
  status: 'granted',
  grantedAt: '2026-10-01T08:00:00.000Z',
  grantedBy: 'operator@corp.example',
  method: 'web-form',
  expiresAt: '2099-12-31T12:00:00.000Z',
  tenantId: 'tenant-a',
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
};
export const marketing: IConsent = {
  _id: '64b7f0c2a1b2c3d4e5f60b02',
  identityId: ADA_ID,
  purpose: 'marketing',
  status: 'revoked',
  grantedAt: '2026-03-01T08:00:00.000Z',
  revokedAt: '2026-09-15T12:00:00.000Z',
  grantedBy: 'operator@corp.example',
  method: 'email',
  tenantId: 'tenant-a',
};
/** Granted with an expiry date in the past: nothing in the backend expires it. */
export const newsletter: IConsent = {
  _id: '64b7f0c2a1b2c3d4e5f60b03',
  identityId: ADA_ID,
  purpose: 'newsletter',
  status: 'granted',
  grantedAt: '2025-01-10T08:00:00.000Z',
  grantedBy: 'operator@corp.example',
  expiresAt: '2025-06-30T12:00:00.000Z',
  tenantId: 'tenant-a',
};

export const report: IConsentReport = {
  tenantId: 'tenant-a',
  totalIdentities: 2,
  byPurpose: [
    { purpose: 'product analytics', granted: 2, revoked: 0, expired: 0 },
    { purpose: 'marketing', granted: 0, revoked: 1, expired: 0 },
  ],
};

/** Ada's linked admin identity, erased with her. */
export const ADA_ADMIN_ID = '64b7f0c2a1b2c3d4e5f60c21';

/** DELETE /identity/:id/gdpr-erase?dryRun=true */
export const preview: IErasureAttestation = {
  erasedAt: '2026-11-24T10:00:00.000Z',
  erasedBy: 'dpo@corp.example',
  identityId: ADA_ID,
  collectionsAffected: [
    'identities',
    'user_events',
    'audit_events',
    'review_items',
    'outbox_events',
  ],
  documentCounts: {
    identities: 1,
    user_events: 42,
    audit_events: 15,
    review_items: 3,
    review_exclusions: 0,
    outbox_events: 2,
    consents: 3,
    agent_identities: 1,
    access_graph: 1,
    elasticsearch_audit_events: 12,
  },
  dryRun: true,
  notReached: [],
  linkedAdminIdentities: [
    {
      identityId: ADA_ADMIN_ID,
      adminTier: 'TIER_0',
      collectionsAffected: ['identities', 'user_events'],
      documentCounts: { identities: 1, user_events: 4, access_graph: 1 },
      notReached: [],
    },
  ],
};
/**
 * DELETE /identity/:id/gdpr-erase with X-Confirm-Erasure: true: the same counts as the preview
 * (the preview's own audit entry is kept, so it is not counted).
 */
export const attestation: IErasureAttestation = {
  ...preview,
  erasedAt: '2026-11-24T10:05:00.000Z',
  dryRun: false,
};

/** Clear values only the export carries (the identity list masks the phone). */
export const ADA_PHONE = '+358 40 123 4567';
export const ADA_PERSONAL_EMAIL = 'ada.private@mail.example';

/** GET /identity/:id/dsar-export: unmasked, the person's own data. */
export const dsarPackage: IDsarExportPackage = {
  exportedAt: '2026-11-24T10:15:30.000Z',
  exportedBy: 'operator@corp.example',
  dataSubjectId: ADA_ID,
  identity: {
    _id: ADA_ID,
    tenantId: 'tenant-a',
    profile: {
      firstName: 'Ada',
      lastName: 'Virtanen',
      email: ADA_EMAIL,
      personalEmail: ADA_PERSONAL_EMAIL,
      mobilePhone: ADA_PHONE,
    },
  },
  timeline: [
    { _id: 'ev1', userId: ADA_ID, type: 'identity.created' },
    { _id: 'ev2', userId: ADA_ID, type: 'identity.updated' },
  ],
  auditTrail: [{ _id: 'au1', resourceId: ADA_ID, action: 'IDENTITY_UPDATED' }],
  accessReviews: [],
  accessReviewExclusions: [{ _id: 'ex1', identityId: ADA_ID, entitlementName: 'SG-Sales' }],
  entitlements: [{ _id: 'en1' }, { _id: 'en2' }, { _id: 'en3' }],
  consents: [
    { purpose: 'analytics', status: 'granted', grantedAt: '2026-01-01T00:00:00.000Z' },
    { purpose: 'marketing', status: 'revoked', revokedAt: '2026-02-01T00:00:00.000Z' },
  ],
  // HX-G3: the erasure scope's other collections, and the linked admin identities
  records: {
    credential_inventory: [{ identityId: ADA_ID, targetSystem: 'entra-id' }],
    anomalies: [],
    access_requests: [{ requestId: 'r-1' }, { requestId: 'r-2' }],
  },
  linkedAdminIdentities: [{ identity: { _id: 'adm-1', adminTier: 'TIER_1' } }],
  attestation:
    'Generated per GDPR Article 15 — Right of Access and Article 20 — Right to Data Portability',
};

export const IDENTITY_LIST = /\/api\/v1\/identity$/;
export const CONSENTS = /\/identity\/([^/]+)\/consent$/;
export const REPORT = /\/identity\/compliance\/consent-report$/;
export const DSAR = /\/identity\/([^/]+)\/dsar-export$/;
export const ERASE = /\/identity\/([^/]+)\/gdpr-erase$/;

/** An axios error as the API answers a refusal. */
export const apiError = (status: number, message: string | string[]) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { statusCode: status, message } },
  });

type ListParams = { _start: number; _end: number; q?: string; includeDeleted?: string };
type Listed = { email: string; firstName: string; lastName: string; deletedAt?: string };

/** GET /identity as the backend answers it: every word of `q` in the email or a name. */
function listIdentities(all: unknown[], params: ListParams) {
  const words = (params.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (all as Listed[]).filter(
    (u) =>
      (params.includeDeleted === 'true' || !u.deletedAt) &&
      words.every((w) =>
        [u.email, u.firstName, u.lastName].some((f) => f.toLowerCase().includes(w)),
      ),
  );
  return {
    data: matches.slice(params._start, params._end),
    headers: { 'x-total-count': String(matches.length) },
  };
}

/** Serves the identity list, Ada's consents, the report, the export and the erasure. */
export function serve(
  opts: {
    identities?: unknown[];
    consents?: IConsent[];
  } = {},
) {
  const identities = opts.identities ?? [ada, bob, leo];
  const consents = opts.consents ?? [analytics, marketing, newsletter];
  mockGet.mockImplementation((url: string, config?: { params?: ListParams }) => {
    if (IDENTITY_LIST.test(url)) {
      return Promise.resolve(listIdentities(identities, config?.params ?? { _start: 0, _end: 50 }));
    }
    if (REPORT.test(url)) return Promise.resolve({ data: report });
    const consentsOf = CONSENTS.exec(url)?.[1];
    if (consentsOf) return Promise.resolve({ data: consentsOf === ADA_ID ? consents : [] });
    if (DSAR.test(url)) return Promise.resolve({ data: dsarPackage });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  mockPost.mockImplementation((_url: string, body: { purpose: string }) =>
    Promise.resolve({ data: { ...analytics, purpose: body.purpose } }),
  );
  mockDelete.mockImplementation(
    (
      url: string,
      config?: { params?: Record<string, string>; headers?: Record<string, string> },
    ) => {
      if (ERASE.test(url)) {
        return Promise.resolve({
          data: config?.params?.dryRun === 'true' ? preview : attestation,
        });
      }
      return Promise.resolve({ data: { ...analytics, status: 'revoked' } });
    },
  );
}

export const loads = (pattern: RegExp, mock = mockGet) =>
  mock.mock.calls.filter(([url]) => pattern.test(url as string)).length;

/** The params of the last identity list request. */
export function lastListParams(): ListParams | undefined {
  const calls = mockGet.mock.calls.filter(([url]) => IDENTITY_LIST.test(url as string));
  return (calls.at(-1)?.[1] as { params?: ListParams } | undefined)?.params;
}

/** Waits for a list to be requested again after an action. */
export async function expectReloaded(pattern: RegExp, before: number) {
  await waitFor(() => expect(loads(pattern)).toBeGreaterThan(before));
}

type User = ReturnType<typeof userEvent.setup>;

/** Picks a person by typing part of their name or email, as the backend search finds them. */
export async function pickPerson(user: User, search: string, label = ADA_LABEL) {
  await screen.findByText('Pick a person');
  await user.click(screen.getByRole('combobox', { name: 'Person' }));
  await user.paste(search);
  // The search goes to the backend after the typing pause.
  await waitFor(() => expect(lastListParams()?.q).toBe(search.trim()));
  const option = await waitFor(() => {
    const el = document.querySelector(`.ant-select-item-option[title="${label}"]`);
    if (!el) throw new Error(`option ${label} not rendered`);
    return el as HTMLElement;
  });
  await user.click(option);
}

/** A confirmation (App.useApp modal.confirm), found by its visible title. */
export async function confirmDialog(title: string): Promise<HTMLElement> {
  const heading = await screen.findByText(title, { selector: '.ant-modal-confirm-title' });
  return heading.closest('.ant-modal') as HTMLElement;
}

/** A page modal, found by its title. */
export async function modalTitled(title: string): Promise<HTMLElement> {
  const heading = await screen.findByText(title, { selector: '.ant-modal-title' });
  return heading.closest('.ant-modal') as HTMLElement;
}
