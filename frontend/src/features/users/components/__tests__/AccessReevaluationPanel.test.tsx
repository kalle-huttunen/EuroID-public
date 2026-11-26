/**
 * "Re-evaluate access": the preview comes first and is read-only (a GET, nothing posted), shows
 * what changed since access was last applied and the entitlements to add and remove; only an
 * operator can confirm, which posts the re-evaluation once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../../../test/test-utils';
import { AccessReevaluationPanel } from '../AccessReevaluationPanel';
import { usePermission } from '../../../../auth/usePermission';
import type { IAccessPreview } from '../../../../interfaces';
import { API_BASE } from '@api/constants';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));
vi.mock('../../../../auth/usePermission', () => ({ usePermission: vi.fn() }));

const ID = '64b7f0c2a1b2c3d4e5f60720';

const preview = (over: Partial<IAccessPreview> = {}): IAccessPreview => ({
  identityId: ID,
  baselineRecordedAt: '2026-11-01T08:00:00.000Z',
  changes: [{ field: 'departmentName', before: 'Sales', after: 'Engineering' }],
  toAdd: [
    { type: 'group', target: 'entra-id', targetId: 'g-eng', appliedByMover: true },
    { type: 'group', target: 'okta', targetId: 'okta-eng', appliedByMover: false },
  ],
  toRemove: [{ type: 'group', target: 'entra-id', targetId: 'g-sales', appliedByMover: true }],
  provisionedTargets: ['entra-id', 'okta'],
  canReevaluate: true,
  ...over,
});

/** The button that opens the preview (before the modal adds its own). */
const trigger = () => screen.getByRole('button', { name: /re-evaluate access/i });

async function openPreview(data: IAccessPreview) {
  mockGet.mockResolvedValue({ data });
  renderWithProviders(<AccessReevaluationPanel identityId={ID} />);
  fireEvent.click(trigger());
  await screen.findByText('Would add');
}

function modalOk(): HTMLButtonElement {
  const buttons = screen.getAllByRole('button', { name: /re-evaluate access/i });
  return buttons[buttons.length - 1] as HTMLButtonElement;
}

describe('AccessReevaluationPanel', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    vi.mocked(usePermission).mockReturnValue(true);
  });

  it('loads nothing until opened, then shows the preview without posting anything', async () => {
    mockGet.mockResolvedValue({ data: preview() });
    renderWithProviders(<AccessReevaluationPanel identityId={ID} />);
    expect(mockGet).not.toHaveBeenCalled();

    fireEvent.click(trigger());
    await screen.findByText('Would add');

    expect(mockGet).toHaveBeenCalledWith(`${API_BASE}/identity/${ID}/access/preview`);
    expect(screen.getByText('departmentName')).toBeInTheDocument();
    expect(screen.getByText(/Sales → Engineering/)).toBeInTheDocument();
    expect(screen.getByText('Would remove')).toBeInTheDocument();
    expect(screen.getByText(/Not applied: okta-eng \(okta\)/)).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('an operator confirms and the re-evaluation is posted once', async () => {
    await openPreview(preview());
    mockPost.mockResolvedValue({ data: { workflowId: 'wf-1', changedFields: ['departmentName'] } });

    fireEvent.click(modalOk());

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledWith(`${API_BASE}/identity/${ID}/access/re-evaluate`, {});
  });

  it('a viewer sees the preview but cannot confirm', async () => {
    vi.mocked(usePermission).mockReturnValue(false);
    await openPreview(preview());

    expect(modalOk()).toBeDisabled();
    expect(screen.getByText(/requires the operator role/)).toBeInTheDocument();
  });

  it('without a baseline it says why and cannot confirm', async () => {
    mockGet.mockResolvedValue({
      data: preview({
        baselineRecordedAt: null,
        changes: [],
        toAdd: [],
        toRemove: [],
        canReevaluate: false,
        blockedReason: 'EuroID has no record of the attributes ... cannot tell what to remove.',
      }),
    });
    renderWithProviders(<AccessReevaluationPanel identityId={ID} />);
    fireEvent.click(trigger());

    expect(await screen.findByText(/cannot tell what to remove/)).toBeInTheDocument();
    expect(modalOk()).toBeDisabled();
  });
});
