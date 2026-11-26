/**
 * Final review FE1: the Design studio node drawer offered Save, Remove and the correlation Save
 * to every role, and its Save chained the connector PATCH (PATCH /connectors/:name,
 * connector-admin) before the canvas node save (POST /blueprints/save, policy-admin). A
 * policy-admin without connector-admin got a 403 on the PATCH and the node was never saved; a
 * viewer or operator was offered controls every one of which answered 403.
 *
 * Now the drawer's write controls need policy-admin, as the canvas toolbar's Save does; the
 * connector PATCH runs only for a connector-admin (or super-admin), and for a policy-admin without
 * it the connection settings are read-only with a short note while the canvas node still saves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { mockAuthValue, renderWithProviders } from '../../../test/test-utils';
import { ConfigDrawer } from '../ConfigDrawer';
import { buildNewConnector } from '../canvas';
import { getConnectorById } from '../shared';

const { updateConfig } = vi.hoisted(() => ({ updateConfig: vi.fn() }));

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn(), patch: vi.fn() },
}));

vi.mock('@stores/connector-store', () => ({
  useConnectorStore: () => ({
    getConfig: (name: string) =>
      name === 'okta'
        ? {
            connectorName: name,
            config: { orgUrl: 'https://example.okta.com', apiToken: '••••••••' },
            installedAt: '',
          }
        : undefined,
    updateConfig,
    syncFromBackend: () => Promise.resolve(),
    syncError: null,
  }),
}));

vi.mock('../brain-config', () => ({ BrainConfig: () => null }));

function oktaNode(): Node {
  const meta = getConnectorById('okta')!;
  const { node } = buildNewConnector(meta.name, 'target', meta.icon, []);
  return { ...node, data: { label: meta.name, role: 'target', type: 'okta' } };
}

const conditionNode: Node = {
  id: 'condition-1',
  type: 'condition',
  position: { x: 0, y: 0 },
  data: { field: 'department', operator: 'equals', value: 'Sales' },
};

const as = (roles: string[]) => ({
  ...mockAuthValue,
  user: { ...mockAuthValue.user, profile: { ...mockAuthValue.user.profile, roles } },
});

function renderDrawer(node: Node, roles: string[]) {
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  renderWithProviders(
    <ConfigDrawer
      open
      onClose={vi.fn()}
      selectedNode={node}
      onDeleteConnector={vi.fn()}
      onUpdateNodeDataAndSave={onUpdate}
      onUpdatePolicyNode={vi.fn()}
      onRemovePolicyNode={vi.fn()}
      activeConnectors={[]}
      activeConnectorsForMastery={[]}
      brainConfig={null}
      onCorrelationSave={vi.fn()}
    />,
    { authValue: as(roles) },
  );
  return onUpdate;
}

describe('ConfigDrawer write controls by role', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateConfig.mockResolvedValue(undefined);
  });

  it.each([['viewer'], ['operator'], ['connector-admin']])(
    'offers a %s no Save and no Remove, and the fields read-only',
    async (role) => {
      renderDrawer(oktaNode(), [role]);
      await screen.findByDisplayValue('https://example.okta.com');

      expect(screen.queryByRole('button', { name: 'Save Config' })).toBeNull();
      expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
      expect(screen.getByLabelText('Okta Org URL')).toBeDisabled();
    },
  );

  it('offers a viewer no Save or Remove on a policy node either', () => {
    renderDrawer(conditionNode, ['viewer']);

    expect(screen.queryByRole('button', { name: 'Save Config' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
  });

  it('saves the canvas node of a policy-admin without connector-admin, with the connection settings read-only and no PATCH', async () => {
    const onUpdate = renderDrawer(oktaNode(), ['policy-admin']);
    await screen.findByDisplayValue('https://example.okta.com');

    expect(screen.getByLabelText('Okta Org URL')).toBeDisabled();
    expect(screen.getByText(/connector-admin role/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(updateConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Remove/ })).toBeInTheDocument();
  });

  it('saves the connector settings, then the canvas node, for a super-admin', async () => {
    const onUpdate = renderDrawer(oktaNode(), ['super-admin']);
    await screen.findByDisplayValue('https://example.okta.com');

    expect(screen.getByLabelText('Okta Org URL')).toBeEnabled();
    expect(screen.queryByText(/connector-admin role/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(updateConfig).toHaveBeenCalledWith('okta', expect.anything());
  });

  it('saves both for an admin who holds policy-admin and connector-admin', async () => {
    const onUpdate = renderDrawer(oktaNode(), ['policy-admin', 'connector-admin']);
    await screen.findByDisplayValue('https://example.okta.com');

    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(updateConfig).toHaveBeenCalled();
  });
});
