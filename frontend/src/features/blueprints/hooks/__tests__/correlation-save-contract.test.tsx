/**
 * Contract of the Design studio's identity correlation save (POST /blueprints/save).
 *
 * The Brain's Identity Correlation tab saves through useCanvasLoadAndSave, which sends the whole
 * canvas with connectorConfigs['euroid-core'] = { correlationConfig: {...} }. The body it builds
 * is pinned in backend/test/fixtures/blueprint-save-correlation.payload.json, which the backend
 * contract test (blueprints-save-contract.spec.ts) posts to the real validation. Change the
 * builder and this test fails until the fixture is updated, and then the backend test checks
 * that the API accepts the new body.
 *
 * A saved canvas without nodes still holds its connectorConfigs: the studio loaded the defaults
 * for it, so the tab showed "Email (fallback)" instead of the saved rule, and a Save posted the
 * default rule over it (browser check of 2026-11-24).
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Edge, Node } from '@xyflow/react';
import { useCanvasLoadAndSave } from '../useCanvasLoadAndSave';
import { IdentityCorrelationTab } from '../../brain-config/IdentityCorrelationTab';
import { initialNodes } from '../../canvas';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const FIXTURE = resolve(
  __dirname,
  '../../../../../../backend/test/fixtures/blueprint-save-correlation.payload.json',
);

/** A canvas as GET /blueprints/latest returns it: secrets masked, correlation settings readable. */
const savedCanvas = {
  success: true,
  data: {
    nodes: [
      {
        id: 'csv-hr-source',
        type: 'connectorNode',
        position: { x: 50, y: 250 },
        data: {
          label: 'CSV HR',
          role: 'source',
          type: 'csv-hr',
          config: { filePath: '/data/hr.csv' },
        },
      },
      {
        id: 'euroid-core',
        type: 'connectorNode',
        position: { x: 350, y: 250 },
        data: { label: 'EuroID Brain', role: 'brain' },
      },
      {
        id: 'okta-target-1',
        type: 'connectorNode',
        position: { x: 700, y: 250 },
        data: {
          label: 'Okta',
          role: 'target',
          type: 'okta',
          config: { orgUrl: 'https://dev.okta.example', apiToken: '••••••••' },
        },
      },
    ],
    edges: [
      { id: 'e1-core', source: 'csv-hr-source', target: 'euroid-core', label: 'HR Feed' },
      { id: 'core-okta', source: 'euroid-core', target: 'okta-target-1', label: 'Identity' },
    ],
    connectorConfigs: {
      okta: { orgUrl: 'https://dev.okta.example', apiToken: '••••••••' },
      'euroid-core': {
        correlationConfig: {
          rules: [
            { strategy: 'employeeNumber' },
            { strategy: 'hashedNationalId', nationalIdSourceField: 'hetu' },
            { strategy: 'composite', compositeFields: ['firstName', 'lastName', 'birthDate'] },
            { strategy: 'heuristicName', nameMatchThreshold: 0.85, nameMatchMode: 'fuzzy' },
            { strategy: 'email' },
          ],
          conflictAction: 'auto-link',
          fieldMasteryOverrides: { email: ['okta'], jobTitle: ['csv-hr'] },
          hrWriteback: true,
          targetWriteback: false,
        },
      },
    },
  },
};

const api = { success: vi.fn(), error: vi.fn(), warning: vi.fn() } as unknown as Parameters<
  typeof useCanvasLoadAndSave
>[0]['api'];

/** The Design studio's wiring (BlueprintCanvas -> BrainConfig -> IdentityCorrelationTab). */
function DesignStudioCorrelation() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const { brainConfigForDrawer, handleCorrelationSave, isLoading } = useCanvasLoadAndSave({
    setNodes,
    setEdges,
    nodes,
    edges,
    api,
  });
  if (isLoading) return null;
  return (
    <IdentityCorrelationTab
      brainConfig={brainConfigForDrawer}
      activeConnectors={[
        { name: 'okta', label: 'Okta' },
        { name: 'csv-hr', label: 'CSV HR' },
      ]}
      onSave={handleCorrelationSave}
    />
  );
}

/** What goes over the wire: axios sends the body as JSON. */
const onTheWire = (body: unknown) => JSON.parse(JSON.stringify(body));

// The antd form renders slowly in jsdom; under the full parallel suite a test can pass 5 s.
describe('Design studio correlation save contract', { timeout: 20_000 }, () => {
  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue({ data: savedCanvas });
    mockPost.mockReset().mockResolvedValue({ data: { success: true } });
  });

  it('saving the loaded settings posts the pinned payload', async () => {
    render(<DesignStudioCorrelation />);
    // ByText, not ByRole: role queries over the antd form are slow enough to time out under load.
    const save = await screen.findByText('Save Identity Correlation Settings');

    await act(async () => save.click());

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toMatch(/\/blueprints\/save$/);
    expect(onTheWire(body)).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  });

  // The rules table is not a Form.Item: an edit made there must still reach the request.
  it('sends a rule added in the table', async () => {
    render(<DesignStudioCorrelation />);
    const add = await screen.findByText('Add');

    await act(async () => add.click());
    await act(async () => screen.getByText('Save Identity Correlation Settings').click());

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const sent = onTheWire(mockPost.mock.calls[0][1]).connectorConfigs['euroid-core'];
    expect(sent.correlationConfig.rules).toHaveLength(6);
    expect(sent.correlationConfig.rules[5]).toEqual({ strategy: 'email' });
  });
});

describe('Design studio correlation of a saved canvas without nodes', { timeout: 20_000 }, () => {
  /** GET /blueprints/latest of a saved canvas that has no nodes, only the Brain's settings. */
  const savedWithoutNodes = {
    success: true,
    data: {
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      connectorConfigs: {
        'euroid-core': {
          correlationConfig: {
            rules: [{ strategy: 'employeeNumber' }],
            conflictAction: 'review',
            fieldMasteryOverrides: {},
            hrWriteback: false,
            targetWriteback: true,
          },
        },
      },
      pipelineConfig: {},
    },
    lastSaved: '2026-11-24T08:00:00.000Z',
  };

  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue({ data: savedWithoutNodes });
    mockPost.mockReset().mockResolvedValue({ data: { success: true } });
  });

  it('shows the saved rule, and a Save keeps it and the canvas with only its Brain', async () => {
    render(<DesignStudioCorrelation />);
    expect(await screen.findByText('Employee Number')).toBeInTheDocument();
    expect(screen.queryByText('Email (fallback)')).toBeNull();

    await act(async () => screen.getByText('Save Identity Correlation Settings').click());

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const sent = onTheWire(mockPost.mock.calls[0][1]);
    // The load restores the Brain (withBrainNode) and adds no node of the default layout
    expect(sent.nodes.map((n: { id: string }) => n.id)).toEqual(['euroid-core']);
    expect(sent.edges).toEqual([]);
    expect(sent.connectorConfigs['euroid-core'].correlationConfig.rules).toEqual([
      { strategy: 'employeeNumber' },
    ]);
  });

  it('loads the default canvas when nothing is saved', async () => {
    // No saved document: GET /blueprints/latest answers an empty canvas without lastSaved
    mockGet.mockReset().mockResolvedValue({
      data: { success: true, data: { nodes: [], edges: [], connectorConfigs: {} } },
    });
    render(<DesignStudioCorrelation />);
    expect(await screen.findByText('Email (fallback)')).toBeInTheDocument();

    await act(async () => screen.getByText('Save Identity Correlation Settings').click());

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const sent = onTheWire(mockPost.mock.calls[0][1]);
    expect(sent.nodes.map((n: { id: string }) => n.id)).toEqual(initialNodes.map((n) => n.id));
  });
});
