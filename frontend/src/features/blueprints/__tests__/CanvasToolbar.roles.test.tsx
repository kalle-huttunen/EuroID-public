/**
 * 08 F8: the Design studio offered Save, simulation, Deploy, Pause and Stop to every role, while
 * the routes behind them (POST /blueprints/save, impact-analysis, deploy, pause, resume, stop)
 * need policy-admin; and Stop ended a live pipeline with one click, without a confirmation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { notification } from 'antd';
import { renderWithProviders } from '../../../test/test-utils';
import { CanvasToolbar } from '../components/CanvasToolbar';
import { useCanvasDeploy } from '../hooks/useCanvasDeploy';

const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: { post: (...args: unknown[]) => mockPost(...args) },
}));
vi.mock('@api/realtime', () => ({ useRealTimeEvents: vi.fn() }));

function Studio({ canEdit, status }: { canEdit: boolean; status: string }) {
  const [api, holder] = notification.useNotification();
  const deploy = useCanvasDeploy(api);
  return (
    <>
      {holder}
      <CanvasToolbar
        canEdit={canEdit}
        isPolicyDirty={false}
        pipelineStatus={status}
        isSaving={false}
        onSave={vi.fn()}
        onSimulate={vi.fn()}
        onDeploy={deploy.handleDeploy}
        onPause={deploy.handlePause}
        onResume={deploy.handleResume}
        onStop={deploy.handleStop}
        addConnectorItems={[]}
      />
    </>
  );
}

beforeEach(() => {
  mockPost.mockReset().mockResolvedValue({ data: {} });
});

describe('Design studio toolbar', () => {
  it('offers a role below policy-admin no change to the canvas or the pipeline', () => {
    renderWithProviders(<Studio canEdit={false} status="DEPLOYED" />);

    for (const name of [/Save/, /Run impact simulation/, /Pause/, /Stop/, /Add connector/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.getByRole('status', { name: /live, deployed/ })).toBeInTheDocument();
  });

  it('offers a policy admin the actions of a deployed pipeline', () => {
    renderWithProviders(<Studio canEdit status="DEPLOYED" />);

    for (const name of [/Save/, /Run impact simulation/, /Pause/, /Stop/]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('stops the pipeline only after the confirmation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Studio canEdit status="DEPLOYED" />);

    await user.click(screen.getByRole('button', { name: /Stop/ }));
    const dialog = (
      await screen.findByText('Stop the pipeline?', { selector: '.ant-modal-confirm-title' })
    ).closest('.ant-modal') as HTMLElement;
    expect(mockPost).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Stop pipeline' }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/v1/blueprints/stop'));
  });
});
