/**
 * Role bundles: create, edit, duplicate and delete need policy-admin (role-bundles.controller.ts).
 * 08 F8: every role was offered them, and the API answered 403.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, mockAuthValue } from '../../../test/test-utils';
import { RoleBundleManager } from '../RoleBundleManager';
import { BRAND } from '../../../theme';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: vi.fn(),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

const bundle = {
  id: 'b1',
  name: 'Finance bundle',
  description: 'Finance access',
  icon: 'UserOutlined',
  color: BRAND.primary,
  actions: [],
  inheritance: [],
  tags: [],
  usedByPolicies: 0,
};

const asRole = (role: string) => ({
  ...mockAuthValue,
  user: { ...mockAuthValue.user, profile: { ...mockAuthValue.user.profile, roles: [role] } },
});

beforeEach(() => {
  mockGet
    .mockReset()
    .mockImplementation((url: string) =>
      url.endsWith('/role-bundles')
        ? Promise.resolve({ data: [bundle], headers: {} })
        : Promise.resolve({ data: { entitlements: [] }, headers: {} }),
    );
});

describe('RoleBundleManager role gate', () => {
  it('shows an operator the bundles without New, Edit, Duplicate or Delete', async () => {
    renderWithProviders(<RoleBundleManager onApplyBundle={vi.fn()} />, {
      authValue: asRole('operator'),
    });

    expect(await screen.findByText('Finance bundle')).toBeInTheDocument();
    for (const name of [
      /New Bundle/,
      /Edit role bundle/,
      /Duplicate role bundle/,
      /Delete role bundle/,
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('offers a policy admin every bundle action', async () => {
    renderWithProviders(<RoleBundleManager onApplyBundle={vi.fn()} />, {
      authValue: asRole('policy-admin'),
    });

    expect(await screen.findByText('Finance bundle')).toBeInTheDocument();
    for (const name of [
      /New Bundle/,
      /Edit role bundle/,
      /Duplicate role bundle/,
      /Delete role bundle/,
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });
});

// r2-08 N4: a refused save, duplicate or delete showed nothing; the card stayed silently.
describe('RoleBundleManager refused changes', () => {
  it("shows the API's reason when a delete is refused", async () => {
    mockDelete.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { message: 'Bundle is used by 2 policies' } },
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<RoleBundleManager onApplyBundle={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /Delete role bundle/ }));
    const confirm = await screen.findByRole('tooltip');
    await user.click(within(confirm).getByRole('button', { name: 'OK' }));

    expect(
      await screen.findByText('Could not delete the bundle: Bundle is used by 2 policies'),
    ).toBeInTheDocument();
  });
});
