/**
 * Two admins saving the same canvas: the second save silently overwrote the first (HX-F report
 * follow-up). GET /blueprints/latest now returns the canvas `revision`, the studio sends it back
 * with every save and keeps the one the save answers, and a save the API refuses with 409 (saved
 * by someone else since) tells the admin to reload, with a Reload button.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
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

const savedCanvas = (revision: number) => ({
  success: true,
  lastSaved: '2026-11-24T08:00:00.000Z',
  revision,
  data: {
    nodes: [
      {
        id: 'okta-target-1',
        type: 'connectorNode',
        position: { x: 700, y: 250 },
        data: { label: 'Okta', role: 'target', type: 'okta', config: {} },
      },
    ],
    edges: [],
    connectorConfigs: {},
  },
});

const CONFLICT_MESSAGE =
  'The canvas was saved by someone else after you loaded it (you loaded revision 4, it is now ' +
  '5). Nothing was saved. Reload the canvas to see their changes, then make yours again.';
const conflict = Object.assign(new Error('Request failed with status code 409'), {
  response: { status: 409, data: { statusCode: 409, message: CONFLICT_MESSAGE } },
});

const api = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };

function useStudio() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  return {
    nodes,
    ...useCanvasLoadAndSave({
      setNodes,
      setEdges,
      nodes,
      edges,
      api: api as unknown as Parameters<typeof useCanvasLoadAndSave>[0]['api'],
    }),
  };
}

const postedRevisions = () => mockPost.mock.calls.map(([, body]) => body.revision);

describe('Design studio canvas revision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockReset().mockResolvedValue({ data: savedCanvas(4) });
    mockPost.mockReset();
  });

  it('sends the loaded revision with a save, then the one the save answered', async () => {
    const { result } = renderHook(() => useStudio());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    mockPost
      .mockResolvedValueOnce({ data: { success: true, nodeCount: 2, revision: 5 } })
      .mockResolvedValueOnce({ data: { success: true, nodeCount: 2, revision: 6 } });

    await act(() => result.current.handleSaveCanvas());
    await act(() => result.current.handleSaveCanvas());

    expect(postedRevisions()).toEqual([4, 5]);
  });

  it('tells the admin to reload when someone saved since, and Reload loads the canvas again', async () => {
    const { result } = renderHook(() => useStudio());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    mockPost.mockRejectedValueOnce(conflict);

    await act(() => result.current.handleSaveCanvas());

    expect(api.error).toHaveBeenCalledTimes(1);
    const notice = api.error.mock.calls[0][0] as {
      message: string;
      description: string;
      actions: ReactElement<{ onClick: () => void }>;
    };
    expect(notice.message).toBe('Canvas changed by someone else');
    expect(notice.description).toBe(CONFLICT_MESSAGE);
    expect(api.success).not.toHaveBeenCalled();

    mockGet.mockResolvedValueOnce({ data: savedCanvas(5) });
    await act(async () => notice.actions.props.onClick());
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));

    mockPost.mockResolvedValueOnce({ data: { success: true, nodeCount: 2, revision: 6 } });
    await act(() => result.current.handleSaveCanvas());
    expect(postedRevisions()).toEqual([4, 5]);
  });

  it('tells it the same way when a node configuration save meets a newer canvas', async () => {
    const { result } = renderHook(() => useStudio());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    mockPost.mockRejectedValueOnce(conflict);

    await act(() =>
      result.current.handleUpdateNodeDataAndSave('okta-target-1', { label: 'Okta 2' }),
    );

    expect(api.error).toHaveBeenCalledTimes(1);
    expect(api.error.mock.calls[0][0].message).toBe('Canvas changed by someone else');
  });
});
