/**
 * Transaction Viewer – inspect distributed transactions (2-phase commit) across target systems.
 * Expandable table with phase timeline and per-system participation.
 * Fetches from GET /api/v1/dev/transactions via useTransactions.
 */

import React, { useState, useMemo, useEffect } from "react";
import {
  Card,
  Button,
  Select,
  Space,
  Typography,
  Table,
  Tag,
  Badge,
  Skeleton,
  Row,
  Col,
  Result,
  theme,
  message,
} from "antd";
import { ReloadOutlined, CheckCircleOutlined, CloseCircleOutlined, RollbackOutlined } from "@ant-design/icons";
import type { IDistributedTransaction, TransactionPhase } from "../../interfaces";
import { useTransactions } from "@api/devtools-api";
import { PageContainer, PageHeader } from "@shared/PageHeader";
import { SEMANTIC } from "@theme/themeConfig";

const { Text } = Typography;

const PHASES: TransactionPhase[] = [
  "PREPARING",
  "PREPARED",
  "COMMITTING",
  "COMMITTED",
  "ROLLING_BACK",
  "ROLLED_BACK",
  "ROLLBACK_FAILED",
  "FAILED",
];

const PHASE_ORDER: Record<TransactionPhase, number> = {
  PREPARING: 0,
  PREPARED: 1,
  COMMITTING: 2,
  COMMITTED: 3,
  ROLLING_BACK: 4,
  ROLLED_BACK: 5,
  ROLLBACK_FAILED: 6,
  FAILED: 7,
};

/** Rollback phases after which the timeline shows ROLLING_BACK and the outcome. */
const ROLLBACK_OUTCOMES: TransactionPhase[] = ["ROLLED_BACK", "ROLLBACK_FAILED", "FAILED"];

/** ROLLBACK_FAILED is not "rolled back": a committed change is still in the target system. */
function phaseLabel(phase: TransactionPhase): string {
  return phase === "ROLLBACK_FAILED" ? "ROLLBACK FAILED, CHANGES REMAIN" : phase.replace(/_/g, " ");
}

function phaseColor(phase: TransactionPhase): string {
  switch (phase) {
    case "ROLLBACK_FAILED":
      return SEMANTIC.statusError;
    case "COMMITTED":
      return "green";
    case "ROLLED_BACK":
      return "orange";
    case "FAILED":
      return "red";
    case "PREPARING":
    case "COMMITTING":
    case "ROLLING_BACK":
      return "blue";
    case "PREPARED":
      return "cyan";
    default:
      return "default";
  }
}

function formatDuration(ms?: number): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export const TransactionViewer: React.FC = () => {
  const { token } = theme.useToken();
  const [filterPhase, setFilterPhase] = useState<TransactionPhase | undefined>();
  const [dateRange, setDateRange] = useState<"all" | "today" | "week">("all");
  const [cutoff, setCutoff] = useState<number | null>(null);

  const { data: transactions = [], isLoading, isError, error, refetch } = useTransactions({
    phase: filterPhase,
  });

  useEffect(() => {
    if (isError && error) {
      message.error(`Failed to load transactions: ${error instanceof Error ? error.message : "Developer API may not be available"}`);
    }
  }, [isError, error]);

  useEffect(() => {
    if (dateRange === "all") {
      queueMicrotask(() => setCutoff(null));
    } else {
      queueMicrotask(() => {
        const now = Date.now();
        const day = 24 * 60 * 60 * 1000;
        setCutoff(dateRange === "today" ? now - day : now - 7 * day);
      });
    }
  }, [dateRange]);

  const filtered = useMemo(() => {
    let list = transactions;
    if (filterPhase) list = list.filter((t) => t.phase === filterPhase);
    if (dateRange !== "all" && cutoff != null) {
      list = list.filter((t) => new Date(t.startedAt).getTime() >= cutoff);
    }
    return list;
  }, [transactions, filterPhase, dateRange, cutoff]);

  const handleRefresh = () => refetch();

  const isApiUnavailable = isError && error && typeof error === "object" && "response" in error
    ? (error as { response?: { status?: number } }).response?.status === 404
    : false;

  const columns = [
    {
      title: "TX ID",
      dataIndex: "transactionId",
      key: "transactionId",
      width: 100,
      render: (id: string) => <Text strong style={{ fontFamily: token.fontFamilyCode }}>{id}</Text>,
    },
    {
      title: "Phase",
      dataIndex: "phase",
      key: "phase",
      width: 120,
      render: (phase: TransactionPhase) => <Tag color={phaseColor(phase)}>{phaseLabel(phase)}</Tag>,
    },
    {
      title: "Operation",
      dataIndex: "operation",
      key: "operation",
      width: 100,
    },
    {
      title: "Systems",
      key: "systems",
      width: 80,
      render: (_: unknown, r: IDistributedTransaction) => {
        const ok = r.participants.filter((p) => p.status === "COMMITTED").length;
        const total = r.participants.length;
        return `${ok}/${total}`;
      },
    },
    {
      title: "Time",
      key: "time",
      width: 80,
      render: (_: unknown, r: IDistributedTransaction) => {
        const start = new Date(r.startedAt).getTime();
        const end = r.completedAt ? new Date(r.completedAt).getTime() : Date.now();
        return formatDuration(end - start);
      },
    },
    {
      title: "Status",
      key: "status",
      width: 60,
      render: (_: unknown, r: IDistributedTransaction) => {
        if (r.phase === "COMMITTED") return <CheckCircleOutlined style={{ color: token.colorSuccess }} />;
        if (ROLLBACK_OUTCOMES.includes(r.phase)) return <CloseCircleOutlined style={{ color: token.colorError }} />;
        return <RollbackOutlined style={{ color: token.colorWarning }} />;
      },
    },
  ];

  const expandedRowRender = (record: IDistributedTransaction) => {
    const phasesInOrder = (["PREPARING", "PREPARED", "COMMITTING", "COMMITTED"] as TransactionPhase[]).filter(
      (p) => PHASE_ORDER[p] <= PHASE_ORDER[record.phase] || record.phase === "ROLLING_BACK" || ROLLBACK_OUTCOMES.includes(record.phase)
    );
    if (record.phase === "ROLLBACK_FAILED") {
      phasesInOrder.push("ROLLING_BACK", "ROLLBACK_FAILED");
    } else if (record.phase === "ROLLED_BACK" || record.phase === "FAILED") {
      phasesInOrder.push("ROLLING_BACK", "ROLLED_BACK");
      if (record.phase === "FAILED") phasesInOrder.push("FAILED");
    }

    return (
      <div style={{ padding: "16px 24px", background: token.colorFillQuaternary, borderRadius: token.borderRadius }}>
        <Row gutter={[24, 16]}>
          <Col span={24}>
            <Text strong style={{ marginBottom: 8, display: "block" }}>Phase timeline</Text>
            <Space size="small" wrap>
              {phasesInOrder.map((p, i) => (
                <span key={p}>
                  <Tag color={p === record.phase ? phaseColor(p) : "default"}>{phaseLabel(p)}</Tag>
                  {i < phasesInOrder.length - 1 && <span style={{ color: token.colorTextTertiary }}>→</span>}
                </span>
              ))}
            </Space>
          </Col>
          <Col span={24}>
            <Text strong style={{ marginBottom: 8, display: "block" }}>System participation</Text>
            <Table
              size="small"
              pagination={false}
              dataSource={record.participants.map((p, i) => ({ ...p, key: p.systemName + i }))}
              columns={[
                {
                  title: "System",
                  dataIndex: "systemName",
                  key: "systemName",
                  render: (name: string) => <Text strong>{name}</Text>,
                },
                {
                  title: "Prepare",
                  key: "prepare",
                  render: (_: unknown, p: IDistributedTransaction["participants"][0]) =>
                    p.status === "PREPARED" || p.status === "COMMITTED" || p.status === "ROLLED_BACK" || p.status === "ROLLBACK_FAILED" ? (
                      <span><CheckCircleOutlined style={{ color: token.colorSuccess, marginRight: 4 }} />{p.preparedAt && formatDuration(p.durationMs)}</span>
                    ) : p.status === "FAILED" && p.error ? (
                      <span><CloseCircleOutlined style={{ color: token.colorError, marginRight: 4 }} />{formatDuration(p.durationMs)}</span>
                    ) : (
                      "—"
                    ),
                },
                {
                  title: "Commit",
                  key: "commit",
                  render: (_: unknown, p: IDistributedTransaction["participants"][0]) =>
                    p.status === "COMMITTED" ? (
                      <span><CheckCircleOutlined style={{ color: token.colorSuccess, marginRight: 4 }} />{p.committedAt && formatDuration(p.durationMs)}</span>
                    ) : p.status === "ROLLBACK_FAILED" ? (
                      <Text type="danger">Committed, restore failed: change still in place{p.error ? ` (${p.error})` : ""}</Text>
                    ) : p.rolledBackAt ? (
                      <span><RollbackOutlined style={{ color: token.colorWarning, marginRight: 4 }} />ROLLBACK</span>
                    ) : p.error ? (
                      <Text type="danger">{p.error}</Text>
                    ) : (
                      "—"
                    ),
                },
                {
                  title: "Duration",
                  key: "duration",
                  render: (_: unknown, p: IDistributedTransaction["participants"][0]) => formatDuration(p.durationMs),
                },
              ]}
            />
          </Col>
          {(record.notes || record.autoRollback) && (
            <Col span={24}>
              <Space>
                {record.autoRollback && (
                  <Badge status="processing" text="Auto-rollback enabled" />
                )}
                {record.notes && <Text type="secondary">{record.notes}</Text>}
              </Space>
            </Col>
          )}
        </Row>
      </div>
    );
  };

  return (
    <PageContainer>
      <PageHeader
        title="Transaction viewer"
        subtitle="Distributed provisioning transactions across target systems, phase by phase"
        actions={
          <>
            <Select
              placeholder="Filter by phase"
              allowClear
              style={{ minWidth: 140 }}
              value={filterPhase ?? undefined}
              onChange={(v) => setFilterPhase(v ?? undefined)}
              options={PHASES.map((p) => ({ value: p, label: phaseLabel(p) }))}
              aria-label="Filter by phase"
            />
            <Select
              value={dateRange}
              style={{ minWidth: 120 }}
              onChange={setDateRange}
              options={[
                { value: "all", label: "All time" },
                { value: "today", label: "Today" },
                { value: "week", label: "Last 7 days" },
              ]}
              aria-label="Date range"
            />
            <Button icon={<ReloadOutlined />} onClick={handleRefresh} loading={isLoading}>
              Refresh
            </Button>
          </>
        }
      />

      <Card size="small">
        {isApiUnavailable ? (
          <Result
            status="info"
            title="Developer API not available"
            subTitle="Transaction viewer endpoints may not be deployed yet. Check back later."
            extra={<Button onClick={() => refetch()}>Retry</Button>}
          />
        ) : isLoading ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <Table
            rowKey="transactionId"
            columns={columns}
            dataSource={filtered}
            expandable={{
              expandedRowRender,
              rowExpandable: () => true,
            }}
            pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `Total ${t} transactions` }}
            size="small"
          />
        )}
      </Card>
    </PageContainer>
  );
};
