/**
 * Conflict resolution on the identity profile: Merge, Split and Dismiss each ask for confirmation
 * and only then post the chosen action for this identity. They used the static Modal.confirm,
 * which renders nothing under React 19, so none of them could run from the UI (2.0dh).
 *
 * A failed resolution stops loading at once: onError returned the toast, which React Query
 * awaited, so the buttons kept loading until the toast closed 3 s later (FOLLOWUPS 2026-11-25).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Form } from 'antd';
import { renderWithProviders } from '../../../../test/test-utils';
// The app's static toasts render under React 19 only with this (index.tsx imports it)
import '../../../../config/antd-react19';
import { UserProfileTab } from '../UserProfileTab';
import type { IStandardUserWithMeta } from '../user-detail.types';

const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

vi.mock('@api/reconciliation-api', () => ({
  fetchDrifts: vi.fn().mockResolvedValue([]),
  correctDrift: vi.fn(),
  reconciliationKeys: {
    drifts: (p?: object) => ['reconciliation', 'drifts', p],
    driftsPrefix: () => ['reconciliation', 'drifts'],
  },
}));

const ID = '64b7f0c2a1b2c3d4e5f60810';
const user = {
  _id: ID,
  email: 'maija.meikalainen@corp.example',
  firstName: 'Maija',
  lastName: 'Meikäläinen',
  status: 'ACTIVE',
  metadata: {
    requiresReview: true,
    conflictDetails: {
      matchedBy: 'email',
      matchedValue: 'maija.meikalainen@corp.example',
      existingSnapshot: { sourceName: 'Workday', firstName: 'Maija' },
      incomingSnapshot: { sourceName: 'CSV HR', firstName: 'Maija' },
    },
  },
} as unknown as IStandardUserWithMeta;

const onSave = vi.fn();

function ProfileTab() {
  const [form] = Form.useForm();
  return (
    <UserProfileTab
      user={user}
      form={form}
      identityId={ID}
      identityData={null}
      showSyncWarning={false}
      changedFields={[]}
      onFieldsChange={() => {}}
      onSave={onSave}
    />
  );
}

describe('UserProfileTab conflict resolution', () => {
  beforeEach(() => {
    mockPost.mockReset().mockResolvedValue({ data: {} });
    onSave.mockReset();
  });

  it.each([
    { action: 'merge', button: /Merge — Same Person$/, title: 'Merge — Same Person' },
    { action: 'split', button: /Split — Different People$/, title: 'Split — Different People' },
    { action: 'dismiss', button: /^Dismiss$/, title: 'Dismiss Conflict' },
  ])(
    'posts $action for this identity once its confirmation is accepted',
    // The form, card and dialog take a few seconds to render in jsdom.
    { timeout: 20_000 },
    async (c) => {
      const u = userEvent.setup();
      renderWithProviders(<ProfileTab />);

      await u.click(await screen.findByRole('button', { name: c.button }));
      // antd also puts the confirm's title in a hidden modal title; match the visible one.
      const dialog = (
        await screen.findByText(c.title, { selector: '.ant-modal-confirm-title' })
      ).closest('.ant-modal') as HTMLElement;
      expect(mockPost).not.toHaveBeenCalled();
      await u.click(within(dialog).getByRole('button', { name: 'Continue' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(`/api/v1/identity/${ID}/resolve-conflict`, {
          action: c.action,
        }),
      );
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    },
  );

  it(
    'shows the API message that says why a refused merge changed nothing',
    { timeout: 20_000 },
    async () => {
      // 2.0dj: a merge that cannot complete is a 409 whose message says what to do
      const reason =
        'The merge would give the kept identity a value another identity already has (email), ' +
        'so nothing was changed. Correct the email in the source record and try again.';
      mockPost.mockRejectedValue(
        Object.assign(new Error('Request failed with status code 409'), {
          response: { status: 409, data: { message: reason } },
        }),
      );
      const u = userEvent.setup();
      renderWithProviders(<ProfileTab />);

      await u.click(await screen.findByRole('button', { name: /Merge — Same Person$/ }));
      const dialog = (
        await screen.findByText('Merge — Same Person', { selector: '.ant-modal-confirm-title' })
      ).closest('.ant-modal') as HTMLElement;
      await u.click(within(dialog).getByRole('button', { name: 'Continue' }));

      const toast = await screen.findByText(reason);
      expect(onSave).not.toHaveBeenCalled();
      // The buttons are usable again while the toast still shows (it closes after 3 s)
      const merge = screen.getByRole('button', { name: /Merge — Same Person$/ });
      await waitFor(() => expect(merge).not.toHaveClass('ant-btn-loading'), { timeout: 2000 });
      expect(toast).toBeInTheDocument();
    },
  );
});
