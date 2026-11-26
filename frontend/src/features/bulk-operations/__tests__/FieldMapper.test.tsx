import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FieldMapper } from '../FieldMapper';

describe('FieldMapper target systems', () => {
  it('offers only targets bulk provisioning can execute', () => {
    render(
      <FieldMapper
        parsedCsv={{ headers: ['email'], rows: [['a@example.com']], raw: 'email\na@example.com' }}
        mapping={{ email: 'email' }}
        onMappingChange={vi.fn()}
        operationType="CREATE"
        onOperationTypeChange={vi.fn()}
        targetSystems={[]}
        onTargetSystemsChange={vi.fn()}
      />,
    );

    const offered = screen.getAllByRole('checkbox').map((cb) => cb.closest('label')?.textContent);
    expect(offered.sort()).toEqual([
      'Discord Webhook',
      'File Outbound',
      'GitHub',
      'Google Sheets',
      'Microsoft Entra ID',
    ]);
  });
});

// Hunt 2026-11-25 08 F1: the auto-map took the first field whose name the column contains, so
// managerEmail and personalEmail columns mapped to the user's email and overwrote it
describe('FieldMapper auto-map', () => {
  const renderWith = (headers: string[], mapping: Record<string, string>) => {
    const onMappingChange = vi.fn();
    render(
      <FieldMapper
        parsedCsv={{ headers, rows: [], raw: headers.join(',') }}
        mapping={mapping}
        onMappingChange={onMappingChange}
        operationType="CREATE"
        onOperationTypeChange={vi.fn()}
        targetSystems={[]}
        onTargetSystemsChange={vi.fn()}
      />,
    );
    return onMappingChange;
  };

  it('maps a column to the field it names exactly, before one whose name it only contains', () => {
    const onMappingChange = renderWith(
      ['managerEmail', 'Email', 'Personal Email', 'work_email', 'Manager Email Address'],
      {},
    );

    expect(onMappingChange).toHaveBeenCalledWith({
      managerEmail: 'managerEmail',
      Email: 'email',
      'Personal Email': 'personalEmail',
    });
  });

  it('warns when two columns map to one field', () => {
    renderWith(['email', 'mail'], { email: 'email', mail: 'email' });

    expect(screen.getByText(/2 columns map to Email: email, mail/)).toBeInTheDocument();
  });
});
