import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useConnectorStore } from '../connector-store';

const { mockGet, mockPost, mockPatch, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
  mockDelete: vi.fn(),
}));
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

const INSTALLED = [
  { connectorName: 'github', config: {}, installedAt: '2026-11-01T00:00:00.000Z' },
];
const installedNames = () => useConnectorStore.getState().installed.map((c) => c.connectorName);

/** An axios error as the API answers it: the reason in response.data.message. */
function apiError(status: number, message: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { message } },
  });
}

describe('connector-store ensureSynced', () => {
  beforeEach(() => {
    mockGet.mockReset();
    localStorage.clear();
    useConnectorStore.setState({ installed: [], syncedFromBackend: false, syncError: null });
  });

  it('loads the installed list once per session: concurrent callers share one request, later ones reuse it', async () => {
    mockGet.mockResolvedValue({ data: INSTALLED });
    const { ensureSynced } = useConnectorStore.getState();

    await Promise.all([ensureSynced(), ensureSynced()]);
    await ensureSynced();

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(installedNames()).toEqual(['github']);
  });

  it('tries again on the next call when the backend was unreachable', async () => {
    mockGet
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockResolvedValueOnce({ data: INSTALLED });
    const { ensureSynced } = useConnectorStore.getState();

    await ensureSynced();
    expect(installedNames()).toEqual([]);
    await ensureSynced();

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(installedNames()).toEqual(['github']);
  });

  it("loads the next user's own list after a logout", async () => {
    mockGet.mockResolvedValue({ data: INSTALLED });
    await useConnectorStore.getState().ensureSynced();

    useConnectorStore.getState().clearOnLogout();
    await useConnectorStore.getState().ensureSynced();

    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  // 09 F4: an empty answer kept the persisted names, so a connector uninstalled elsewhere stayed
  // "installed" here and Install did nothing.
  it('empties the list when the backend answers that no connector is installed', async () => {
    useConnectorStore.setState({
      installed: [{ connectorName: 'okta', config: {}, installedAt: '2026-11-01T00:00:00.000Z' }],
    });
    mockGet.mockResolvedValue({ data: [] });

    await useConnectorStore.getState().syncFromBackend();

    expect(installedNames()).toEqual([]);
    expect(useConnectorStore.getState().syncedFromBackend).toBe(true);
  });

  // r2-09 N4: a GET /connectors still in flight at logout answered with the previous user's list.
  it('does not let a load that was in flight at logout fill the store again', async () => {
    let answer!: (value: { data: typeof INSTALLED }) => void;
    mockGet.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

    const loading = useConnectorStore.getState().syncFromBackend();
    useConnectorStore.getState().clearOnLogout();
    answer({ data: INSTALLED });
    await loading;

    expect(installedNames()).toEqual([]);
    expect(useConnectorStore.getState().syncedFromBackend).toBe(false);
  });
});

// Plan item: install, uninstall and updateConfig swallowed API errors, and a failed
// GET /connectors left the persisted names with empty configs
describe('connector-store: a refused change or a failed load is not hidden', () => {
  const saved = {
    connectorName: 'okta',
    config: { orgUrl: 'https://acme.okta.com' },
    installedAt: '2026-11-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useConnectorStore.setState({ installed: [saved], syncedFromBackend: true, syncError: null });
  });

  it('rejects with the API error and installs nothing when the backend refuses an install', async () => {
    const refused = apiError(400, 'config.orgUrl: Required');
    mockPost.mockRejectedValue(refused);

    await expect(useConnectorStore.getState().install('github', {})).rejects.toBe(refused);

    expect(installedNames()).toEqual(['okta']);
  });

  it('adds the connector once the backend installed it', async () => {
    mockPost.mockResolvedValue({ data: { success: true } });

    await useConnectorStore.getState().install('github', { org: 'acme' });

    expect(mockPost).toHaveBeenCalledWith(expect.stringMatching(/\/connectors\/github\/install$/), {
      config: { org: 'acme' },
    });
    expect(useConnectorStore.getState().getConfig('github')?.config).toEqual({ org: 'acme' });
  });

  it('keeps the connector when the backend refuses the uninstall', async () => {
    const refused = apiError(403, 'Forbidden resource');
    mockDelete.mockRejectedValue(refused);

    await expect(useConnectorStore.getState().uninstall('okta')).rejects.toBe(refused);

    expect(installedNames()).toEqual(['okta']);
  });

  it('keeps the saved config when the backend refuses the update', async () => {
    const refused = apiError(503, 'The stored config of connector "okta" could not be decrypted');
    mockPatch.mockRejectedValue(refused);

    await expect(
      useConnectorStore.getState().updateConfig('okta', { orgUrl: 'https://other.okta.com' }),
    ).rejects.toBe(refused);

    expect(useConnectorStore.getState().getConfig('okta')?.config).toEqual(saved.config);
  });

  it('keeps the error of a failed GET /connectors (the 503 of an undecryptable config) until one succeeds', async () => {
    const unreadable = apiError(
      503,
      'The stored config of connector "okta" could not be decrypted',
    );
    mockGet.mockRejectedValueOnce(unreadable).mockResolvedValueOnce({ data: [saved] });

    await useConnectorStore.getState().syncFromBackend();
    expect(useConnectorStore.getState().syncError).toBe(unreadable);

    await useConnectorStore.getState().syncFromBackend();
    expect(useConnectorStore.getState().syncError).toBeNull();
  });
});
