/**
 * Acknowledge and Dismiss from the anomalies table. A change the anomaly's status no longer
 * allows answers 409 with a message naming that status: the table shows that message (not
 * "Request failed with status code 409") and reloads, so the row shows the state it is in. The
 * toasts come from the app (App.useApp), in its theme, never from antd's static message.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp, message } from 'antd';
import { acknowledgeAnomaly, dismissAnomaly, fetchAnomalies } from '@api/intelligence-api';
import { useAnomalyData } from '../hooks/useAnomalyData';

vi.mock('@api/intelligence-api', () => ({
  fetchAnomalies: vi.fn(),
  acknowledgeAnomaly: vi.fn(),
  dismissAnomaly: vi.fn(),
  intelligenceKeys: {
    anomalies: (params?: object) => ['intelligence', 'anomalies', params],
    anomaliesPrefix: () => ['intelligence', 'anomalies'],
    riskScores: () => ['intelligence', 'risk-scores'],
  },
}));

vi.mock('@config/pagination', () => ({ RISK_DASHBOARD_PAGE_SIZE: 50 }));

const ANOMALY_ID = '0b5e2c1d-7a43-4f0e-9d7a-2a1c3b4d5e6f';

function conflict(text: string) {
  return Object.assign(new Error('Request failed with status code 409'), {
    response: { status: 409, data: { message: text } },
  });
}

function renderAnomalyData() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <AntdApp>{children}</AntdApp>
    </QueryClientProvider>
  );
  return renderHook(() => useAnomalyData(), { wrapper });
}

describe('useAnomalyData', () => {
  // The static antd message renders outside the app's theme: it must not be used
  let staticToasts: Array<ReturnType<typeof vi.spyOn>>;
  afterEach(() => {
    for (const spy of staticToasts) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  beforeEach(() => {
    staticToasts = [vi.spyOn(message, 'success'), vi.spyOn(message, 'error')];
    vi.clearAllMocks();
    vi.mocked(fetchAnomalies).mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    });
  });

  it('shows the 409 message of an acknowledge and reloads the anomalies', async () => {
    vi.mocked(acknowledgeAnomaly).mockRejectedValue(
      conflict(`Anomaly ${ANOMALY_ID} is resolved and cannot be acknowledged.`),
    );
    const { result } = renderAnomalyData();
    await waitFor(() => expect(fetchAnomalies).toHaveBeenCalledTimes(2));

    act(() => result.current.acknowledgeMutation.mutate(ANOMALY_ID));

    expect(
      await screen.findByText(
        `Failed to acknowledge: Anomaly ${ANOMALY_ID} is resolved and cannot be acknowledged.`,
      ),
    ).toBeInTheDocument();
    expect(vi.mocked(acknowledgeAnomaly).mock.calls[0][0]).toBe(ANOMALY_ID);
    // The table and the open-anomaly counts load again.
    await waitFor(() => expect(fetchAnomalies).toHaveBeenCalledTimes(4));
  });

  it('shows the 409 message of a dismiss', async () => {
    vi.mocked(dismissAnomaly).mockRejectedValue(
      conflict(`Anomaly ${ANOMALY_ID} is already dismissed.`),
    );
    const { result } = renderAnomalyData();

    act(() => result.current.dismissMutation.mutate({ id: ANOMALY_ID, reason: 'Duplicate' }));

    expect(
      await screen.findByText(`Failed to dismiss: Anomaly ${ANOMALY_ID} is already dismissed.`),
    ).toBeInTheDocument();
    expect(dismissAnomaly).toHaveBeenCalledWith(ANOMALY_ID, 'Duplicate');
  });

  it('reloads the anomalies after an acknowledge', async () => {
    vi.mocked(acknowledgeAnomaly).mockResolvedValue({} as never);
    const { result } = renderAnomalyData();
    await waitFor(() => expect(fetchAnomalies).toHaveBeenCalledTimes(2));

    act(() => result.current.acknowledgeMutation.mutate(ANOMALY_ID));

    expect(await screen.findByText('Anomaly acknowledged')).toBeInTheDocument();
    await waitFor(() => expect(fetchAnomalies).toHaveBeenCalledTimes(4));
  });
});
