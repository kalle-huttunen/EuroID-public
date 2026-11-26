/**
 * The Deploy modal saves a changed error threshold with PATCH /blueprints/pipeline-config before
 * it deploys. The body is pinned in backend/test/fixtures/blueprint-pipeline-config.payload.json,
 * which the backend test (blueprints-pipeline-config.spec.ts) sends through the real route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { renderWithProviders } from '../../../test/test-utils';
import { DeployModal } from '../DeployModal';

const { mockPost, mockPatch } = vi.hoisted(() => ({ mockPost: vi.fn(), mockPatch: vi.fn() }));
vi.mock('@api/data', () => ({
  axiosInstance: {
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
  },
}));

const FIXTURE = resolve(
  __dirname,
  '../../../../../backend/test/fixtures/blueprint-pipeline-config.payload.json',
);

const READY = {
  ready: true,
  checks: [{ name: 'HR Source', status: 'pass', message: 'HR source connected (CSV HR)' }],
};

function renderModal(onDeployed = vi.fn()) {
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

describe('DeployModal circuit breaker save', () => {
  beforeEach(() => {
    mockPost
      .mockReset()
      .mockImplementation(async (url: string) =>
        url.endsWith('/blueprints/readiness-check') ? { data: READY } : { data: { success: true } },
      );
    mockPatch.mockReset().mockResolvedValue({ data: { success: true } });
  });

  it('sends the chosen threshold to PATCH /blueprints/pipeline-config, then deploys', async () => {
    const onDeployed = renderModal();
    expect(await screen.findByText('HR source connected (CSV HR)')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByTitle('10%'));
    fireEvent.click(screen.getByRole('button', { name: /deploy now/i }));

    await waitFor(() => expect(onDeployed).toHaveBeenCalled());
    expect(mockPatch).toHaveBeenCalledTimes(1);
    const [url, body] = mockPatch.mock.calls[0];
    expect(url).toBe('/api/v1/blueprints/pipeline-config');
    expect(body).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
    const calls = mockPost.mock.calls.map(([u]) => u);
    expect(calls).toEqual(['/api/v1/blueprints/readiness-check', '/api/v1/blueprints/deploy']);
    expect(mockPatch.mock.invocationCallOrder[0]).toBeLessThan(
      mockPost.mock.invocationCallOrder[1],
    );
  });

  it('does not save the config when the threshold is unchanged', async () => {
    const onDeployed = renderModal();
    expect(await screen.findByText('HR source connected (CSV HR)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /deploy now/i }));

    await waitFor(() => expect(onDeployed).toHaveBeenCalled());
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('does not deploy when saving the threshold fails', async () => {
    mockPatch.mockRejectedValue({
      response: { data: { statusCode: 400, message: 'Invalid ID format: pipeline-config' } },
    });
    const onDeployed = renderModal();
    expect(await screen.findByText('HR source connected (CSV HR)')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByTitle('10%'));
    fireEvent.click(screen.getByRole('button', { name: /deploy now/i }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    // The failed save has been handled once the button leaves its loading state.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /deploy now/i })).not.toHaveClass(
        'ant-btn-loading',
      ),
    );
    expect(onDeployed).not.toHaveBeenCalled();
    expect(mockPost.mock.calls.map(([u]) => u)).toEqual(['/api/v1/blueprints/readiness-check']);
  });
});
