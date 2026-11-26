import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { renderWithProviders } from '../../../test/test-utils';
import { ConfigDrawer } from '../ConfigDrawer';
import { buildNewConnector } from '../canvas';
import { getConnectorById } from '../shared';

const { updateConfig, savedConfigs, sync } = vi.hoisted(() => ({
  updateConfig: vi.fn(),
  // What GET /connectors returns: secrets come back masked.
  savedConfigs: {
    okta: { orgUrl: 'https://example.okta.com', apiToken: '••••••••' },
  } as Record<string, Record<string, string>>,
  // The store's error of a failed GET /connectors
  sync: { error: null as unknown },
}));

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn(), patch: vi.fn() },
}));

vi.mock('@stores/connector-store', () => ({
  useConnectorStore: () => ({
    getConfig: (name: string) =>
      savedConfigs[name]
        ? { connectorName: name, config: savedConfigs[name], installedAt: '' }
        : undefined,
    updateConfig,
    syncFromBackend: () => Promise.resolve(),
    syncError: sync.error,
  }),
}));

vi.mock('../brain-config', () => ({ BrainConfig: () => null }));

/** The node "Add connector" puts on the canvas for this registry connector. */
function addedNode(connectorId: string): Node {
  const meta = getConnectorById(connectorId)!;
  const { node } = buildNewConnector(meta.name, 'target', meta.icon, []);
  return { ...node, data: { label: meta.name, role: 'target', type: connectorId } };
}

function renderDrawer(node: Node, onUpdateNodeDataAndSave = vi.fn().mockResolvedValue(undefined)) {
  renderWithProviders(
    <ConfigDrawer
      open
      onClose={vi.fn()}
      selectedNode={node}
      onDeleteConnector={vi.fn()}
      onUpdateNodeDataAndSave={onUpdateNodeDataAndSave}
      activeConnectors={[]}
      activeConnectorsForMastery={[]}
      brainConfig={null}
      onCorrelationSave={vi.fn()}
    />,
  );
  return onUpdateNodeDataAndSave;
}

describe('ConfigDrawer target connector forms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sync.error = null;
  });

  // Plan item: a failed GET /connectors showed the form with empty saved settings
  it('shows the load error with its reason instead of the form when GET /connectors failed', async () => {
    sync.error = Object.assign(new Error('Request failed with status code 503'), {
      response: {
        status: 503,
        data: { message: 'The stored config of connector "okta" could not be decrypted' },
      },
    });
    renderDrawer(addedNode('okta'));

    expect(
      await screen.findByText('Could not load the saved connector settings'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The stored config of connector "okta" could not be decrypted'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Okta Org URL')).not.toBeInTheDocument();
  });

  it("shows the API's reason when the backend refuses to save the connector settings", async () => {
    updateConfig.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { message: 'config.orgUrl: Invalid url' } },
      }),
    );
    renderDrawer(addedNode('okta'));
    await screen.findByDisplayValue('https://example.okta.com');

    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    expect(await screen.findByText('config.orgUrl: Invalid url')).toBeInTheDocument();
  });

  // The connector is written first: a refused value never reaches the canvas node.
  it('leaves the canvas node unchanged when the backend refuses the connector settings', async () => {
    updateConfig.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { message: 'config.orgUrl: Invalid url' } },
      }),
    );
    const onUpdate = renderDrawer(addedNode('okta'));
    await screen.findByDisplayValue('https://example.okta.com');

    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    expect(await screen.findByText('config.orgUrl: Invalid url')).toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Okta Org URL')).toHaveValue('https://example.okta.com');
  });

  it('shows Okta its own fields, not the generic endpoint form, with the token as a password', async () => {
    renderDrawer(addedNode('okta'));

    expect(await screen.findByLabelText('Okta Org URL')).toHaveValue('https://example.okta.com');
    expect(screen.getByLabelText('API Token')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Default Group ID')).toBeInTheDocument();
    expect(screen.queryByLabelText('API Endpoint')).not.toBeInTheDocument();
  });

  it('saves Okta config under the backend connector id, sending the masked token back unchanged', async () => {
    const onUpdate = renderDrawer(addedNode('okta'));
    await screen.findByDisplayValue('https://example.okta.com');

    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(updateConfig).toHaveBeenCalledWith(
      'okta',
      expect.objectContaining({ orgUrl: 'https://example.okta.com', apiToken: '••••••••' }),
    );
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(updateConfig.mock.invocationCallOrder[0]).toBeLessThan(
      onUpdate.mock.invocationCallOrder[0],
    );
  });

  // With no saved config the drawer resets the form after the store sync, which
  // remounts the inputs; waitFor re-queries instead of holding a detached node.
  it('masks every SCIM credential', async () => {
    renderDrawer(addedNode('scim'));

    await waitFor(() => {
      expect(screen.getByLabelText('SCIM Base URL')).toHaveAttribute('type', 'text');
      for (const label of ['Bearer Token', 'Password', 'Client Secret']) {
        expect(screen.getByLabelText(label), label).toHaveAttribute('type', 'password');
      }
      expect(screen.getByLabelText('OAuth2 Token URL')).toHaveAttribute('type', 'text');
    });
  });

  // Each field's input type: secrets the backend masks are passwords.
  it.each([
    ['github', { 'Personal Access Token': 'password', 'Organization Name': 'text' }],
    [
      'google-sheets',
      { 'Sheet ID': 'text', 'Service Account JSON': 'password', 'Worksheet Name': 'text' },
    ],
    // The webhook URL embeds the webhook token.
    ['discord-webhook', { 'Webhook URL': 'password' }],
    ['file-outbound', { 'Output File Path': 'text' }],
  ])('shows %s its backend config fields, not the generic endpoint form', async (id, fields) => {
    renderDrawer(addedNode(id));

    await waitFor(() => {
      for (const [label, type] of Object.entries(fields)) {
        expect(screen.getByLabelText(label), label).toHaveAttribute('type', type);
      }
    });
    expect(screen.queryByLabelText('API Endpoint')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
  });

  // GET /blueprints/latest returns node configs with secrets masked; the backend keeps the
  // stored secret when the mask comes back, so an edit elsewhere must send it unchanged.
  it('saves an edited Entra node with its masked client secret sent back unchanged', async () => {
    const node: Node = {
      id: 'entra-target',
      position: { x: 0, y: 0 },
      data: {
        label: 'Microsoft Entra ID',
        role: 'target',
        config: { tenantId: 'tid-1', clientId: 'cid-1', clientSecret: '••••••••' },
      },
    };
    const onUpdate = renderDrawer(node);
    const clientId = await screen.findByLabelText('Client ID (Application ID)');
    expect(screen.getByLabelText('Client Secret')).toHaveValue('••••••••');

    fireEvent.change(clientId, { target: { value: 'cid-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    const [nodeId, data] = onUpdate.mock.calls[0];
    expect(nodeId).toBe('entra-target');
    expect(data.config).toEqual(
      expect.objectContaining({ tenantId: 'tid-1', clientId: 'cid-2', clientSecret: '••••••••' }),
    );
    expect(updateConfig).toHaveBeenCalledWith(
      'entra-id',
      expect.objectContaining({ clientId: 'cid-2', clientSecret: '••••••••' }),
    );
  });

  it('groups ServiceNow fields into Connection and Incidents tabs', async () => {
    renderDrawer(addedNode('servicenow'));

    await waitFor(() => {
      expect(screen.getByLabelText('Instance URL')).toHaveAttribute('type', 'text');
      expect(screen.getByLabelText('OAuth2 Client Secret')).toHaveAttribute('type', 'password');
      expect(screen.getByLabelText('Password (Basic Auth Fallback)')).toHaveAttribute(
        'type',
        'password',
      );
      expect(screen.getByRole('tab', { name: 'Incidents' })).toBeInTheDocument();
    });
  });
});
