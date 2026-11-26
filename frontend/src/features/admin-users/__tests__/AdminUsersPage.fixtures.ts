/**
 * Shared fixtures of the AdminUsersPage tests, split by subject into AdminUsersPage*.test.tsx. Each
 * test file mocks `@api/data` with the request mocks below and `usePermission` itself (vi.mock is
 * hoisted per file).
 */
import { expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { mockAuthValue } from '../../../test/test-utils';
import type { IAdminInvite, IAdminUser, IPendingInvite } from '../../../interfaces';

export const mockGet = vi.fn();
export const mockPost = vi.fn();
export const mockPatch = vi.fn();
export const mockDelete = vi.fn();

export const ME_ID = '6741c0f2a9d3e5b1c2f40a01';

/** As GET /auth/users answers them (sorted by email). */
export const me: IAdminUser = {
  id: ME_ID,
  email: 'olivia@corp.example',
  name: 'Olivia Owner',
  role: 'super-admin',
  isActive: true,
  mfaEnabled: true,
  authSource: 'local',
  isPlatformAdmin: false,
  createdAt: '2026-11-01T08:00:00.000Z',
  lastLoginAt: '2026-11-22T09:15:00.000Z',
};
export const operator: IAdminUser = {
  id: '6741c0f2a9d3e5b1c2f40a02',
  email: 'oscar@corp.example',
  name: 'Oscar Operator',
  role: 'operator',
  isActive: true,
  mfaEnabled: false,
  authSource: 'local',
  isPlatformAdmin: false,
  createdAt: '2026-11-05T08:00:00.000Z',
  lastLoginAt: null,
};
export const ssoViewer: IAdminUser = {
  id: '6741c0f2a9d3e5b1c2f40a03',
  email: 'vera@corp.example',
  name: 'Vera Viewer',
  role: 'viewer',
  isActive: true,
  mfaEnabled: false,
  authSource: 'saml',
  isPlatformAdmin: false,
  createdAt: '2026-11-06T08:00:00.000Z',
  lastLoginAt: null,
};
export const left: IAdminUser = {
  id: '6741c0f2a9d3e5b1c2f40a04',
  email: 'lena@corp.example',
  name: 'Lena Left',
  role: 'policy-admin',
  isActive: false,
  mfaEnabled: false,
  authSource: 'local',
  isPlatformAdmin: false,
  createdAt: '2026-10-01T08:00:00.000Z',
  lastLoginAt: null,
};
export const platform: IAdminUser = {
  id: '6741c0f2a9d3e5b1c2f40a05',
  email: 'pat@corp.example',
  name: 'Pat Platform',
  role: 'super-admin',
  isActive: true,
  mfaEnabled: true,
  authSource: 'local',
  isPlatformAdmin: true,
  createdAt: '2026-09-01T08:00:00.000Z',
  lastLoginAt: '2026-11-20T07:00:00.000Z',
};

export const ALL = [left, me, operator, platform, ssoViewer];

/** As POST /auth/users/:id/password-reset answers it. */
export const RESET_CODE = {
  token: '7d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f',
  expiresAt: '2026-11-23T10:30:00.000Z',
};

/** As POST /auth/invites answers it. */
export const INVITE: IAdminInvite = {
  token: '9f2c4e6a8b0d1f3e5a7c9b1d3f5e7a9c0b2d4f6e8a1c3e5b7d9f1a3c5e7b9d1f',
  expiresAt: '2026-11-26T10:00:00.000Z',
};

/** As GET /auth/invites answers them (newest first): no code. */
export const PENDING: IPendingInvite[] = [
  {
    id: '6741c0f2a9d3e5b1c2f40b01',
    email: 'nina@corp.example',
    role: 'policy-admin',
    createdBy: ME_ID,
    createdAt: '2026-11-23T08:00:00.000Z',
    expiresAt: '2026-11-26T08:00:00.000Z',
  },
  {
    id: '6741c0f2a9d3e5b1c2f40b02',
    email: 'sam@corp.example',
    role: 'viewer',
    createdBy: 'auth0|5f7c8ec7c33c6c004bbafe82',
    createdAt: '2026-11-22T08:00:00.000Z',
    expiresAt: '2026-11-25T08:00:00.000Z',
  },
];

export const LIST = /\/auth\/users$/;
export const INVITES = /\/auth\/invites$/;

/** Signed in as `me`: the page tells your own row from the others by the token's sub. */
export const asMe = {
  authValue: {
    ...mockAuthValue,
    user: { ...mockAuthValue.user, profile: { ...mockAuthValue.user.profile, sub: ME_ID } },
  },
};

export function serve(admins: IAdminUser[] = ALL, pending: IPendingInvite[] = PENDING) {
  mockGet.mockImplementation((url: string) => {
    if (LIST.test(url)) return Promise.resolve({ data: admins });
    if (INVITES.test(url)) return Promise.resolve({ data: pending });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  mockPost.mockImplementation((url: string) =>
    Promise.resolve({
      data: INVITES.test(url)
        ? INVITE
        : /\/password-reset$/.test(url)
          ? RESET_CODE
          : { success: true },
    }),
  );
  mockPatch.mockResolvedValue({ data: {} });
  mockDelete.mockResolvedValue({ data: { success: true } });
}

export const listLoads = () =>
  mockGet.mock.calls.filter(([url]) => LIST.test(url as string)).length;
export const inviteLoads = () =>
  mockGet.mock.calls.filter(([url]) => INVITES.test(url as string)).length;

/** Waits for the list to be requested again after an action. */
export async function expectListReloaded(before: number) {
  await waitFor(() => expect(listLoads()).toBeGreaterThan(before));
}

/** A confirmation (App.useApp modal.confirm), found by its visible title. */
export async function confirmDialog(title: string): Promise<HTMLElement> {
  const heading = await screen.findByText(title, { selector: '.ant-modal-confirm-title' });
  return heading.closest('.ant-modal') as HTMLElement;
}

/** The invite modal, found by its title. */
export async function formModal(title: string): Promise<HTMLElement> {
  const heading = await screen.findByText(title, { selector: '.ant-modal-title' });
  return heading.closest('.ant-modal') as HTMLElement;
}

export const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
export const invitesRegion = () => screen.getByRole('region', { name: 'Pending invites' });
