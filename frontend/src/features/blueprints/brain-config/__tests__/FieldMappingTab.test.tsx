import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FieldMappingTab } from '../FieldMappingTab';

describe('FieldMappingTab', () => {
  it('labels its sample values as a sample and shows no fabricated recommendations', () => {
    render(<FieldMappingTab activeConnectors={['Microsoft Entra ID']} />);

    expect(screen.getByText(/illustrative sample record, not data from your identity hub/i)).toBeInTheDocument();
    expect(screen.queryByText(/AI Suggestion/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Example: /)).not.toBeInTheDocument();
    expect(screen.queryByText('Workday')).not.toBeInTheDocument();
  });
});
