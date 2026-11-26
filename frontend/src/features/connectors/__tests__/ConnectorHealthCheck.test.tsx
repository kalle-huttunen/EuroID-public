/**
 * Test Connection where a connector's settings are edited (the Design studio's source and target
 * drawers): shown for a connector whose manifest (GET /connectors/available) declares
 * healthCheck, it calls POST /connectors/:name/health-check with no config, so the API checks the
 * saved settings, and shows the answer: healthy with its message, or the error. Several
 * connectors' checks only read the saved settings, so unsaved changes in the form are named.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Form, Input } from 'antd';
import { renderWithProviders } from '../../../test/test-utils';
import { ConnectorHealthCheck } from '../ConnectorHealthCheck';

const { mockGet, mockPost, saved } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  saved: { config: {} as Record<string, string> },
}));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

vi.mock('@api/constants', () => ({ API_BASE: '/api/v1' }));

vi.mock('@stores/connector-store', () => ({
  useConnectorStore: () => ({
    getConfig: (name: string) => ({ connectorName: name, config: saved.config, installedAt: '' }),
  }),
}));

const MANIFESTS = [
  { id: 'json-api-hr', name: 'JSON API HR', capabilities: ['ingest', 'healthCheck'] },
  { id: 'legacy-feed', name: 'Legacy feed', capabilities: ['ingest'] },
];

/** The check inside a form holding `values`, as a drawer renders it. */
function Harness({ connectorId, values }: { connectorId: string; values: Record<string, string> }) {
  const [form] = Form.useForm();
  return (
    <Form form={form} initialValues={values}>
      <Form.Item name="url" label="Endpoint URL">
        <Input />
      </Form.Item>
      <ConnectorHealthCheck connectorId={connectorId} form={form} />
    </Form>
  );
}

const renderCheck = (connectorId = 'json-api-hr', values = { url: 'https://hr.example/api' }) =>
  renderWithProviders(<Harness connectorId={connectorId} values={values} />);

describe('ConnectorHealthCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saved.config = { url: 'https://hr.example/api' };
    mockGet.mockImplementation(async (url: string) =>
      url === '/api/v1/connectors/available' ? { data: MANIFESTS } : { data: {} },
    );
  });

  it('checks the saved settings and shows a healthy answer with its message', async () => {
    mockPost.mockResolvedValueOnce({
      data: { healthy: true, connected: true, message: 'The endpoint answered with 12 records' },
    });
    renderCheck();

    await userEvent.click(await screen.findByRole('button', { name: /Test Connection/ }));

    expect(mockPost).toHaveBeenCalledWith('/api/v1/connectors/json-api-hr/health-check', {});
    expect(await screen.findByText('Connection healthy')).toBeInTheDocument();
    expect(
      (await screen.findAllByText('The endpoint answered with 12 records')).length,
    ).toBeGreaterThan(0);
  });

  it('shows the error of an unhealthy answer, and stops spinning', async () => {
    mockPost.mockResolvedValueOnce({
      data: { healthy: false, connected: false, error: 'The endpoint answered HTTP 401' },
    });
    renderCheck();
    const button = await screen.findByRole('button', { name: /Test Connection/ });

    await userEvent.click(button);

    expect(await screen.findByText('Connection failed')).toBeInTheDocument();
    expect((await screen.findAllByText('The endpoint answered HTTP 401')).length).toBeGreaterThan(
      0,
    );
    expect(button).not.toHaveClass('ant-btn-loading');
    expect(screen.queryByText('Connection healthy')).not.toBeInTheDocument();
  });

  it("shows the API's reason when the request fails, and stops spinning at once", async () => {
    mockPost.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { message: 'Connector "json-api-hr" is not installed' } },
      }),
    );
    renderCheck();
    const button = await screen.findByRole('button', { name: /Test Connection/ });

    await userEvent.click(button);

    expect(
      (await screen.findAllByText('Connector "json-api-hr" is not installed')).length,
    ).toBeGreaterThan(0);
    expect(button).not.toHaveClass('ant-btn-loading');
    expect(screen.queryByText(/status code 400/)).not.toBeInTheDocument();
  });

  it('offers no check for a connector whose manifest declares none', async () => {
    renderCheck('legacy-feed');

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/v1/connectors/available'));
    await screen.findByLabelText('Endpoint URL');
    expect(screen.queryByRole('button', { name: /Test Connection/ })).not.toBeInTheDocument();
  });

  it('says the check uses the saved settings while the form has unsaved changes', async () => {
    renderCheck();
    await screen.findByRole('button', { name: /Test Connection/ });
    expect(screen.queryByText(/uses the saved settings/)).not.toBeInTheDocument();

    const url = screen.getByLabelText('Endpoint URL');
    await userEvent.clear(url);
    await userEvent.type(url, 'https://hr2.example/api');

    expect(
      await screen.findByText('The check uses the saved settings: save to test your changes.'),
    ).toBeInTheDocument();
  });
});
