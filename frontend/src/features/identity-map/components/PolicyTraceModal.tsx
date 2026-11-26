/**
 * PolicyTraceModal — F-02: Policy trace drill-down for entitlements, in a centered modal.
 *
 * Shows which policy assigned an entitlement, governance level,
 * origin, risk level, approval chain, and time-bound expiry. An entitlement a policy grants but an
 * access review revoked (an active review exclusion) is shown as suppressed by access review.
 * Read-only: no footer.
 */

import React from 'react';
import { Descriptions, Modal, Space, Tag, Typography } from 'antd';
import { SafetyCertificateOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { SEMANTIC } from '@theme/themeConfig';
import type { EntitlementChipData } from '../canvas/EntitlementChip';
import type { PolicyProvisioningIntent } from '@api/identity-map-api';

const { Text } = Typography;

interface PolicyTraceModalProps {
  entitlement: EntitlementChipData | null;
  policyIntent: PolicyProvisioningIntent | null;
  open: boolean;
  onClose: () => void;
}

const GOVERNANCE_COLORS: Record<string, string> = {
  STRICT: SEMANTIC.statusError,
  OPEN: SEMANTIC.statusSynced,
};

export const PolicyTraceModal: React.FC<PolicyTraceModalProps> = ({
  entitlement,
  policyIntent,
  open,
  onClose,
}) => {
  if (!entitlement) return null;

  // A grant of this entitlement an access review exclusion left out of the identity's access
  const suppressedOp = policyIntent?.operations.some((op) => op.targetId === entitlement.name)
    ? undefined
    : policyIntent?.suppressedOperations?.find((op) => op.targetId === entitlement.name);

  // Find matching policy operation
  const matchingOp = suppressedOp
    ? undefined
    : policyIntent?.operations.find(
        (op) => op.targetId === entitlement.name || op.sourcePolicy === entitlement.sourcePolicy,
      );

  // A time-bound access request's end date (GET /identity/:id/entitlements, via the chip)
  const requestTimeConstraint = entitlement.expiresAt
    ? { expiresAt: entitlement.expiresAt }
    : undefined;

  const rawTimeConstraint = matchingOp?.timeConstraint ?? requestTimeConstraint;
  const timeConstraint = rawTimeConstraint as
    | { durationDays?: number; requestedDurationDays?: number; expiresAt?: string }
    | undefined;

  return (
    <Modal
      title={
        <Space>
          <SafetyCertificateOutlined />
          <span style={{ wordBreak: 'break-word' }}>Policy Trace: {entitlement.name}</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
      styles={{ body: { maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' } }}
    >
      <Descriptions column={1} bordered size="small">
        <Descriptions.Item label="Entitlement">
          <Text strong>{entitlement.name}</Text>
        </Descriptions.Item>

        <Descriptions.Item label="Type">
          <Tag>{entitlement.type}</Tag>
        </Descriptions.Item>

        <Descriptions.Item label="Origin">
          <Tag color={entitlement.origin === 'POLICY' ? SEMANTIC.statusRunning : undefined}>
            {entitlement.origin}
          </Tag>
        </Descriptions.Item>

        <Descriptions.Item label="Governance Level">
          {entitlement.governanceLevel ? (
            <Tag color={GOVERNANCE_COLORS[entitlement.governanceLevel]}>
              {entitlement.governanceLevel}
            </Tag>
          ) : (
            <Text type="secondary">Not set</Text>
          )}
        </Descriptions.Item>

        <Descriptions.Item label="Provisioned">
          <Tag color={entitlement.isProvisioned ? SEMANTIC.statusSynced : SEMANTIC.statusDriftText}>
            {entitlement.isProvisioned ? 'Yes' : 'Pending'}
          </Tag>
        </Descriptions.Item>

        {entitlement.sourcePolicy && (
          <Descriptions.Item label="Source Policy">
            <Text>{entitlement.sourcePolicy}</Text>
          </Descriptions.Item>
        )}

        {matchingOp && (
          <Descriptions.Item label="Policy Action">
            <Tag>{matchingOp.action.toUpperCase()}</Tag>
            <Text type="secondary"> on {matchingOp.target}</Text>
          </Descriptions.Item>
        )}

        {suppressedOp && (
          <Descriptions.Item label="Policy Action">
            <Tag color={SEMANTIC.statusError}>SUPPRESSED</Tag>
            <Text>{suppressedOp.suppressedBy.reason}</Text>
            <Text type="secondary">
              {' '}
              ({suppressedOp.sourcePolicy} on {suppressedOp.target})
            </Text>
          </Descriptions.Item>
        )}

        {timeConstraint && (
          <Descriptions.Item label="Time Constraint">
            <Space>
              <ClockCircleOutlined style={{ color: SEMANTIC.statusDrift }} />
              {timeConstraint.expiresAt ? (
                <Text>Expires: {new Date(timeConstraint.expiresAt).toLocaleDateString()}</Text>
              ) : timeConstraint.requestedDurationDays || timeConstraint.durationDays ? (
                <Text>
                  Duration: {timeConstraint.requestedDurationDays ?? timeConstraint.durationDays}{' '}
                  days
                </Text>
              ) : (
                <Text type="secondary">Permanent</Text>
              )}
            </Space>
          </Descriptions.Item>
        )}
      </Descriptions>

      {policyIntent?.sodValidation &&
        (policyIntent.sodValidation.warnings.length > 0 ||
          policyIntent.sodValidation.blockers.length > 0) && (
          <div style={{ marginTop: 16 }}>
            <Text strong>Separation of Duties</Text>
            {policyIntent.sodValidation.blockers.length > 0 && (
              <Tag color={SEMANTIC.statusError} style={{ marginLeft: 8 }}>
                {policyIntent.sodValidation.blockers.length} blocker(s)
              </Tag>
            )}
            {policyIntent.sodValidation.warnings.length > 0 && (
              <Tag color={SEMANTIC.statusDriftText} style={{ marginLeft: 8 }}>
                {policyIntent.sodValidation.warnings.length} warning(s)
              </Tag>
            )}
          </div>
        )}
    </Modal>
  );
};
