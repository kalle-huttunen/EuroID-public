/**
 * A critical-risk impact analysis made the "Impact Analysis" check a warning that "requires
 * manual acknowledgement", and nothing asked for one: Deploy was enabled (hunt 05 F12). The
 * readiness check now marks it acknowledgementRequired; the modal asks for the confirmation and
 * sends it with the deploy, which the API refuses without it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { DeployModal } from '../DeployModal';

const { mockPost, mockPatch } = vi.hoisted(() => ({ mockPost: vi.fn(), mockPatch: vi.fn() }));
vi.mock('@api/data', () => ({
  axiosInstance: {
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
  },
}));

const CRITICAL = {
  ready: true,
  checks: [
    { name: 'HR Source', status: 'pass', message: 'HR source connected (CSV HR)' },
    {
      name: 'Impact Analysis',
      status: 'warn',
      message: 'Impact analysis reviewed (critical risk): confirm it to deploy',
      acknowledgementRequired: true,
    },
  ],
};

function renderModal(readiness: unknown, onDeployed = vi.fn()) {
  mockPost.mockImplementation(async (url: string) =>
    url.endsWith('/blueprints/readiness-check') ? { data: readiness } : { data: {} },
  );
  renderWithProviders(
    <DeployModal
      open
      onClose={vi.fn()}
      onDeployed={onDeployed}
      pipelineConfig={{ status: 'SIMULATED', errorThresholdPercent: 5 }}
    />,
  );
  return onDeployed;
}

describe('DeployModal and a critical-risk impact analysis', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPatch.mockReset().mockResolvedValue({ data: {} });
  });

  it('keeps Deploy disabled until the risk is confirmed, then sends the confirmation', async () => {
    const onDeployed = renderModal(CRITICAL);
    const confirm = await screen.findByRole('checkbox', { name: /critical risk/i });
    const deploy = screen.getByRole('button', { name: /deploy now/i });
    expect(deploy).toBeDisabled();

    fireEvent.click(confirm);
    expect(deploy).toBeEnabled();
    fireEvent.click(deploy);

    await waitFor(() => expect(onDeployed).toHaveBeenCalled());
    expect(mockPost).toHaveBeenLastCalledWith('/api/v1/blueprints/deploy', {
      acknowledgeCriticalRisk: true,
    });
  });

  it('asks nothing and sends no confirmation when no check needs one', async () => {
    const onDeployed = renderModal({ ready: true, checks: [CRITICAL.checks[0]] });
    expect(await screen.findByText('HR source connected (CSV HR)')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /deploy now/i }));

    await waitFor(() => expect(onDeployed).toHaveBeenCalled());
    expect(mockPost).toHaveBeenLastCalledWith('/api/v1/blueprints/deploy', {});
  });
});
