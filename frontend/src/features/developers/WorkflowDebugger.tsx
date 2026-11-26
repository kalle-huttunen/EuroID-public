/**
 * Workflow Debugger – view and debug Temporal workflows (onboarding, offboarding, reconciliation, bulk).
 * Design: VS Code Debug Panel style; split layout list + step timeline; expandable step output.
 * Fetches from GET /api/v1/dev/workflows via useWorkflows.
 */

import React, { useState, useMemo, useEffect } from "react";
import {
  Card,
  Row,
  Col,
  Button,
  Select,
  Space,
  Typography,
  Steps,
  Tag,
  Skeleton,
  Collapse,
  Result,
  theme,
  message,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { IWorkflowExecution, WorkflowType, WorkflowStatus } from "../../interfaces";
import { useWorkflows } from "@api/devtools-api";
import { BRAND, SEMANTIC } from "../../theme";
import { relativeTime } from "../../utils/date-helpers";
import { PageContainer, PageHeader } from "@shared/PageHeader";

const { Text } = Typography;

const WORKFLOW_TYPES: { value: WorkflowType; label: string }[] = [
  { value: "ONBOARDING", label: "Onboarding" },
  { value: "OFFBOARDING", label: "Offboarding" },
  { value: "RECONCILIATION", label: "Reconciliation" },
  { value: "BULK_PROVISIONING", label: "Bulk Provisioning" },
  { value: "DISTRIBUTED_TRANSACTION", label: "Distributed Transaction" },
];

const WORKFLOW_STATUSES: { value: WorkflowStatus; label: string }[] = [
  { value: "RUNNING", label: "Running" },
  { value: "COMPLETED", label: "Completed" },
  { value: "FAILED", label: "Failed" },
  { value: "TIMED_OUT", label: "Timed out" },
  { value: "CANCELLED", label: "Cancelled" },
];

function statusDot(status: WorkflowStatus) {
  const map: Record<WorkflowStatus, { color: string; pulse?: boolean }> = {
    COMPLETED: { color: BRAND.success },
    RUNNING: { color: BRAND.primary, pulse: true },
    FAILED: { color: BRAND.error },
    TIMED_OUT: { color: BRAND.warning },
    CANCELLED: { color: SEMANTIC.statusInactive },
  };
  const { color, pulse } = map[status] ?? { color: SEMANTIC.statusInactive };
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        backgroundColor: color,
        marginRight: 8,
        animation: pulse ? "workflow-pulse 1.5s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function formatDuration(ms?: number): string {
  if (ms == null) return "-";
  if (ms < 1000) return String(ms) + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

export const WorkflowDebugger: React.FC = () => {
  const { token } = theme.useToken();
  const [selected, setSelected] = useState<IWorkflowExecution | null>(null);
  const [filterType, setFilterType] = useState<WorkflowType | undefined>();
  const [filterStatus, setFilterStatus] = useState<WorkflowStatus | undefined>();
  const [expandedStepIndex, setExpandedStepIndex] = useState<number | null>(null);

  const { data: workflows = [], isLoading, isError, error, refetch } = useWorkflows({
    type: filterType,
    status: filterStatus,
  });

  useEffect(() => {
    queueMicrotask(() => {
      if (workflows.length === 0) setSelected(null);
      else if (!selected || !workflows.some((w) => w.workflowId === selected.workflowId)) {
        setSelected(workflows[0]);
      }
    });
  }, [workflows, selected]);

  useEffect(() => {
    if (isError && error) {
      message.error(`Failed to load workflows: ${error instanceof Error ? error.message : "Developer API may not be available"}`);
    }
  }, [isError, error]);

  const filtered = useMemo(() => {
    let list = workflows;
    if (filterType) list = list.filter((w) => w.type === filterType);
    if (filterStatus) list = list.filter((w) => w.status === filterStatus);
    return list;
  }, [workflows, filterType, filterStatus]);

  const handleRefresh = () => refetch();

  const isApiUnavailable = isError && error && typeof error === "object" && "response" in error
    ? (error as { response?: { status?: number } }).response?.status === 404
    : false;

  const stepStatusMap = {
    pending: "wait" as const,
    running: "process" as const,
    completed: "finish" as const,
    failed: "error" as const,
    skipped: "wait" as const,
  };

  return (
    <PageContainer>
      <style>
        {"@keyframes workflow-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }"}
      </style>
      <PageHeader
        title="Workflow debugger"
        subtitle="Inspect Temporal workflow runs, their activities and failures"
        actions={
          <>
            <Select
              placeholder="Filter by type"
              allowClear
              style={{ minWidth: 160 }}
              value={filterType ?? undefined}
              onChange={(v) => setFilterType(v ?? undefined)}
              options={WORKFLOW_TYPES.map((o) => ({ value: o.value, label: o.label }))}
              aria-label="Filter by workflow type"
            />
            <Select
              placeholder="Filter by status"
              allowClear
              style={{ minWidth: 140 }}
              value={filterStatus ?? undefined}
              onChange={(v) => setFilterStatus(v ?? undefined)}
              options={WORKFLOW_STATUSES.map((o) => ({ value: o.value, label: o.label }))}
              aria-label="Filter by workflow status"
            />
            <Button icon={<ReloadOutlined />} onClick={handleRefresh} loading={isLoading}>
              Refresh
            </Button>
          </>
        }
      />

      <Row gutter={24} style={{ minHeight: 480 }}>
        {/* Left: Workflow list ~35% */}
        <Col xs={24} lg={8} xl={7}>
          <Card
            title="Workflows"
            size="small"
            style={{ height: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}
            styles={{ body: { flex: 1, overflow: "auto", padding: 0 } }}
          >
            {isApiUnavailable ? (
              <div style={{ padding: 16 }}>
                <Result
                  status="info"
                  title="Developer API not available"
                  subTitle="Workflow debugging endpoints may not be deployed yet. Check back later."
                  extra={<Button onClick={() => refetch()}>Retry</Button>}
                />
              </div>
            ) : isLoading ? (
              <div style={{ padding: 16 }}>
                <Skeleton active paragraph={{ rows: 6 }} />
              </div>
            ) : (
              <div style={{ padding: 8 }}>
                {filtered.length === 0 ? (
                  <Text type="secondary">No workflows found.</Text>
                ) : (
                  filtered.map((w) => (
                    <div
                      key={w.workflowId}
                      onClick={() => {
                        setSelected(w);
                        setExpandedStepIndex(null);
                      }}
                      style={{
                        padding: "10px 12px",
                        marginBottom: 4,
                        borderRadius: token.borderRadius,
                        cursor: "pointer",
                        background: selected?.workflowId === w.workflowId ? token.colorPrimaryBg : undefined,
                        border: selected?.workflowId === w.workflowId ? "1px solid " + token.colorPrimaryBorder : "1px solid transparent",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
                        {statusDot(w.status)}
                        <Text strong style={{ fontSize: 12 }} ellipsis>
                          {w.workflowId}
                        </Text>
                      </div>
                      <Tag style={{ marginBottom: 4 }}>{w.type.replace(/_/g, " ")}</Tag>
                      <div>
                        <Text type="secondary" style={{ fontSize: 12 }}>{w.targetDescription}</Text>
                      </div>
                      <div style={{ fontSize: 11, color: token.colorTextTertiary, marginTop: 2 }}>
                        {relativeTime(w.startedAt)} · {formatDuration(w.durationMs)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </Card>
        </Col>

        {/* Right: Detail */}
        <Col xs={24} lg={16} xl={17}>
          <Card
            title={selected ? selected.workflowId + " – " + selected.type : "Select a workflow"}
            size="small"
            style={{ height: "100%", minHeight: 400 }}
          >
            {!selected ? (
              <div style={{ padding: 48, textAlign: "center" }}>
                <Text type="secondary">Click a workflow to see step-by-step execution.</Text>
              </div>
            ) : isLoading ? (
              <Skeleton active paragraph={{ rows: 8 }} />
            ) : (
              <>
                <div style={{ marginBottom: 16 }}>
                  <Space split={<span style={{ color: token.colorBorder }}>|</span>}>
                    <Text type="secondary">Triggered by {selected.triggeredBy}</Text>
                    <Text type="secondary">Target: {selected.targetDescription}</Text>
                    <Tag color={selected.status === "COMPLETED" ? "green" : selected.status === "FAILED" ? "red" : "blue"}>
                      {selected.status}
                    </Tag>
                    <Text type="secondary">{formatDuration(selected.durationMs)}</Text>
                  </Space>
                </div>

                <Steps
                  direction="vertical"
                  size="small"
                  current={selected.steps.findIndex((s) => s.status === "running") >= 0 ? selected.steps.findIndex((s) => s.status === "running") : selected.steps.length}
                  items={selected.steps.map((step, idx) => ({
                    title: (
                      <Space>
                        <span>{step.name}</span>
                        {step.durationMs != null && (
                          <Text type="secondary" style={{ fontSize: 12 }}>({formatDuration(step.durationMs)})</Text>
                        )}
                        {step.status === "failed" && step.error && (
                          <Text type="danger" style={{ fontSize: 12 }}>{step.error}</Text>
                        )}
                      </Space>
                    ),
                    status: stepStatusMap[step.status],
                    description: (
                      <div>
                        {(step.startedAt || step.completedAt) && (
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {step.startedAt && "Started: " + new Date(step.startedAt).toLocaleString()}
                            {step.completedAt && " · Completed: " + new Date(step.completedAt).toLocaleString()}
                          </Text>
                        )}
                        {step.output && Object.keys(step.output).length > 0 && (
                          <Collapse
                            ghost
                            activeKey={expandedStepIndex === idx ? ["out"] : []}
                            onChange={(keys) => setExpandedStepIndex(keys.includes("out") ? idx : null)}
                          >
                            <Collapse.Panel
                              header={<Text type="secondary" style={{ fontSize: 12 }}>View output (JSON)</Text>}
                              key="out"
                            >
                              <pre
                                style={{
                                  margin: 0,
                                  padding: 12,
                                  background: token.colorFillQuaternary,
                                  borderRadius: token.borderRadius,
                                  fontSize: 11,
                                  overflow: "auto",
                                  maxHeight: 200,
                                }}
                              >
                                {JSON.stringify(step.output, null, 2)}
                              </pre>
                            </Collapse.Panel>
                          </Collapse>
                        )}
                        {step.status === "failed" && step.error && (
                          <div style={{ marginTop: 4, padding: 8, background: token.colorErrorBg, borderRadius: token.borderRadius }}>
                            <Text type="danger">{step.error}</Text>
                          </div>
                        )}
                      </div>
                    ),
                  }))}
                />
              </>
            )}
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
};
