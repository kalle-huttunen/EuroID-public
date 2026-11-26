import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PolicyDisplay } from '../PolicyDisplay';

const policyWithMultipleConditionsAndActions = {
  conditions: [
    { field: 'department', operator: 'equals', value: 'Sales' },
    { field: 'jobTitle', operator: 'contains', value: 'Manager' },
  ],
  actions: [
    {
      type: 'assign_group',
      target: 'entra-id',
      value: 'Sales-Team',
      params: { groupName: 'Sales-Team' },
    },
    {
      type: 'assign_license',
      target: 'entra-id',
      value: 'O365_E3',
      params: { licenseSku: 'O365_E3' },
    },
  ],
};

describe('PolicyDisplay', () => {
  it('default view: shows human-readable summary (Simple mode)', () => {
    render(
      <PolicyDisplay
        policy={{
          conditions: [{ field: 'department', operator: 'equals', value: 'Sales' }],
          actions: [{ type: 'assign_group', target: 'entra-id', value: 'Sales-Team', params: {} }],
        }}
      />,
    );
    expect(screen.getByText(/department is "Sales"/)).toBeInTheDocument();
    expect(screen.getByText(/assign_group Sales-Team in entra-id/)).toBeInTheDocument();
    expect(screen.getByText(/When/)).toBeInTheDocument();
    expect(screen.getByText(/then/)).toBeInTheDocument();
  });

  it('Simple mode: an action without a value names its type once', () => {
    render(
      <PolicyDisplay
        policy={{ conditions: [], actions: [{ type: 'assign_group', target: 'ad', value: '' }] }}
      />,
    );
    expect(screen.getByText(/assign_group in ad/)).toBeInTheDocument();
    expect(screen.queryByText(/assign_group assign_group/)).toBeNull();
  });

  it('Simple mode: uses the given names for action types and targets, Advanced keeps the ids', () => {
    render(
      <PolicyDisplay
        policy={{
          conditions: [],
          actions: [{ type: 'assign_group', target: 'ad', value: 'SG-Sales' }],
        }}
        labels={{
          actionType: (t) => (t === 'assign_group' ? 'Assign Group' : undefined),
          target: (t) => (t === 'ad' ? 'Active Directory' : undefined),
        }}
      />,
    );
    expect(screen.getByText(/Assign Group SG-Sales in Active Directory/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByText(/THEN assign_group ad=SG-Sales/)).toBeInTheDocument();
  });

  it('click "Advanced": shows rule syntax', () => {
    render(
      <PolicyDisplay
        policy={{
          conditions: [{ field: 'department', operator: 'equals', value: 'Sales' }],
          actions: [{ type: 'assign_group', target: 'entra-id', value: 'Sales-Team', params: {} }],
        }}
      />,
    );
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByText(/IF departmentequalsSales/)).toBeInTheDocument();
    expect(screen.getByText(/THEN/)).toBeInTheDocument();
  });

  it('click "Debug": shows raw JSON', () => {
    render(
      <PolicyDisplay
        policy={{
          conditions: [{ field: 'department', operator: 'equals', value: 'Sales' }],
          actions: [{ type: 'assign_group', target: 'entra-id', value: 'Sales-Team', params: {} }],
        }}
      />,
    );
    fireEvent.click(screen.getByText('Debug'));
    // Debug view shows raw JSON - policy has actions
    expect(screen.getByText(/"actions"/)).toBeInTheDocument();
    expect(screen.getByText(/"assign_group"/)).toBeInTheDocument();
  });

  it('handles policy with multiple conditions and actions', () => {
    render(<PolicyDisplay policy={policyWithMultipleConditionsAndActions} />);
    expect(screen.getByText(/department is "Sales"/)).toBeInTheDocument();
    expect(screen.getByText(/jobTitle is "Manager"/)).toBeInTheDocument();
    expect(screen.getByText(/assign_group Sales-Team in entra-id/)).toBeInTheDocument();
    expect(screen.getByText(/assign_license O365_E3 in entra-id/)).toBeInTheDocument();
  });
});
