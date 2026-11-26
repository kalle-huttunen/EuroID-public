/**
 * 08 F3: a save the API refuses (400 of POST /blueprints/save, e.g. a refused Field Mastery owner)
 * must not stay in the canvas state. It did: the Brain's correlation settings and an edited node's
 * data were set before the request, so every later Save re-posted the refused value and failed.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import { useCanvasLoadAndSave } from '../useCanvasLoadAndSave';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const savedRule = {
  rules: [{ strategy: 'employeeNumber' }],
  conflictAction: 'review',
  fieldMasteryOverrides: {},
  hrWriteback: false,
  targetWriteback: true,
};
const savedCanvas = {
  success: true,
  lastSaved: '2026-11-24T08:00:00.000Z',
  data: {
    nodes: [
      {
        id: 'okta-target-1',
        type: 'connectorNode',
        position: { x: 700, y: 250 },
        data: { label: 'Okta', role: 'target', type: 'okta', config: { orgUrl: 'https://a' } },
      },
    ],
    edges: [],
    connectorConfigs: { 'euroid-core': { correlationConfig: savedRule } },
  },
};

const refused = Object.assign(new Error('Request failed with status code 400'), {
  response: { status: 400, data: { message: 'fieldMasteryOverrides.email: unknown owner' } },
});

const api = { success: vi.fn(), error: vi.fn(), warning: vi.fn() } as unknown as Parameters<
  typeof useCanvasLoadAndSave
>[0]['api'];

function useStudio() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  return { nodes, ...useCanvasLoadAndSave({ setNodes, setEdges, nodes, edges, api }) };
}

/** The body of the last POST /blueprints/save. */
const lastBody = () => mockPost.mock.calls.at(-1)?.[1];

describe('Design studio after a refused save', () => {
  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue({ data: savedCanvas });
    mockPost.mockReset();
  });

  it('keeps the saved correlation settings, so the next canvas Save posts those', async () => {
    const { result } = renderHook(() => useStudio());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockPost.mockRejectedValueOnce(refused);
    await act(async () => {
      await expect(
        result.current.handleCorrelationSave({
          rules: [{ strategy: 'email' }],
          conflictAction: 'auto-link',
          fieldMasteryOverrides: { email: 'nowhere' },
        }),
      ).rejects.toBe(refused);
    });

    mockPost.mockResolvedValueOnce({ data: { success: true, nodeCount: 2 } });
    await act(async () => {
      await result.current.handleSaveCanvas();
    });
    expect(lastBody().connectorConfigs['euroid-core'].correlationConfig).toEqual(savedRule);
  });

  it("keeps the node's saved data", async () => {
    const { result } = renderHook(() => useStudio());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockPost.mockRejectedValueOnce(refused);
    await act(async () => {
      await result.current.handleUpdateNodeDataAndSave('okta-target-1', {
        label: 'Okta',
        role: 'target',
        type: 'okta',
        config: { orgUrl: 'refused' },
      });
    });

    const okta = result.current.nodes.find((n) => n.id === 'okta-target-1');
    expect((okta?.data as { config: unknown }).config).toEqual({ orgUrl: 'https://a' });
  });

  it('keeps an accepted change', async () => {
    const { result } = renderHook(() => useStudio());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockPost.mockResolvedValue({ data: { success: true } });
    await act(async () => {
      await result.current.handleUpdateNodeDataAndSave('okta-target-1', {
        label: 'Okta',
        role: 'target',
        type: 'okta',
        config: { orgUrl: 'https://b' },
      });
      await result.current.handleCorrelationSave({
        rules: [{ strategy: 'email' }],
        conflictAction: 'review',
      });
    });

    const okta = result.current.nodes.find((n) => n.id === 'okta-target-1');
    expect((okta?.data as { config: unknown }).config).toEqual({ orgUrl: 'https://b' });
    expect(
      (result.current.connectorConfigs['euroid-core'] as { correlationConfig: { rules: unknown } })
        .correlationConfig.rules,
    ).toEqual([{ strategy: 'email' }]);
  });
});
