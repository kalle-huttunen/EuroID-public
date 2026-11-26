/**
 * Contract of the Design studio's canvas save (POST /blueprints/save) with edge flow conditions.
 *
 * The flow conditions an admin sets on a Brain -> target edge (EdgeConditionPopover) live in the
 * edge's `data`, and the canvas save sends the edges as the canvas holds them. The body built
 * here is pinned in backend/test/fixtures/blueprint-save-edge-conditions.payload.json, which the
 * backend contract test (blueprints-save-contract.spec.ts) posts to the real validation and loads
 * back. Change what the canvas sends and this test fails until the fixture is updated, and then
 * the backend test checks that the API stores the new body.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { useCanvasNodeManagement } from '../useCanvasNodeManagement';
import { useCanvasLoadAndSave } from '../useCanvasLoadAndSave';
import { EdgeConditionPopover } from '../../EdgeConditionPopover';
import { edgeStyle, sourceStyle, targetStyle, brainStyle } from '../../canvas';

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
  '../../../../../../backend/test/fixtures/blueprint-save-edge-conditions.payload.json',
);

/** Fixed clock: the popover names new condition groups and conditions after Date.now(). */
const NOW = Date.UTC(2026, 10, 22, 8, 0, 0);

/**
 * A canvas as GET /blueprints/latest returns it: the Okta edge carries conditions saved earlier
 * (an "is one of" list among them), the Entra edge none yet.
 */
const savedCanvas = {
  success: true,
  data: {
    nodes: [
      {
        id: 'csv-hr-source',
        type: 'connectorNode',
        position: { x: 50, y: 250 },
        style: sourceStyle,
        data: { label: 'CSV HR', role: 'source', type: 'csv-hr' },
      },
      {
        id: 'euroid-core',
        type: 'connectorNode',
        position: { x: 350, y: 250 },
        style: brainStyle,
        data: { label: 'EuroID Brain', role: 'brain' },
      },
      {
        id: 'okta-target-1',
        type: 'connectorNode',
        position: { x: 700, y: 150 },
        style: targetStyle,
        data: { label: 'Okta', role: 'target', type: 'okta' },
      },
      {
        id: 'entra-target',
        type: 'connectorNode',
        position: { x: 700, y: 350 },
        style: targetStyle,
        data: { label: 'Microsoft Entra ID', role: 'target', type: 'entra-id' },
      },
    ],
    edges: [
      {
        id: 'e1-core',
        source: 'csv-hr-source',
        target: 'euroid-core',
        style: edgeStyle,
        label: 'HR Feed',
      },
      {
        id: 'core-okta-target-1',
        source: 'euroid-core',
        target: 'okta-target-1',
        style: edgeStyle,
        label: 'Provisioning',
        data: {
          conditionsEnabled: true,
          conditionGroups: [
            {
              id: 'ecg-1',
              join: 'AND',
              conditions: [
                {
                  id: 'ec-1',
                  field: 'employmentType',
                  operator: 'in',
                  value: ['Full-Time', 'Contractor'],
                },
                { id: 'ec-2', field: 'department', operator: 'not_equals', value: 'Finance' },
              ],
            },
            {
              id: 'ecg-2',
              join: 'OR',
              conditions: [{ id: 'ec-3', field: 'jobTitle', operator: 'is_not_empty', value: '' }],
            },
          ],
        },
      },
      {
        id: 'core-entra',
        source: 'euroid-core',
        target: 'entra-target',
        style: edgeStyle,
        label: 'Identity',
      },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    connectorConfigs: {},
  },
};

const api = { success: vi.fn(), error: vi.fn(), warning: vi.fn() } as unknown as Parameters<
  typeof useCanvasLoadAndSave
>[0]['api'];

/** The Design studio's wiring (BlueprintCanvas -> CanvasDrawers -> EdgeConditionPopover). */
function DesignStudioEdgeConditions() {
  const nodeMgmt = useCanvasNodeManagement({ api, reactFlowRef: { current: null } });
  const { nodes, setNodes, edges, setEdges, edgePopover, setEdgePopover } = nodeMgmt;
  const { handleSaveCanvas, isLoading } = useCanvasLoadAndSave({
    setNodes,
    setEdges,
    nodes,
    edges,
    api,
  });
  if (isLoading) return null;
  const entraEdge = edges.find((e) => e.id === 'core-entra');
  return (
    <>
      <button
        type="button"
        onClick={(event) => entraEdge && nodeMgmt.onEdgeClick(event, entraEdge)}
      >
        Entra edge
      </button>
      {edgePopover && (
        <EdgeConditionPopover
          edgeId={edgePopover.edgeId}
          edgeData={edgePopover.edgeData}
          position={edgePopover.position}
          onSave={nodeMgmt.handleEdgeConditionSave}
          onClose={() => setEdgePopover(null)}
        />
      )}
      <button type="button" onClick={handleSaveCanvas}>
        Save canvas
      </button>
    </>
  );
}

/** What goes over the wire: axios sends the body as JSON. */
const onTheWire = (body: unknown) => JSON.parse(JSON.stringify(body));

describe('Design studio edge condition save contract', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    mockGet
      .mockReset()
      .mockImplementation(async (url: string) =>
        url.endsWith('/blueprints/latest') ? { data: savedCanvas } : { data: [] },
      );
    mockPost.mockReset().mockResolvedValue({ data: { success: true, nodeCount: 4 } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saving after setting conditions on an edge posts the pinned payload', async () => {
    render(
      <MemoryRouter>
        <DesignStudioEdgeConditions />
      </MemoryRouter>,
    );

    await act(async () => (await screen.findByText('Entra edge')).click());
    await act(async () => (await screen.findByText('Apply')).click());
    await act(async () => screen.getByText('Save canvas').click());

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toMatch(/\/blueprints\/save$/);
    const sent = onTheWire(body);
    // The new conditions and the loaded ones both go out in the edges' data.
    expect(sent.edges.find((e: { id: string }) => e.id === 'core-entra').data).toEqual({
      conditionsEnabled: true,
      conditionGroups: [
        {
          id: `ecg-${NOW}`,
          join: 'AND',
          conditions: [{ id: `ec-${NOW}`, field: 'status', operator: 'equals', value: 'Active' }],
        },
      ],
    });
    expect(sent.edges.find((e: { id: string }) => e.id === 'core-okta-target-1').data).toEqual(
      savedCanvas.data.edges[1].data,
    );
    expect(sent).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  });
});
