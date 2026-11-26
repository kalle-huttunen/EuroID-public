/**
 * Access reviews: what revoking did per reviewed entitlement, the campaign's revocation counts,
 * and the revoke dialog (a justification is required). Revocation runs when the campaign
 * closes: EuroID removes group memberships in Entra ID, AD, Okta and SCIM, and an account item
 * (type `account`: a target whose memberships EuroID cannot read) as offboarding removes the
 * account; anything else is shown as needing manual action, never as removed.
 */
import React from 'react';
import { Form, Input, Modal, Space, Tag, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import type { CampaignStatus, ReviewCampaign, ReviewItem } from '@api/intelligence-api';
import { REVOCATION_LABEL, REVOCATION_TAG } from './review-revocation-labels';

const { Text, Paragraph } = Typography;

/** The Revocation column: one tag per entitlement with a result, else what will happen. */
export const RevocationCell: React.FC<{
  item: ReviewItem;
  campaignStatus?: CampaignStatus;
  autoRevokeOnExpiry?: boolean;
}> = ({ item, campaignStatus, autoRevokeOnExpiry }) => {
  const results = (item.entitlements ?? []).filter((e) => e.revocation);
  if (results.length > 0) {
    return (
      <Space size={[4, 4]} wrap>
        {results.map((e, i) => {
          const r = e.revocation!;
          const why = r.reason ?? r.detail ?? REVOCATION_LABEL[r.outcome];
          return (
            <Tooltip
              key={i}
              title={`${e.name}: ${why} (${dayjs(r.at).format('YYYY-MM-DD HH:mm')})`}
            >
              <Tag color={REVOCATION_TAG[r.outcome]} tabIndex={0}>
                {e.system}: {REVOCATION_LABEL[r.outcome]}
              </Tag>
            </Tooltip>
          );
        })}
      </Space>
    );
  }
  const willRevoke =
    item.decision === 'revoked' || (item.decision === 'expired' && autoRevokeOnExpiry);
  if (item.decision === 'expired' && !autoRevokeOnExpiry) {
    return <Text type="secondary">Kept (auto-revoke off)</Text>;
  }
  if (!willRevoke) return <Text type="secondary">—</Text>;
  return (
    <Text type="secondary">
      {campaignStatus === 'ACTIVE' ? 'Removed when the campaign closes' : 'No result recorded'}
    </Text>
  );
};

/** Revocation counts of a completed campaign (absent when nothing was revoked). */
export const RevocationSummaryTags: React.FC<{
  summary?: ReviewCampaign['revocationSummary'];
}> = ({ summary }) => {
  if (!summary) return null;
  return (
    <Space wrap aria-label="Revocation results">
      <Text type="secondary">Revocations:</Text>
      <Tag color={REVOCATION_TAG.removed}>Removed: {summary.removed}</Tag>
      <Tag color={REVOCATION_TAG['already-gone']}>Already gone: {summary.alreadyGone}</Tag>
      <Tag color={REVOCATION_TAG['manual-action-needed']}>
        Manual action needed: {summary.manualActionNeeded}
      </Tag>
      <Tag color={REVOCATION_TAG.failed}>Failed: {summary.failed}</Tag>
    </Space>
  );
};

/** Confirmation for a revoke decision; the justification is required (backend rejects none). */
export const RevokeReviewModal: React.FC<{
  item: ReviewItem | null;
  loading: boolean;
  onSubmit: (justification: string) => void;
  onCancel: () => void;
}> = ({ item, loading, onSubmit, onCancel }) => {
  const [form] = Form.useForm<{ justification: string }>();
  const entitlements = (item?.entitlements ?? []).map((e) => `${e.system}: ${e.name}`).join(', ');
  const isAccount = (item?.entitlements ?? []).some((e) => e.type === 'account');
  return (
    <Modal
      title="Revoke access"
      open={!!item}
      okText="Revoke"
      okButtonProps={{ danger: true }}
      confirmLoading={loading}
      destroyOnHidden
      onCancel={onCancel}
      // Kept on a failed request; the form is dropped when the dialog closes. A failed
      // validation is shown on the field, so its rejection needs no further handling.
      onOk={() =>
        form
          .validateFields()
          .then((values) => onSubmit(values.justification.trim()))
          .catch(() => undefined)
      }
    >
      <Paragraph>
        Revoke <Text strong>{entitlements || 'this access'}</Text> for{' '}
        <Text strong>{item?.identityName}</Text>.
      </Paragraph>
      {isAccount ? (
        <Paragraph type="secondary">
          When the campaign closes, EuroID removes the account itself, as offboarding does (GitHub:
          removed from the organization; ServiceNow: deactivated). A target that keeps no account
          (File outbound, Google Sheets, Discord webhook) has nothing to remove: its access record
          is closed.
        </Paragraph>
      ) : (
        <Paragraph type="secondary">
          When the campaign closes, EuroID removes group memberships in Entra ID, Active Directory,
          Okta and SCIM. Other access (directory roles, app-imported groups, EuroID roles) is marked
          as needing manual action, with what to do.
        </Paragraph>
      )}
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="justification"
          label="Justification"
          rules={[{ required: true, whitespace: true, message: 'A justification is required' }]}
        >
          <Input.TextArea
            rows={3}
            maxLength={500}
            placeholder="Why this access is no longer needed"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};
