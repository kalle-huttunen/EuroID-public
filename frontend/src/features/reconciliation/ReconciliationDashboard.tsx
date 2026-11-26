/**
 * Reconciliation Dashboard – single page with Drift Dashboard and Connector Health tabs.
 * Fetches from /api/v1/reconciliation/drifts and /api/v1/reconciliation/connector-health.
 * Uses React Query + axiosInstance for real-time invalidation via WebSocket events.
 */

import React, { useState, useMemo, useCallback, useRef } from 'react';
import { App, Card, Tabs, Button, Skeleton, Result } from 'antd';
import { ReloadOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { useConnectorStore } from '@stores/connector-store';
import { DailyRunContent } from './daily-reconciliation';
import { dailyRunBody, dailyRunTargets } from './daily-reconciliation-body';
import { usePermission } from '../../auth';
import { DriftList } from './DriftList';
import { OrphanedAccountsList } from './OrphanedAccountsList';
import { ConnectorHealth } from './ConnectorHealth';
import { identityPath } from '../users/identity-path';
import type { FromState } from '../../utils/back-path';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { LiveBadge } from '@shared/LiveBadge';
import {
  fetchDriftsPaginated,
  fetchConnectorHealth,
  fetchDriftStats,
  reconciliationKeys,
} from '@api/reconciliation-api';
import { uncorrelatedKeys } from '@api/identity-api';
import type { IDrift, IConnectorHealthStatus } from '../../interfaces/reconciliation.interface';
import type { DriftSeverity, DriftType } from '../../interfaces';
import { KpiBand } from '@shared/KpiBand';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import {
  AUTO_FIX_WARNING_SECONDS,
  autoFixOutcome,
  type BulkCorrectAnswer,
} from './auto-fix-outcome';

const DRIFT_PAGE_SIZE = 50;

type TabKey = 'drift' | 'orphans' | 'connectors';

export const ReconciliationDashboard: React.FC = () => {
  const canOperate = usePermission('operator');
  // App.useApp's modal and message follow the app's theme; the static ones render outside it.
  const { modal, message } = App.useApp();
  const [activeTab, setActiveTab] = useState<TabKey>('drift');
  const [runningRecon, setRunningRecon] = useState(false);
  /** A run request in progress (the click, the connector list, the confirmation): see handleRunDailyRecon. */
  const runReconPending = useRef(false);
  // Drift page and filters live in the URL, so returning from an identity page restores them.
  const [searchParams, setSearchParams] = useSearchParams();
  const driftPage = Math.max(1, Number(searchParams.get('page')) || 1);
  const driftFilters = useMemo(
    () => ({
      severity: (searchParams.get('severity') ?? undefined) as DriftSeverity | 'all' | undefined,
      type: (searchParams.get('type') ?? undefined) as DriftType | 'all' | undefined,
      targetSystem: searchParams.get('targetSystem') ?? undefined,
      search: searchParams.get('search') ?? undefined,
    }),
    [searchParams],
  );
  const setDriftPage = useCallback(
    (page: number) =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (page > 1) next.set('page', String(page));
          else next.delete('page');
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );

  const {
    data: driftResult,
    isLoading: driftLoading,
    isError: driftError,
    refetch: refetchDrifts,
  } = useQuery({
    queryKey: reconciliationKeys.driftsPaginated({
      page: driftPage,
      limit: DRIFT_PAGE_SIZE,
      severity:
        driftFilters.severity && driftFilters.severity !== 'all'
          ? driftFilters.severity
          : undefined,
      type: driftFilters.type && driftFilters.type !== 'all' ? driftFilters.type : undefined,
      targetSystem:
        driftFilters.targetSystem && driftFilters.targetSystem !== 'all'
          ? driftFilters.targetSystem
          : undefined,
      search: driftFilters.search,
    }),
    queryFn: () =>
      fetchDriftsPaginated({
        page: driftPage,
        limit: DRIFT_PAGE_SIZE,
        severity:
          driftFilters.severity && driftFilters.severity !== 'all'
            ? driftFilters.severity
            : undefined,
        type: driftFilters.type && driftFilters.type !== 'all' ? driftFilters.type : undefined,
        targetSystem:
          driftFilters.targetSystem && driftFilters.targetSystem !== 'all'
            ? driftFilters.targetSystem
            : undefined,
        search: driftFilters.search,
      }),
  });

  const drifts = driftResult?.drifts ?? [];
  const driftTotal = driftResult?.total ?? 0;

  const handleDriftFilterChange = useCallback(
    (filters: {
      severity?: DriftSeverity | 'all';
      type?: DriftType | 'all';
      targetSystem?: string;
      search?: string;
    }) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(filters)) {
            if (value === undefined) continue;
            if (value === '' || value === 'all') next.delete(key);
            else next.set(key, value);
          }
          next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const {
    data: connectorHealth = [],
    isLoading: healthLoading,
    isError: healthError,
    refetch: refetchHealth,
  } = useQuery({
    queryKey: reconciliationKeys.connectorHealth(),
    queryFn: fetchConnectorHealth,
  });

  const navigate = useNavigate();
  const location = useLocation();

  /** A drift's user opens the identity page on its Drift tab; Back returns here, filters kept. */
  const openIdentity = (userId: string) => {
    const state: FromState = { from: location.pathname + location.search };
    navigate(identityPath(userId, 'drift'), { state });
  };

  const { data: uncorrelatedCount = 0 } = useQuery({
    queryKey: uncorrelatedKeys.count(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<{ count: number }>(
        `${API_BASE}/identity/uncorrelated/count`,
      );
      return data?.count ?? 0;
    },
  });

  const {
    data: driftStats,
    refetch: refetchStats,
    isError: statsError,
  } = useQuery({
    queryKey: reconciliationKeys.driftStats(),
    queryFn: fetchDriftStats,
  });

  // No figure without the stats: the drift list's total counts every status, not open drifts
  const stats = useMemo(
    () => ({
      total: driftStats?.total ?? null,
      critical: driftStats?.critical ?? null,
      autoFixEligible: driftStats?.autoFixEligible ?? null,
      pending: driftStats?.pending ?? null,
    }),
    [driftStats],
  );

  const handleRunDailyRecon = async () => {
    // One run request at a time: the button stays loading from the click until the confirmation
    // closes, so a second click while the connectors load opens no second confirmation
    if (runReconPending.current) return;
    runReconPending.current = true;
    setRunningRecon(true);
    const done = () => {
      runReconPending.current = false;
      setRunningRecon(false);
    };
    // The installed connectors decide which systems are scanned
    await useConnectorStore.getState().ensureSynced();
    const { installed, syncError } = useConnectorStore.getState();
    if (syncError) {
      // Without the list, AD and SCIM would be left out of the run without a word
      message.error(apiErrorMessage(syncError, 'Could not read the installed connectors'));
      done();
      return;
    }
    const targetSystems = dailyRunTargets(installed.map((c) => c.connectorName));
    let autoCorrect = true;
    modal.confirm({
      title: 'Run daily reconciliation?',
      content: (
        <DailyRunContent
          targetSystems={targetSystems}
          onAutoCorrectChange={(value) => (autoCorrect = value)}
        />
      ),
      okText: 'Yes, Run',
      okType: 'primary',
      cancelText: 'Cancel',
      onCancel: done,
      onOk: async () => {
        try {
          const { data } = await axiosInstance.post(
            `${API_BASE}/reconciliation/start-daily`,
            dailyRunBody(targetSystems, autoCorrect),
          );
          message.success(
            data.workflowId
              ? `Reconciliation started (${data.workflowId}). Check status in a moment.`
              : 'Reconciliation started.',
          );
          refetchDrifts();
          refetchStats();
          refetchHealth();
        } catch (err) {
          // The API's reason, e.g. a run of this tenant still going (409)
          message.error(apiErrorMessage(err, 'Failed to start daily reconciliation'));
        } finally {
          done();
        }
      },
    });
  };

  const handleRefresh = () => {
    refetchDrifts();
    refetchStats();
    refetchHealth();
    message.success('Refreshed');
  };

  const handleAutoFix = (ids: string[]) => {
    modal.confirm({
      title: 'Auto-Fix Drifts?',
      content: `This will correct ${ids.length} drift(s) in target systems (Entra ID, AD). Changes will be applied immediately. Continue?`,
      okText: 'Yes, Auto-Fix',
      okType: 'primary',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          const { data } = await axiosInstance.post<BulkCorrectAnswer>(
            `${API_BASE}/reconciliation/drifts/bulk-correct`,
            {
              driftIds: ids,
            },
          );
          // A success only when every selected drift was corrected; else the counts and why.
          const outcome = autoFixOutcome(data ?? {}, ids.length);
          if (outcome.level === 'warning') {
            message.warning(outcome.text, AUTO_FIX_WARNING_SECONDS);
          } else {
            message.success(outcome.text);
          }
          refetchDrifts();
          refetchStats();
        } catch (err) {
          message.error(apiErrorMessage(err, 'Failed to auto-fix drifts'));
        }
      },
    });
  };

  const handleIgnore = (ids: string[]) => {
    const one = ids.length === 1;
    modal.confirm({
      title: 'Ignore Drifts?',
      content: one
        ? 'This marks 1 drift as ignored. It stays in the list with the status Ignored and offers no further action. Continue?'
        : `This marks ${ids.length} drifts as ignored. They stay in the list with the status Ignored and offer no further action. Continue?`,
      okText: 'Yes, Ignore',
      okType: 'default',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          let ignored = 1;
          if (one) {
            // The single route also takes a quarantined orphan drift and stops its cleanup
            await axiosInstance.post(
              `${API_BASE}/reconciliation/drifts/${encodeURIComponent(ids[0])}/ignore`,
            );
          } else {
            // The bulk route ignores the open drifts among them (the list selects only those)
            const { data } = await axiosInstance.post<{ ignored?: number }>(
              `${API_BASE}/reconciliation/drifts/bulk-ignore`,
              { driftIds: ids },
            );
            ignored = data?.ignored ?? ids.length;
          }
          message.success(`Ignored ${ignored} drift${ignored === 1 ? '' : 's'}.`);
          refetchDrifts();
          refetchStats();
        } catch (err) {
          message.error(apiErrorMessage(err, 'Failed to ignore drifts'));
        }
      },
    });
  };

  const handleCheckConnectorHealth = async (_connectorId?: string) => {
    await refetchHealth();
    message.success('Health check refreshed');
  };

  const hasDriftError = driftError;
  const hasHealthError = healthError && activeTab === 'connectors';

  return (
    <PageContainer>
      <PageHeader
        title="Reconciliation"
        titleExtra={<LiveBadge />}
        subtitle="Desired state compared with what target systems actually hold"
        actions={
          <>
            <Button icon={<ReloadOutlined />} onClick={handleRefresh}>
              Refresh
            </Button>
            {canOperate && (
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={runningRecon}
                onClick={() => void handleRunDailyRecon()}
              >
                Run daily reconciliation
              </Button>
            )}
          </>
        }
      />

      <div style={{ marginBottom: 16 }}>
        <KpiBand
          items={[
            // GET /drifts/stats counts open drifts; the list below holds every status
            {
              key: 'total',
              label: 'Open drifts',
              value: stats.total,
              ...(statsError && {
                context: 'Could not be loaded: retry',
                onClick: () => void refetchStats(),
                actionLabel: 'Drift figures could not be loaded: retry',
              }),
            },
            {
              key: 'critical',
              label: 'Critical',
              value: stats.critical,
              tone: (stats.critical ?? 0) > 0 ? 'error' : 'default',
            },
            { key: 'autofix', label: 'Auto-fix eligible', value: stats.autoFixEligible },
            { key: 'pending', label: 'Pending review', value: stats.pending },
            {
              key: 'uncorrelated',
              label: 'Uncorrelated',
              value: uncorrelatedCount,
              tone: uncorrelatedCount > 0 ? 'warning' : 'default',
              context: uncorrelatedCount > 0 ? 'Need manual linking' : undefined,
              onClick:
                uncorrelatedCount > 0 ? () => navigate('/reconciliation/uncorrelated') : undefined,
              actionLabel: 'Uncorrelated identities: open Uncorrelated queue',
            },
          ]}
        />
      </div>

      {/* Tabs */}
      <Card size="small" style={{ marginBottom: 24 }}>
        <Tabs
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as TabKey)}
          items={[
            {
              key: 'drift',
              label: 'Drift dashboard',
              children: hasDriftError ? (
                <Result
                  status="warning"
                  title="Failed to load drifts"
                  subTitle="Could not fetch drift data. Check your connection and try again."
                  extra={<Button onClick={() => refetchDrifts()}>Retry</Button>}
                />
              ) : driftLoading ? (
                <Skeleton active paragraph={{ rows: 8 }} />
              ) : (
                <DriftList
                  drifts={drifts}
                  loading={driftLoading}
                  onUserClick={openIdentity}
                  onAutoFix={canOperate ? handleAutoFix : undefined}
                  onIgnore={canOperate ? handleIgnore : undefined}
                  canOperate={canOperate}
                  emptyMessage="No drifts detected"
                  pagination={{
                    current: driftPage,
                    pageSize: DRIFT_PAGE_SIZE,
                    total: driftTotal,
                    onChange: setDriftPage,
                  }}
                  filters={{
                    severity: driftFilters.severity ?? 'all',
                    type: driftFilters.type ?? 'all',
                    targetSystem: driftFilters.targetSystem ?? 'all',
                    search: driftFilters.search ?? '',
                  }}
                  onFilterChange={handleDriftFilterChange}
                />
              ),
            },
            {
              key: 'orphans',
              label: 'Orphaned accounts',
              children: <OrphanedAccountsList />,
            },
            {
              key: 'connectors',
              label: 'Connector health',
              children: hasHealthError ? (
                <Result
                  status="warning"
                  title="Failed to load connector health"
                  subTitle="Could not fetch health status. Check your connection and try again."
                  extra={<Button onClick={() => refetchHealth()}>Retry</Button>}
                />
              ) : healthLoading ? (
                <Skeleton active paragraph={{ rows: 6 }} />
              ) : (
                <ConnectorHealth
                  healthList={connectorHealth}
                  loading={healthLoading}
                  onCheckNow={handleCheckConnectorHealth}
                />
              ),
            },
          ]}
        />
      </Card>
    </PageContainer>
  );
};
