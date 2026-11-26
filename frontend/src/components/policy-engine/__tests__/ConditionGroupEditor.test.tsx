import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { ConditionGroupEditor } from '../ConditionGroupEditor';

const mockConditionGroups = [
  {
    id: 'group-1',
    operator: 'AND',
    conditions: [
      {
        id: 'cond-1',
        field: 'department',
        operator: 'equals',
        value: 'Engineering',
      },
    ],
  },
];

const defaultProps = {
  conditionGroups: [],
  updateConditionGroup: vi.fn(),
  updateCondition: vi.fn(),
  addCondition: vi.fn(),
  removeCondition: vi.fn(),
};

describe('ConditionGroupEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders condition groups when provided', () => {
    renderWithProviders(
      <ConditionGroupEditor {...defaultProps} conditionGroups={mockConditionGroups as any} />,
    );

    // The condition reads "Department equals Engineering"; edits report the group and condition.
    expect(screen.getByText('Department')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('Engineering'), { target: { value: 'Sales' } });
    expect(defaultProps.updateCondition).toHaveBeenCalledWith('group-1', 'cond-1', {
      value: 'Sales',
    });
    fireEvent.click(screen.getByRole('button', { name: /add condition/i }));
    expect(defaultProps.addCondition).toHaveBeenCalledWith('group-1');
  });
});
