import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { PolicyEditor } from '../PolicyEditor';
import type { Policy } from '../types';

vi.mock('@api/resource-hooks', () => ({
  useList: vi.fn().mockReturnValue({
    data: { data: [], total: 0 },
    isLoading: false,
  }),
}));

vi.mock('../hooks/usePolicyCatalog', () => ({
  usePolicyCatalog: vi.fn().mockReturnValue({
    catalogGroups: [],
    catalogRoles: [],
    resolvedBundleActions: [],
    fetchCatalog: vi.fn(),
    fetchCatalogRoles: vi.fn(),
  }),
}));

// The actions section loads the connector catalogs; the policy's actions pass through unchanged.
vi.mock('../PolicyActionsSection', () => ({
  PolicyActionsSection: () => <div data-testid="policy-actions">PolicyActionsSection</div>,
}));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn(),
  },
}));

const POLICY: Policy = {
  id: 'policy-1',
  name: 'Engineering access',
  description: 'Tools every engineer gets',
  status: 'active',
  priority: 2,
  risk: 'Medium',
  conditionGroups: [
    {
      id: 'group-1',
      join: 'AND',
      conditions: [{ id: 'cond-1', field: 'department', operator: 'equals', value: 'Engineering' }],
    },
  ],
  actions: [
    { id: 'action-1', type: 'assign_group', target: 'entra-id', params: { groupId: 'g-eng' } },
  ],
  createdBy: 'admin@euroid.local',
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-01T08:00:00.000Z',
};

const defaultProps = {
  policy: null,
  onSave: vi.fn(),
  onCancel: vi.fn(),
  onPreview: vi.fn(),
};

describe('PolicyEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves the policy it edits with the change made in the condition builder', () => {
    renderWithProviders(<PolicyEditor {...defaultProps} policy={POLICY} />);

    // An edit in the condition builder reaches the saved policy; the rest is the policy as given.
    fireEvent.change(screen.getByDisplayValue('Engineering'), { target: { value: 'Sales' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(defaultProps.onSave).toHaveBeenCalledTimes(1);
    expect(defaultProps.onSave).toHaveBeenCalledWith({
      ...POLICY,
      conditionGroups: [
        {
          ...POLICY.conditionGroups[0],
          conditions: [{ ...POLICY.conditionGroups[0].conditions[0], value: 'Sales' }],
        },
      ],
    });
    expect(defaultProps.onCancel).not.toHaveBeenCalled();
  });

  it('does not create a new policy without a name and an action; Cancel saves nothing', () => {
    renderWithProviders(<PolicyEditor {...defaultProps} />);

    expect(screen.getByRole('button', { name: /create policy/i })).toBeDisabled();
    expect(
      screen.getByText(
        /Add a policy name, and at least one action or a linked role bundle to save/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
    expect(defaultProps.onSave).not.toHaveBeenCalled();
  });
});
