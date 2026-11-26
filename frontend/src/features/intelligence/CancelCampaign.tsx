/**
 * Cancelling an access review campaign (`POST /access-reviews/campaigns/:id/cancel`, super-admin):
 * the row action and its confirmation. What the dialog says follows the backend
 * (AccessReviewCampaignService.cancel and the campaign workflow's activities): the campaign stops
 * for good and its workflow with it; the items keep their decisions; open items are closed to
 * reviewers (no longer in My Reviews, a decision is a 409) and no longer escalated, expired or
 * auto-revoked; and access already decided as revoked is not removed, because removal runs only
 * when a campaign closes. A recurring campaign's recurrence ends with it: the recertification
 * scheduler creates no next campaign. The reason is required here; the backend records it with
 * the admin in the audit log (`access_review.campaign_cancelled`).
 */
import React from 'react';
import { Alert, App, Button, Form, Input, Modal, Typography } from 'antd';
import { StopOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  cancelCampaign,
  intelligenceKeys,
  type CampaignStatus,
  type ReviewCampaign,
} from '@api/intelligence-api';
import { usePermission } from '../../auth/usePermission';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Paragraph, Text } = Typography;

/** The statuses the backend cancels; a COMPLETED or CANCELLED campaign is refused (400). */
const CANCELLABLE: readonly CampaignStatus[] = ['DRAFT', 'ACTIVE'];

/** [Cancel campaign] in a campaign row: super-admin (the route's guard), DRAFT or ACTIVE only. */
export const CancelCampaignButton: React.FC<{
  campaign: ReviewCampaign;
  onClick: (campaign: ReviewCampaign) => void;
}> = ({ campaign, onClick }) => {
  const isSuperAdmin = usePermission('super-admin');
  if (!isSuperAdmin || !CANCELLABLE.includes(campaign.status)) return null;
  return (
    <Button
      type="link"
      size="small"
      danger
      icon={<StopOutlined />}
      onClick={() => onClick(campaign)}
    >
      Cancel campaign
    </Button>
  );
};

/** "escalated, expired at the deadline or auto-revoked": what the workflow no longer does. */
function stoppedSteps(campaign: ReviewCampaign): string {
  const steps = [
    ...(campaign.escalation?.enabled ? ['escalated'] : []),
    'expired at the deadline',
    ...(campaign.autoRevokeOnExpiry ? ['auto-revoked'] : []),
  ];
  const last = steps.pop()!;
  return steps.length ? `${steps.join(', ')} or ${last}` : last;
}

/** What happens to an active campaign's items. */
const ActiveConsequences: React.FC<{ campaign: ReviewCampaign }> = ({ campaign }) => (
  <ul style={{ paddingInlineStart: 20, marginBlock: 0 }}>
    <li>
      Open items ({campaign.stats?.pending ?? 0}) are closed to reviewers: they leave My Reviews and
      can no longer be decided. They are no longer {stoppedSteps(campaign)}; the campaign keeps
      showing them as pending.
    </li>
    <li>
      Access already decided as revoked ({campaign.stats?.revoked ?? 0}) is not removed: EuroID
      removes revoked access only when a campaign closes, and a cancelled campaign never closes.
      Remove it in a new campaign or in the target system. Anything removed while the campaign was
      closing stays removed.
    </li>
  </ul>
);

/** Confirmation with a required reason; on success the campaign lists reload. */
export const CancelCampaignModal: React.FC<{
  campaign: ReviewCampaign | null;
  onClose: () => void;
}> = ({ campaign, onClose }) => {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<{ reason: string }>();
  const cancel = useMutation({
    mutationFn: (vars: { campaignId: string; reason: string }) =>
      cancelCampaign(vars.campaignId, vars.reason),
    onSuccess: (updated) => {
      message.success(`Campaign cancelled: ${updated.name}`);
      onClose();
    },
    // Also after a refusal: a campaign that completed meanwhile shows its current status.
    // Prefix keys: the list query's key ends in its (undefined) params.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: intelligenceKeys.campaignsPrefix() });
      void queryClient.invalidateQueries({ queryKey: intelligenceKeys.campaignPrefix() });
    },
  });

  return (
    <Modal
      title="Cancel campaign"
      open={!!campaign}
      okText="Cancel campaign"
      cancelText="Keep campaign"
      okButtonProps={{ danger: true }}
      confirmLoading={cancel.isPending}
      destroyOnHidden
      onCancel={() => {
        cancel.reset();
        onClose();
      }}
      // A failed validation is shown on the field, so its rejection needs no further handling.
      onOk={() =>
        form
          .validateFields()
          .then(({ reason }) => {
            if (campaign) cancel.mutate({ campaignId: campaign.campaignId, reason: reason.trim() });
          })
          .catch(() => undefined)
      }
    >
      {campaign && (
        <>
          <Paragraph>
            Cancel <Text strong>{campaign.name}</Text>? It stops now and cannot be activated again.
            {campaign.recurrence?.enabled &&
              ' It also ends the recurrence: no next campaign is created.'}
          </Paragraph>
          <Paragraph type="secondary">
            {campaign.status === 'DRAFT' ? (
              'The draft has no review items yet: they are created at activation.'
            ) : (
              <ActiveConsequences campaign={campaign} />
            )}
          </Paragraph>
          {cancel.isError && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              message={`Not cancelled: ${apiErrorMessage(cancel.error, 'the request failed')}`}
            />
          )}
          <Form form={form} layout="vertical" preserve={false}>
            <Form.Item
              name="reason"
              label="Reason"
              extra="Recorded in the audit log with your name."
              rules={[{ required: true, whitespace: true, message: 'A reason is required' }]}
            >
              <Input.TextArea
                rows={3}
                maxLength={500}
                placeholder="Why this campaign is cancelled"
              />
            </Form.Item>
          </Form>
        </>
      )}
    </Modal>
  );
};
