/**
 * useAnomalyData — Anomaly queries, filtering, and mutations
 */

import { useState } from 'react';

export interface AcknowledgeMutationSlice {
  mutate: (id: string) => void;
  isPending: boolean;
}
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import {
  fetchAnomalies,
  acknowledgeAnomaly,
  dismissAnomaly,
  intelligenceKeys,
  type AnomalyType,
  type AnomalySeverity,
  type AnomalyStatus,
} from '@api/intelligence-api';
import { RISK_DASHBOARD_PAGE_SIZE } from '@config/pagination';
import { apiErrorMessage } from '../../dead-letter/dead-letter-labels';

export function useAnomalyData() {
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [anomalyFilters, setAnomalyFilters] = useState<{
    type?: AnomalyType;
    severity?: AnomalySeverity;
    status?: AnomalyStatus;
  }>({});
  const [anomalyPage, setAnomalyPage] = useState(1);
  // anomalyId of the anomaly open in AnomalyDetailModal, which loads it.
  const [selectedAnomalyId, setSelectedAnomalyId] = useState<string | null>(null);

  const {
    data: anomaliesRes,
    isLoading: anomaliesLoading,
    isError: anomaliesError,
    error: anomaliesErrorDetail,
    refetch: refetchAnomalies,
  } = useQuery({
    queryKey: intelligenceKeys.anomalies({
      ...anomalyFilters,
      page: anomalyPage,
      limit: RISK_DASHBOARD_PAGE_SIZE,
    }),
    queryFn: () =>
      fetchAnomalies({
        ...anomalyFilters,
        page: anomalyPage,
        limit: RISK_DASHBOARD_PAGE_SIZE,
      }),
  });

  const { data: openAnomaliesRes } = useQuery({
    queryKey: intelligenceKeys.anomalies({ status: 'open', limit: 500 }),
    queryFn: () => fetchAnomalies({ status: 'open', limit: 500 }),
  });

  // Also after a failure: a 409 means the row is stale, so reload it in its current state. The
  // toasts are not returned from onError: React Query would wait for one to close before onSettled.
  const reloadAnomalyViews = () => {
    queryClient.invalidateQueries({ queryKey: intelligenceKeys.anomaliesPrefix() });
    queryClient.invalidateQueries({ queryKey: intelligenceKeys.riskScores() });
    queryClient.invalidateQueries({ queryKey: ['intelligence', 'risk-scores-full'] });
  };

  const acknowledgeMutation = useMutation({
    mutationFn: acknowledgeAnomaly,
    onSuccess: () => {
      setSelectedAnomalyId(null);
      message.success('Anomaly acknowledged');
    },
    onError: (e: unknown) => {
      message.error(`Failed to acknowledge: ${apiErrorMessage(e, 'the request failed')}`);
    },
    onSettled: reloadAnomalyViews,
  });

  const dismissMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => dismissAnomaly(id, reason),
    onSuccess: () => {
      setSelectedAnomalyId(null);
      message.success('Anomaly dismissed');
    },
    onError: (e: unknown) => {
      message.error(`Failed to dismiss: ${apiErrorMessage(e, 'the request failed')}`);
    },
    onSettled: reloadAnomalyViews,
  });

  const anomalies = anomaliesRes?.data ?? [];
  const totalAnomalies = anomaliesRes?.total ?? 0;
  const allOpenAnomalies = openAnomaliesRes?.data ?? [];
  const totalOpenAnomalies = openAnomaliesRes?.total ?? 0;

  return {
    anomalies,
    totalAnomalies,
    allOpenAnomalies,
    totalOpenAnomalies,
    anomalyFilters,
    setAnomalyFilters,
    anomalyPage,
    setAnomalyPage,
    selectedAnomalyId,
    setSelectedAnomalyId,
    acknowledgeMutation,
    dismissMutation,
    anomaliesLoading,
    anomaliesError,
    anomaliesErrorDetail,
    refetchAnomalies,
  };
}
