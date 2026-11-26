/**
 * Admin > Recon Config: a save the API refuses shows the API's own message. Since 2026-11-24 the
 * API refuses a default mastery entry that names a secondary HR source or a target for a
 * contract-critical field; the page showed axios's "Request failed with status code 400".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { ReconciliationConfig } from '../ReconciliationConfig';

const mockGet = vi.fn();
const mockPut = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
  },
}));

const config = {
  hrSourceTags: ['csv-hr', 'json-api-hr'],
  sourcePriorityOrder: ['csv-hr', 'json-api-hr'],
  contractCriticalFields: ['departmentName'],
  defaultMastery: { departmentName: ['entra-id'] },
  targetIdKeys: ['objectId'],
};

describe('ReconciliationConfig save', { timeout: 20_000 }, () => {
  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue({ data: { configured: true, config } });
    mockPut.mockReset();
  });

  it("shows the API's message when the save is refused", async () => {
    const reason =
      'Default mastery: departmentName names entra-id. Contract-critical fields always come ' +
      'from the primary HR contract (now csv-hr); a secondary HR source or a target cannot ' +
      'master them. Remove these entries, and choose the primary contract through the Contract ' +
      'Tag and ingest priority of the HR sources.';
    mockPut.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { message: reason } },
      }),
    );
    renderWithProviders(<ReconciliationConfig />);

    await userEvent.click(await screen.findByRole('button', { name: /Save$/ }));

    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.queryByText(/status code 400/)).toBeNull();
    expect(mockPut).toHaveBeenCalledWith(
      '/api/v1/admin/reconciliation-config',
      expect.objectContaining({ defaultMastery: { departmentName: ['entra-id'] } }),
    );
  });

  it('says that contract-critical fields always come from the primary HR contract', async () => {
    renderWithProviders(<ReconciliationConfig />);

    expect(
      await screen.findByText(/The primary HR contract always sets these fields/),
    ).toHaveTextContent('Choose the primary contract through the Contract Tag and ingest priority');
  });
});

// 08 F7: a failed GET showed "No reconciliation config found" over empty fields with Save
// enabled, so a Save wrote an empty config over the real one.
describe('ReconciliationConfig when the config cannot be loaded', { timeout: 20_000 }, () => {
  beforeEach(() => {
    mockGet.mockReset().mockRejectedValue(
      Object.assign(new Error('Request failed with status code 503'), {
        response: { status: 503, data: { message: 'Database unavailable' } },
      }),
    );
    mockPut.mockReset();
  });

  it('shows the error and offers no Save', async () => {
    renderWithProviders(<ReconciliationConfig />);

    expect(
      await screen.findByText('Reconciliation config could not be loaded'),
    ).toBeInTheDocument();
    expect(screen.getByText('Database unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/No reconciliation config found/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Save$/ })).toBeNull();
  });
});
