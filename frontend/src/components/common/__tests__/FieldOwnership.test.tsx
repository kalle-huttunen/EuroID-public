import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FieldOwnership } from '../FieldOwnership';

describe('FieldOwnership', () => {
  it('HR owner: renders blue "HR Managed" tag', () => {
    render(<FieldOwnership owner="hr" />);
    expect(screen.getByText('HR Managed')).toBeInTheDocument();
  });

  it('Connector owner: renders green "Synced" tag with source name', () => {
    render(<FieldOwnership owner="connector" source="Workday" />);
    expect(screen.getByText('Workday')).toBeInTheDocument();
  });

  it('Connector owner without source: renders "Synced" tag', () => {
    render(<FieldOwnership owner="connector" />);
    expect(screen.getByText('Synced')).toBeInTheDocument();
  });

  it('Manual owner: renders default "Manual" tag', () => {
    render(<FieldOwnership owner="manual" />);
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });
});
