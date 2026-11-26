import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { ConnectorHealth } from '../ConnectorHealth';
import type { IConnectorHealthStatus } from '../../../interfaces';

// What GET /reconciliation/connector-health returns for a connector without a health check:
// uptime is not tracked and the connector was never checked.
const notMonitored: IConnectorHealthStatus = {
  connectorId: 'file-outbound',
  connectorName: 'File outbound',
  status: 'unknown',
  uptime: null,
  lastChecked: null,
  lastError: 'Not monitored: this connector has no health check',
};

describe('ConnectorHealth', () => {
  it('shows an untracked uptime as n/a and a missing check as never, not 1970', () => {
    renderWithProviders(<ConnectorHealth healthList={[notMonitored]} />);

    expect(screen.getByText('n/a')).toBeInTheDocument();
    expect(screen.queryByText('%')).not.toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
    expect(screen.queryByText(/1970/)).not.toBeInTheDocument();
  });

  it('shows a tracked uptime as a percentage', () => {
    renderWithProviders(
      <ConnectorHealth
        healthList={[
          {
            ...notMonitored,
            status: 'healthy',
            uptime: 99.5,
            lastChecked: new Date().toISOString(),
          },
        ]}
      />,
    );

    expect(screen.getByText('99.5%')).toBeInTheDocument();
    expect(screen.getByText('just now')).toBeInTheDocument();
  });
});
