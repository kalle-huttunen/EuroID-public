/**
 * useCanvasDeploy — Deploy, pause, resume, stop handlers; circuit breaker alert.
 * Extracted from BlueprintCanvas for separation of concerns.
 */
import { useState } from 'react';
import { App } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { useRealTimeEvents } from '@api/realtime';
import { apiErrorMessage } from '../../dead-letter/dead-letter-labels';

export interface CircuitBreakerAlert {
  message: string;
  errorRate: number;
  threshold: number;
}

export function useCanvasDeploy(
  api: ReturnType<typeof import('antd').notification.useNotification>[0],
) {
  const queryClient = useQueryClient();
  const { modal } = App.useApp();
  const [deployModalVisible, setDeployModalVisible] = useState(false);
  const [circuitBreakerAlert, setCircuitBreakerAlert] = useState<CircuitBreakerAlert | null>(null);

  useRealTimeEvents('pipeline', (event) => {
    if (event.eventType === 'pipeline.circuit_breaker_triggered') {
      const p = event.payload as { message?: string; errorRate?: number; threshold?: number };
      setCircuitBreakerAlert({
        message: p.message ?? 'Pipeline auto-paused',
        errorRate: (p.errorRate ?? 0) * 100,
        threshold: p.threshold ?? 5,
      });
      void queryClient.invalidateQueries({ queryKey: ['blueprints', 'pipeline-status'] });
    }
  });

  const handleDeploy = () => setDeployModalVisible(true);
  const handlePause = async () => {
    try {
      await axiosInstance.post(`${API_BASE}/blueprints/pause`);
      void queryClient.invalidateQueries({ queryKey: ['blueprints', 'pipeline-status'] });
      api.success({ message: 'Pipeline paused', placement: 'top' });
    } catch (e) {
      api.error({
        message: 'Failed to pause',
        description: apiErrorMessage(e, 'The request failed'),
        placement: 'top',
      });
    }
  };
  const handleResume = async () => {
    try {
      await axiosInstance.post(`${API_BASE}/blueprints/resume`);
      void queryClient.invalidateQueries({ queryKey: ['blueprints', 'pipeline-status'] });
      setCircuitBreakerAlert(null);
      api.success({ message: 'Pipeline resumed', placement: 'top' });
    } catch (e) {
      api.error({
        message: 'Failed to resume',
        description: apiErrorMessage(e, 'The request failed'),
        placement: 'top',
      });
    }
  };
  const stop = async () => {
    try {
      await axiosInstance.post(`${API_BASE}/blueprints/stop`);
      void queryClient.invalidateQueries({ queryKey: ['blueprints', 'pipeline-status'] });
      setCircuitBreakerAlert(null);
      api.success({ message: 'Pipeline stopped', placement: 'top' });
    } catch (e) {
      api.error({
        message: 'Failed to stop',
        description: apiErrorMessage(e, 'The request failed'),
        placement: 'top',
      });
    }
  };
  /** Stop ends the live pipeline: asked first, like the other destructive actions. */
  const handleStop = () => {
    modal.confirm({
      title: 'Stop the pipeline?',
      content:
        'Provisioning from this pipeline ends. Deploying it again needs a new impact simulation.',
      okText: 'Stop pipeline',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: stop,
    });
  };
  const onDeployed = () => {
    void queryClient.invalidateQueries({ queryKey: ['blueprints', 'pipeline-status'] });
    setDeployModalVisible(false);
  };

  return {
    deployModalVisible,
    setDeployModalVisible,
    circuitBreakerAlert,
    setCircuitBreakerAlert,
    handleDeploy,
    handlePause,
    handleResume,
    handleStop,
    onDeployed,
  };
}
