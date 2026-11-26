/**
 * RequestDetail — full view of an access request with approval chain
 */
import React, { useState } from 'react';
import {
  Alert,
  Card,
  Descriptions,
  Tag,
  Timeline,
  Button,
  Typography,
  Skeleton,
  theme,
} from 'antd';
import { ArrowLeftOutlined, CheckOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import {
  useRequestDetail,
  useCancelRequest,
  type AccessRequest,
  type StoredSodViolation,
} from '@api/access-requests-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { ErrorState } from '@shared/ErrorState';
import { usePermission } from '../../auth/usePermission';
import { RemovedManuallyModal } from './RemovedManuallyModal';

const { Text } = Typography;

/** An ACTIVE request past its end date: its removal is due and has not succeeded yet. */
function removalOverdue(r: AccessRequest): boolean {
  const end = r.expiresAt ?? r.timeConstraint?.expiresAt;
  return r.status === 'ACTIVE' && !!end && new Date(end).getTime() <= Date.now();
}

const STATUS_COLORS: Record<string, string> = {
  PENDING_APPROVAL: 'processing',
  APPROVED: 'success',
  REJECTED: 'error',
  PROVISIONING: 'processing',
  ACTIVE: 'success',
  EXPIRED: 'default',
  REVOKED: 'warning',
  CANCELLED: 'default',
  // The approval workflow could not be started when the request was created
  FAILED: 'error',
};

/** Segregation of duties matches stored with the request, as a card the reviewer reads. */
const SodCard: React.FC<{
  title: string;
  type: 'warning' | 'error';
  message: string;
  violations: StoredSodViolation[];
}> = ({ title, type, message, violations }) => (
  <section aria-label={title} style={{ marginTop: 16 }}>
    <Card title={title}>
      <Alert
        type={type}
        showIcon
        message={message}
        description={
          <ul style={{ margin: '8px 0 0 0', paddingLeft: 20 }}>
            {violations.map((v, i) => (
              <li key={i}>
                <Text strong>{v.policyName}</Text> ({v.severity})
                {v.conflictingEntitlements?.length > 0 && (
                  <span>: {v.conflictingEntitlements.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        }
      />
    </Card>
  </section>
);

export const RequestDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const { data: request, isLoading, isError, error, refetch } = useRequestDetail(id);
  const cancelMutation = useCancelRequest();
  // Asserts a removal EuroID cannot verify: policy-admin, as the route
  const canCloseRemoval = usePermission('policy-admin');
  const [closingRemoval, setClosingRemoval] = useState(false);

  const backButton = (
    <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/access-requests')}>
      Back
    </Button>
  );

  if (isLoading || isError || !request) {
    return (
      <PageContainer>
        <PageHeader title="Access request" actions={backButton} />
        {isError ? (
          <ErrorState title="Could not load this request" error={error} onRetry={() => refetch()} />
        ) : (
          <Skeleton active paragraph={{ rows: 8 }} aria-busy aria-label="Loading request" />
        )}
      </PageContainer>
    );
  }

  const r = request as AccessRequest;
  const canCancel = r.status === 'PENDING_APPROVAL' && cancelMutation.isPending === false;
  const offerRemovedManually = canCloseRemoval && removalOverdue(r);

  const timelineItems = r.approvalSteps?.map((step) => ({
    color:
      step.status === 'APPROVED'
        ? token.colorSuccess
        : step.status === 'REJECTED'
          ? token.colorError
          : token.colorTextQuaternary,
    children: (
      <div>
        <Text strong>
          Step {step.stepOrder + 1}: {step.approverType}
          {step.approverEmail && ` (${step.approverEmail})`}
        </Text>
        <br />
        <Tag
          color={
            step.status === 'PENDING'
              ? 'processing'
              : step.status === 'APPROVED'
                ? 'success'
                : 'error'
          }
        >
          {step.status}
        </Tag>
        {step.decidedAt && (
          <Text type="secondary" style={{ marginLeft: 8 }}>
            {new Date(step.decidedAt).toLocaleString()}
          </Text>
        )}
        {step.justification && (
          <div style={{ marginTop: 4 }}>
            <Text type="secondary">{step.justification}</Text>
          </div>
        )}
      </div>
    ),
  }));

  return (
    <PageContainer>
      <PageHeader
        title="Access request"
        titleExtra={<Tag color={STATUS_COLORS[r.status]}>{r.status}</Tag>}
        subtitle={<span className="mono">{r.requestId}</span>}
        actions={
          <>
            {backButton}
            {canCancel && (
              <Button
                danger
                onClick={async () => {
                  await cancelMutation.mutateAsync(r.requestId);
                  navigate('/access-requests');
                }}
              >
                Cancel request
              </Button>
            )}
            {offerRemovedManually && (
              <Button icon={<CheckOutlined />} onClick={() => setClosingRemoval(true)}>
                Mark removed manually
              </Button>
            )}
          </>
        }
      />

      {r.statusReason && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={
            // An ACTIVE request with a reason: its removal at the end date was refused
            r.status === 'ACTIVE'
              ? 'Access not removed yet'
              : r.removedManually
                ? 'Closed as removed manually'
                : `Closed as ${r.status}`
          }
          description={
            r.removedManually ? (
              <>
                <div>{r.statusReason}</div>
                <Text type="secondary">
                  By {r.removedManually.by}, {new Date(r.removedManually.at).toLocaleString()}
                </Text>
              </>
            ) : (
              r.statusReason
            )
          }
        />
      )}
      {offerRemovedManually && (
        <RemovedManuallyModal
          request={r}
          open={closingRemoval}
          onClose={() => setClosingRemoval(false)}
        />
      )}

      <Card title="Request details">
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="Request ID">
            <Text copyable code>
              {r.requestId}
            </Text>
          </Descriptions.Item>
          <Descriptions.Item label="Status">
            <Tag color={STATUS_COLORS[r.status]}>{r.status}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Requester">{r.requesterEmail}</Descriptions.Item>
          <Descriptions.Item label="Created">
            {r.createdAt ? new Date(r.createdAt).toLocaleString() : '—'}
          </Descriptions.Item>
          {r.provisionedAt && (
            <Descriptions.Item label="Provisioned">
              {new Date(r.provisionedAt).toLocaleString()}
            </Descriptions.Item>
          )}
          {r.expiresAt && (
            <Descriptions.Item label="Expires">
              {new Date(r.expiresAt).toLocaleString()}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <Card title="Entitlements" style={{ marginTop: 16 }}>
        <ul>
          {r.entitlements?.map((e, i) => (
            <li key={i}>
              <Text strong>{e.entitlementName}</Text> ({e.system}) — {e.justification}
            </li>
          ))}
        </ul>
      </Card>

      {r.approvalSteps?.length > 0 && (
        <Card title="Approval chain" style={{ marginTop: 16 }}>
          <Timeline items={timelineItems} />
        </Card>
      )}

      {r.sodCheckResult?.passed === false && (
        <SodCard
          title="Segregation of duties conflict"
          type="error"
          message="Rejected before fulfilment: when the last approval came in, the person already held access that a Block policy forbids together with this request."
          violations={r.sodCheckResult.violations ?? []}
        />
      )}
      {r.sodCheckResult?.passed && (r.sodCheckResult.violations?.length ?? 0) > 0 && (
        <SodCard
          title="Segregation of duties warnings"
          type="warning"
          message="With this request the person would hold every entitlement of these policies. Warn policies do not stop the request: weigh them before you approve."
          violations={r.sodCheckResult.violations ?? []}
        />
      )}
    </PageContainer>
  );
};
