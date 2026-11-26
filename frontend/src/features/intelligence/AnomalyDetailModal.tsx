/**
 * One anomaly in a centered modal: what was detected, the evidence, and the actions the
 * viewer's role allows, gated like `anomaly.controller.ts` (acknowledge, resolve, dismiss:
 * operator; analyse the identity again: super-admin). Resolve and dismiss are confirmed first.
 * Each action reports what it did inside the modal, which stays open on the updated anomaly.
 * The body scrolls under a fixed title and footer.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Input, Modal, Skeleton, Space, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined,
  CheckOutlined,
  CloseOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { Link, useLocation } from 'react-router-dom';
import dayjs from 'dayjs';
import {
  useAcknowledgeAnomaly,
  useAnalyzeAnomalies,
  useAnomaly,
  useDismissAnomaly,
  useResolveAnomaly,
  type Anomaly,
} from '@api/intelligence-api';
import { usePermission } from '../../auth/usePermission';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { identityPath } from '../users/identity-path';
import {
  ANOMALY_TYPE_LABELS,
  SEVERITY_COLORS,
  STATUS_COLORS,
  acknowledgeOutcome,
  analysisOutcome,
  dismissOutcome,
  isActive,
  resolveOutcome,
  type AnomalyOutcome,
} from './anomaly-labels';

const { Paragraph, Text } = Typography;

/** Fits the evidence list and the four actions on one footer row. */
const MODAL_WIDTH = 720;

const formatTime = (iso?: string) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm:ss') : undefined);

type Action = 'acknowledge' | 'resolve' | 'dismiss' | 'analyze';
const ACTION_NAME: Record<Action, string> = {
  acknowledge: 'Acknowledge',
  resolve: 'Resolve',
  dismiss: 'Dismiss',
  analyze: 'Analysis',
};

export const AnomalyDetailModal: React.FC<{
  /** `anomalyId` of the anomaly to show; null closes the modal. */
  anomalyId: string | null;
  /** The list row the modal opened from, shown until the detail has loaded. */
  row: Anomaly | null;
  /** Display name of the anomaly's identity, when the page knows it. */
  identityLabel?: string;
  onClose: () => void;
}> = ({ anomalyId, row, identityLabel, onClose }) => {
  const location = useLocation();
  const isOperator = usePermission('operator');
  const isSuperAdmin = usePermission('super-admin');
  const detail = useAnomaly(anomalyId);
  const acknowledge = useAcknowledgeAnomaly();
  const resolve = useResolveAnomaly();
  const dismiss = useDismissAnomaly();
  const analyze = useAnalyzeAnomalies();
  const [confirm, setConfirm] = useState<'resolve' | 'dismiss' | null>(null);
  const [reason, setReason] = useState('');
  // The last action's result, shown only for the anomaly it was run on.
  const [result, setResult] = useState<{ id: string; outcome: AnomalyOutcome } | null>(null);

  const anomaly = detail.data ?? row;
  const pending =
    acknowledge.isPending || resolve.isPending || dismiss.isPending || analyze.isPending;
  const outcome = anomalyId && result?.id === anomalyId ? result.outcome : null;

  // The button that ran an action is gone or disabled once the anomaly changed, and focus on
  // <body> would leave Escape and Tab outside the modal: it goes to the result instead. A
  // confirmed action does this after its confirmation has handed focus back to that button.
  const resultRef = useRef<HTMLDivElement>(null);
  const confirmedRan = useRef(false);
  useEffect(() => {
    if (outcome) resultRef.current?.focus();
  }, [outcome]);

  const close = () => {
    setResult(null);
    setConfirm(null);
    setReason('');
    onClose();
  };

  const run = async (action: Action) => {
    if (!anomalyId || !anomaly) return;
    const show = (next: AnomalyOutcome) => setResult({ id: anomalyId, outcome: next });
    try {
      if (action === 'acknowledge') {
        show(acknowledgeOutcome(await acknowledge.mutateAsync({ id: anomalyId })));
      } else if (action === 'resolve') {
        await resolve.mutateAsync({ id: anomalyId });
        show(resolveOutcome());
      } else if (action === 'dismiss') {
        const trimmed = reason.trim() || undefined;
        await dismiss.mutateAsync({ id: anomalyId, reason: trimmed });
        show(dismissOutcome(trimmed));
      } else {
        const done = await analyze.mutateAsync({ identityId: anomaly.identityId });
        show(analysisOutcome(done, 'identity'));
      }
    } catch (err) {
      show({
        type: 'error',
        message: `${ACTION_NAME[action]} failed: ${apiErrorMessage(err, 'the request failed')}`,
        description: 'The anomaly below shows its current state.',
      });
    } finally {
      confirmedRan.current = action === 'resolve' || action === 'dismiss';
      setConfirm(null);
      setReason('');
    }
  };

  const active = anomaly ? isActive(anomaly) : false;
  const note = !anomaly
    ? undefined
    : !active
      ? `The anomaly is ${anomaly.status}${isSuperAdmin ? '; only analysing the identity again is possible.' : '.'}`
      : !isSuperAdmin
        ? 'Analysing the identity again needs the super-admin role.'
        : undefined;

  const footer = anomaly ? (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        textAlign: 'start',
      }}
    >
      <Text type="secondary" style={{ fontSize: 12, flex: '1 1 200px' }}>
        {note}
      </Text>
      <Space wrap>
        {isSuperAdmin && (
          <Button
            icon={<SearchOutlined />}
            disabled={pending}
            loading={analyze.isPending}
            onClick={() => run('analyze')}
          >
            Analyse identity again
          </Button>
        )}
        {anomaly.status === 'open' && (
          <Button
            icon={<CheckOutlined />}
            disabled={pending}
            loading={acknowledge.isPending}
            onClick={() => run('acknowledge')}
          >
            Acknowledge
          </Button>
        )}
        <Button
          type="primary"
          icon={<CheckCircleOutlined />}
          disabled={!active || pending}
          onClick={() => setConfirm('resolve')}
        >
          Resolve
        </Button>
        <Button
          danger
          icon={<CloseOutlined />}
          disabled={!active || pending}
          onClick={() => setConfirm('dismiss')}
        >
          Dismiss
        </Button>
      </Space>
    </div>
  ) : null;

  const dismissReason = anomaly?.metadata?.dismissReason;

  return (
    <Modal
      open={!!anomalyId}
      onCancel={close}
      width={MODAL_WIDTH}
      title={
        anomaly ? (
          <Space size={8} wrap>
            <span>{anomaly.title}</span>
            <Tag color={STATUS_COLORS[anomaly.status]}>{anomaly.status}</Tag>
          </Space>
        ) : (
          'Anomaly'
        )
      }
      footer={isOperator ? footer : null}
      // The footer wraps to several rows on a narrow screen: the body gets the height the title
      // and the footer leave, so the actions stay on screen.
      styles={{
        content: { display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 200px)' },
        body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' },
      }}
    >
      {!anomaly ? (
        detail.isError ? (
          <Alert
            type="error"
            showIcon
            message={`Could not load this anomaly: ${apiErrorMessage(detail.error, 'the request failed')}`}
          />
        ) : (
          <Skeleton active aria-busy aria-label="Loading anomaly" />
        )
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {outcome && (
            <div ref={resultRef} tabIndex={-1} style={{ outline: 'none' }}>
              <Alert
                showIcon
                closable
                type={outcome.type}
                message={outcome.message}
                description={outcome.description}
                onClose={() => setResult(null)}
              />
            </div>
          )}
          {detail.isError && (
            <Alert
              type="warning"
              showIcon
              message="Could not reload this anomaly; showing it as listed."
            />
          )}
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Identity">
              <Space size={8} wrap>
                <span>{identityLabel || anomaly.identityId}</span>
                <Link
                  to={identityPath(anomaly.identityId, 'risk')}
                  state={{ from: location.pathname + location.search }}
                >
                  Open identity
                </Link>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="Type">
              <Tag color="blue">{ANOMALY_TYPE_LABELS[anomaly.type] ?? anomaly.type}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Severity">
              <Tag color={SEVERITY_COLORS[anomaly.severity]}>{anomaly.severity}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Risk score">{anomaly.riskScore}</Descriptions.Item>
            <Descriptions.Item label="Detected">{formatTime(anomaly.detectedAt)}</Descriptions.Item>
            {anomaly.acknowledgedBy && (
              <Descriptions.Item label="Acknowledged by">
                {anomaly.acknowledgedBy}
              </Descriptions.Item>
            )}
            {anomaly.resolvedAt && (
              <Descriptions.Item label="Closed">{formatTime(anomaly.resolvedAt)}</Descriptions.Item>
            )}
            {typeof dismissReason === 'string' && dismissReason && (
              <Descriptions.Item label="Dismiss reason">{dismissReason}</Descriptions.Item>
            )}
          </Descriptions>
          <div>
            <Text strong>Description</Text>
            <Paragraph style={{ margin: '4px 0 0' }}>{anomaly.description}</Paragraph>
          </div>
          <div>
            <Text strong>Evidence</Text>
            <Paragraph style={{ margin: '4px 0 0' }}>{anomaly.evidence?.pattern || '—'}</Paragraph>
            {anomaly.evidence?.events?.length ? (
              <ul aria-label="Evidence events" style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                {anomaly.evidence.events.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </Space>
      )}
      <Modal
        open={!!confirm}
        title={confirm === 'dismiss' ? 'Dismiss anomaly?' : 'Resolve anomaly?'}
        okText={confirm === 'dismiss' ? 'Dismiss' : 'Resolve'}
        okButtonProps={{ danger: confirm === 'dismiss' }}
        confirmLoading={pending}
        onOk={() => confirm && run(confirm)}
        onCancel={() => {
          setConfirm(null);
          setReason('');
        }}
        afterClose={() => {
          if (confirmedRan.current) resultRef.current?.focus();
          confirmedRan.current = false;
        }}
      >
        <Paragraph>
          {confirm === 'dismiss'
            ? 'Closes the anomaly as a false positive or accepted risk.'
            : 'Closes the anomaly as handled.'}{' '}
          Access is not changed. The audit log records the change.
        </Paragraph>
        {confirm === 'dismiss' && (
          <Input.TextArea
            aria-label="Dismiss reason"
            placeholder="Reason (optional)"
            value={reason}
            maxLength={1000}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </Modal>
    </Modal>
  );
};
