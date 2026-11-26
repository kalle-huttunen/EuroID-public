import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { RevocationCell, RevocationSummaryTags, RevokeReviewModal } from '../ReviewRevocation';
import type { ReviewItem } from '@api/intelligence-api';

const item = (overrides: Partial<ReviewItem> = {}): ReviewItem => ({
  itemId: 'item-1',
  campaignId: 'camp-1',
  identityId: 'id-1',
  identityEmail: 'ada@acme.test',
  identityName: 'Ada Lovelace',
  reviewerId: 'boss@acme.test',
  decision: 'revoked',
  entitlements: [{ system: 'ad', type: 'group', name: 'Finance', policyManaged: false }],
  ...overrides,
});

describe('RevocationCell', () => {
  it('shows what revoking did per entitlement, never "removed" for manual action', () => {
    renderWithProviders(
      <RevocationCell
        campaignStatus="COMPLETED"
        item={item({
          entitlements: [
            {
              system: 'ad',
              type: 'group',
              name: 'Finance',
              policyManaged: false,
              revocation: {
                outcome: 'removed',
                detail: 'removed from group',
                at: '2026-11-22T10:00:00Z',
              },
            },
            {
              system: 'entra-id',
              type: 'directory-role',
              name: 'Helpdesk',
              policyManaged: false,
              revocation: {
                outcome: 'manual-action-needed',
                reason: 'Remove the role assignment in Entra ID',
                at: '2026-11-22T10:00:00Z',
              },
            },
          ],
        })}
      />,
    );
    expect(screen.getByText('ad: Removed')).toBeInTheDocument();
    expect(screen.getByText('entra-id: Manual action needed')).toBeInTheDocument();
  });

  it('a revoked item without a result says when it will be removed, or that none was recorded', () => {
    const { unmount } = renderWithProviders(
      <RevocationCell item={item()} campaignStatus="ACTIVE" />,
    );
    expect(screen.getByText('Removed when the campaign closes')).toBeInTheDocument();
    unmount();
    renderWithProviders(<RevocationCell item={item()} campaignStatus="COMPLETED" />);
    expect(screen.getByText('No result recorded')).toBeInTheDocument();
  });

  it('an expired item keeps its access when the campaign does not auto-revoke', () => {
    renderWithProviders(
      <RevocationCell
        item={item({ decision: 'expired' })}
        campaignStatus="COMPLETED"
        autoRevokeOnExpiry={false}
      />,
    );
    expect(screen.getByText('Kept (auto-revoke off)')).toBeInTheDocument();
  });
});

describe('RevocationSummaryTags', () => {
  it('shows the counts per outcome', () => {
    renderWithProviders(
      <RevocationSummaryTags
        summary={{ removed: 3, alreadyGone: 1, manualActionNeeded: 2, failed: 1 }}
      />,
    );
    expect(screen.getByText('Removed: 3')).toBeInTheDocument();
    expect(screen.getByText('Manual action needed: 2')).toBeInTheDocument();
    expect(screen.getByText('Failed: 1')).toBeInTheDocument();
  });

  it('shows nothing when nothing was revoked', () => {
    renderWithProviders(<RevocationSummaryTags summary={undefined} />);
    expect(screen.queryByText('Revocations:')).not.toBeInTheDocument();
  });
});

describe('RevokeReviewModal', () => {
  it('requires a justification before revoking', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithProviders(
      <RevokeReviewModal item={item()} loading={false} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('A justification is required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Justification'), '  Left the finance team  ');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Left the finance team'));
  });

  it('says a group membership is removed from the group', () => {
    renderWithProviders(
      <RevokeReviewModal item={item()} loading={false} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/removes group memberships in Entra ID/)).toBeInTheDocument();
    expect(screen.queryByText(/removes the account itself/)).not.toBeInTheDocument();
  });

  it('says an account item removes the account itself, as offboarding does', () => {
    renderWithProviders(
      <RevokeReviewModal
        item={item({
          entitlements: [
            { system: 'github', type: 'account', name: 'Account', policyManaged: true },
          ],
        })}
        loading={false}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('github: Account')).toBeInTheDocument();
    expect(screen.getByText(/removes the account itself/)).toBeInTheDocument();
    expect(screen.queryByText(/removes group memberships in Entra ID/)).not.toBeInTheDocument();
  });
});
