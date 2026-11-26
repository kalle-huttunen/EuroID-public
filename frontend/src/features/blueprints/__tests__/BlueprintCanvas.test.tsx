import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider, App as AntdApp } from 'antd';
import { BlueprintCanvas } from '../BlueprintCanvas';
import { AuthContext } from '../../../auth/auth-context';
import { mockAuthValue } from '../../../test/test-utils';

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = createTestQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      {/* A super-admin: the toolbar's actions need policy-admin */}
      <AuthContext.Provider value={mockAuthValue}>
        <MemoryRouter>
          <ConfigProvider>
            <AntdApp>{children}</AntdApp>
          </ConfigProvider>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: vi.fn(),
  },
}));

vi.mock('@api/realtime', () => ({
  useRealTimeEvents: () => {},
}));

vi.mock('@stores/connector-store', () => ({
  useConnectorStore: () => ({
    ensureSynced: () => Promise.resolve(),
    isInstalled: () => true,
    installed: [
      { id: 'workday', name: 'Workday HR' },
      { id: 'entra-id', name: 'Microsoft Entra ID' },
    ],
  }),
}));

vi.mock('@stores/policy-draft-store', () => ({
  usePolicyDraftStore: () => ({
    draftNodes: [],
    draftEdges: [],
    addNode: vi.fn(),
    removeNode: vi.fn(),
    updateNode: vi.fn(),
    addEdge: vi.fn(),
    removeEdge: vi.fn(),
    loadDraft: vi.fn(),
    markClean: vi.fn(),
    validate: vi.fn(),
    isDirty: false,
  }),
}));

vi.mock('@api/resource-hooks', () => ({
  useList: () => ({ data: { data: [] } }),
  useInvalidate: () => vi.fn(),
}));

vi.mock('../ImpactAnalysisModal', () => ({
  ImpactAnalysisModal: () => null,
}));

vi.mock('../DeployModal', () => ({
  DeployModal: () => null,
}));

vi.mock('../ConfigDrawer', () => ({
  ConfigDrawer: () => null,
}));

vi.mock('../EdgeConditionPopover', () => ({
  EdgeConditionPopover: () => null,
  getEdgeConditionTooltip: () => '',
}));

vi.mock('@shared/LiveBadge', () => ({
  LiveBadge: () => <span data-testid="live-badge">Live</span>,
}));

describe('BlueprintCanvas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a canvas that failed to load as an error with Retry and offers no Save', async () => {
    // The API answers 503 (a stored config this process cannot decrypt). The studio showed the
    // default layout instead, and a Save overwrote the stored canvas with it.
    const DECRYPT_MESSAGE =
      'The saved Design studio canvas could not be loaded: a connector config stored in it ' +
      'could not be decrypted by this process. Nothing was changed.';
    const saved = {
      success: true,
      data: {
        nodes: [
          {
            id: 'w1',
            type: 'connectorNode',
            data: { label: 'Workday HR', role: 'source' },
            position: { x: 50, y: 250 },
          },
        ],
        edges: [],
      },
      lastSaved: '2026-11-24T08:00:00.000Z',
    };
    let latestFails = true;
    mockGet.mockImplementation(async (url: string) => {
      if (!url.endsWith('/blueprints/latest')) {
        return { data: { success: true, data: { nodes: [], edges: [] } } };
      }
      if (latestFails) {
        throw Object.assign(new Error('Request failed with status code 503'), {
          response: { status: 503, data: { statusCode: 503, message: DECRYPT_MESSAGE } },
        });
      }
      return { data: saved };
    });
    const user = userEvent.setup();

    render(
      <TestWrapper>
        <BlueprintCanvas />
      </TestWrapper>,
    );

    expect(
      await screen.findByText('The saved Design studio canvas could not be loaded'),
    ).toBeInTheDocument();
    expect(screen.getByText(DECRYPT_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect(screen.queryByRole('application', { name: /policy builder canvas/i })).toBeNull();
    expect(screen.queryByText('EuroID Brain')).toBeNull(); // not the default layout

    latestFails = false;
    await user.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByText('Workday HR')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('The saved Design studio canvas could not be loaded')).toBeNull(),
    );
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });
});
