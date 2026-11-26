/**
 * The column map of a CSV HR source and the field map of a JSON API HR source in the Design
 * studio drawer. The drawer offered neither, so both connectors always used their default maps,
 * which fill no employeeNumber, and the Brain's "Employee Number" rule got no value from them
 * (browser check 2026-11-25). The map is JSON object text, sent as the connector's config value
 * (PATCH /connectors/:name), where the API checks each entry.
 *
 * Save Config PATCHes the connector before it writes the canvas node: a map the API refused (400)
 * stayed in the canvas, which then held settings the connector did not have.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { renderWithProviders } from '../../../test/test-utils';
import { ConfigDrawer } from '../ConfigDrawer';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn(), patch: vi.fn() },
}));

/** The installed connectors' settings as GET /connectors returned them, by connector id. */
let installed: Record<string, Record<string, string>> = {};
const updateConfig = vi.fn();
vi.mock('@stores/connector-store', () => ({
  useConnectorStore: () => ({
    getConfig: (name: string) =>
      installed[name]
        ? { connectorName: name, config: installed[name], installedAt: '' }
        : undefined,
    updateConfig,
    syncFromBackend: () => Promise.resolve(),
    syncError: null,
  }),
}));

vi.mock('../brain-config', () => ({ BrainConfig: () => null }));

const source = (type: 'csv-hr' | 'json-api-hr', label: string): Node => ({
  id: `${type}-source`,
  position: { x: 0, y: 0 },
  data: { label, role: 'source', type },
});

function renderDrawer(node: Node) {
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  renderWithProviders(
    <ConfigDrawer
      open
      onClose={vi.fn()}
      selectedNode={node}
      onDeleteConnector={vi.fn()}
      onUpdateNodeDataAndSave={onUpdate}
      activeConnectors={[]}
      activeConnectorsForMastery={[]}
      brainConfig={null}
      onCorrelationSave={vi.fn()}
    />,
  );
  return onUpdate;
}

const COLUMN_MAP =
  '{"Personnel No": "sourceUserId", "Work Email": "email", "Employee Number": "employeeNumber"}';

describe('ConfigDrawer HR source column and field maps', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateConfig.mockResolvedValue(undefined);
    installed = {};
  });

  it("shows a CSV source's stored column map and sends a changed one as the connector's config", async () => {
    installed = { 'csv-hr': { filePath: '/srv/hr/employees.csv', columnMap: '{"Mail":"email"}' } };
    const onUpdate = renderDrawer(source('csv-hr', 'CSV HR'));

    const map = await screen.findByLabelText('Column Map');
    await waitFor(() => expect(map).toHaveValue('{"Mail":"email"}'));
    fireEvent.change(map, { target: { value: COLUMN_MAP } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    expect(updateConfig).toHaveBeenCalledWith(
      'csv-hr',
      expect.objectContaining({ filePath: '/srv/hr/employees.csv', columnMap: COLUMN_MAP }),
    );
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("sends a JSON API source's field map", async () => {
    installed = { 'json-api-hr': { url: 'https://hr.example/api/staff' } };
    renderDrawer(source('json-api-hr', 'JSON API HR'));

    const map = await screen.findByLabelText('Field Map');
    await waitFor(() =>
      expect(screen.getByLabelText('API URL')).toHaveValue('https://hr.example/api/staff'),
    );
    const fieldMap = '{"id": "sourceUserId", "mail": "email", "staff_no": "employeeNumber"}';
    fireEvent.change(map, { target: { value: fieldMap } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith(
        'json-api-hr',
        expect.objectContaining({ fieldMap }),
      ),
    );
  });

  it('saves nothing when the map is not a JSON object, and says why', async () => {
    installed = { 'csv-hr': { filePath: '/srv/hr/employees.csv' } };
    const onUpdate = renderDrawer(source('csv-hr', 'CSV HR'));

    const map = await screen.findByLabelText('Column Map');
    await waitFor(() =>
      expect(screen.getByLabelText('File Path')).toHaveValue('/srv/hr/employees.csv'),
    );
    fireEvent.change(map, { target: { value: '{Mail: email}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    expect(
      await screen.findByText(/Not saved: Column Map must be a JSON object/),
    ).toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('leaves the canvas node unchanged when the API refuses the column map, keeping the form', async () => {
    installed = { 'csv-hr': { filePath: '/srv/hr/employees.csv' } };
    const refusal =
      'config.columnMap: "Work Email" maps to "mail", which the HR mapping does not fill';
    updateConfig.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { message: refusal } },
      }),
    );
    const onUpdate = renderDrawer(source('csv-hr', 'CSV HR'));

    const map = await screen.findByLabelText('Column Map');
    await waitFor(() =>
      expect(screen.getByLabelText('File Path')).toHaveValue('/srv/hr/employees.csv'),
    );
    fireEvent.change(map, { target: { value: '{"Work Email": "mail"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
    // The drawer keeps what the admin typed, to correct it.
    expect(screen.getByLabelText('Column Map')).toHaveValue('{"Work Email": "mail"}');
  });

  it('writes the canvas node only after the connector accepted the settings', async () => {
    installed = { 'csv-hr': { filePath: '/srv/hr/employees.csv' } };
    const onUpdate = renderDrawer(source('csv-hr', 'CSV HR'));

    const map = await screen.findByLabelText('Column Map');
    await waitFor(() =>
      expect(screen.getByLabelText('File Path')).toHaveValue('/srv/hr/employees.csv'),
    );
    fireEvent.change(map, { target: { value: COLUMN_MAP } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(updateConfig.mock.invocationCallOrder[0]).toBeLessThan(
      onUpdate.mock.invocationCallOrder[0],
    );
    expect(onUpdate.mock.calls[0][1].config).toEqual(
      expect.objectContaining({ filePath: '/srv/hr/employees.csv', columnMap: COLUMN_MAP }),
    );
  });

  // Without an installed connector (PATCH answers 404) ingest reads the source's settings from
  // the canvas (HrIngestionService.getBlueprintConnectorConfig), so the canvas is still written.
  it('still writes the canvas node of a source whose connector is not installed', async () => {
    updateConfig.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 404'), {
        response: { status: 404, data: { message: 'Connector "csv-hr" not found' } },
      }),
    );
    const onUpdate = renderDrawer(source('csv-hr', 'CSV HR'));

    fireEvent.change(await screen.findByLabelText('File Path'), {
      target: { value: '/srv/hr/employees.csv' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1].config).toEqual(
      expect.objectContaining({ filePath: '/srv/hr/employees.csv' }),
    );
  });
});
