/**
 * The override of an HR-mastered department or job title on the Profile tab (identity controls,
 * PATCH /identity/v2/:id/controls; operator, as the route): set one with a value, a required
 * reason and an optional expiry, or remove the active one with an optional reason, each in a
 * centered modal. Reconcile and the policy contracts take the override until it is removed or
 * expires (the hourly expiry run); a change of the profile's value starts the mover. The API
 * audits each action with the operator and the reason.
 */
import React, { useState } from 'react';
import { App, Button, DatePicker, Input, Modal, Space, Typography } from 'antd';
import { EditOutlined, UndoOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useUpdateIdentityControls } from '@api/identity-api';
import { apiErrorMessage } from '../../dead-letter/dead-letter-labels';
import type { IAttributeControl, IAttributeControlUpdate } from '../../../interfaces';

const { Paragraph, Text } = Typography;

export type OverridableAttribute = 'departmentName' | 'jobTitle';

const LABEL: Record<OverridableAttribute, string> = {
  departmentName: 'department',
  jobTitle: 'job title',
};

type Mode = 'set' | 'remove';

/** The control field of the attribute with `value` (`''` removes the override). */
const controlBody = (attribute: OverridableAttribute, value: string): IAttributeControlUpdate =>
  attribute === 'departmentName' ? { manualDepartment: value } : { manualJobTitle: value };

interface OverrideProps {
  identityId: string;
  attribute: OverridableAttribute;
  /** The HR source that masters the attribute, if one does. */
  owner?: string;
  /** The active override, if any. */
  control?: IAttributeControl;
}

const OverrideModal: React.FC<OverrideProps & { mode: Mode | null; onClose: () => void }> = ({
  identityId,
  attribute,
  owner,
  control,
  mode,
  onClose,
}) => {
  const { message } = App.useApp();
  const update = useUpdateIdentityControls(identityId);
  const setting = mode === 'set';
  // Mounted anew for each opening (its key): a change starts from the current override
  const [value, setValue] = useState(setting && control ? control.value : '');
  const [reason, setReason] = useState('');
  const [expiry, setExpiry] = useState<dayjs.Dayjs | null>(null);
  const label = LABEL[attribute];
  const hr = owner ?? 'HR';
  const ready = !setting || (!!value.trim() && !!reason.trim());

  const confirm = async () => {
    if (!mode || !ready) return;
    const note = reason.trim();
    const body: IAttributeControlUpdate = setting
      ? {
          ...controlBody(attribute, value.trim()),
          reason: note,
          ...(expiry ? { expiresAt: expiry.toISOString() } : {}),
        }
      : { ...controlBody(attribute, ''), ...(note ? { reason: note } : {}) };
    try {
      await update.mutateAsync(body);
      message.success(
        setting
          ? `Override set: the ${label} is ${value.trim()} until it is removed` +
              (expiry ? ' or expires' : '')
          : `Override removed: the ${label} follows ${hr} again`,
      );
      onClose();
    } catch (err) {
      message.error(`Not saved: ${apiErrorMessage(err, 'the request failed')}`);
    }
  };

  return (
    <Modal
      open={!!mode}
      centered
      title={setting ? `Override the ${label}` : `Remove the ${label} override`}
      okText={setting ? 'Set override' : 'Remove override'}
      okButtonProps={{ disabled: !ready, danger: !setting }}
      confirmLoading={update.isPending}
      onOk={confirm}
      onCancel={onClose}
      destroyOnHidden
      styles={{ body: { maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' } }}
    >
      {setting ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Paragraph style={{ margin: 0 }}>
            {owner ? `${owner} masters the ${label}. ` : ''}The override replaces it in the profile
            and in the HR contract the policies evaluate until you remove it or it expires, whatever
            HR sends meanwhile. If the {label} changes, access follows. Your name and the reason are
            recorded in the audit log.
          </Paragraph>
          {control && (
            <Text type="secondary">
              Current override: {control.value}
              {control.reason ? ` (reason: ${control.reason})` : ''}
            </Text>
          )}
          <Input
            value={value}
            maxLength={200}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`New ${label}`}
            aria-label={`New ${label}`}
          />
          <Input.TextArea
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why the HR value does not apply (required)"
            aria-label="Reason"
          />
          {/* With a time, onChange fires only on [OK], while a date picked without it already
              shows in the field: the panel's own changes set the value too, so what the field
              shows is what is sent */}
          <DatePicker
            showTime={{ format: 'HH:mm' }}
            format="YYYY-MM-DD HH:mm"
            value={expiry}
            onChange={(next) => setExpiry(next)}
            onCalendarChange={(next) => setExpiry(Array.isArray(next) ? null : next)}
            disabledDate={(day) => day.isBefore(dayjs(), 'day')}
            placeholder="Expires (optional)"
            aria-label="Expires (optional)"
            style={{ width: '100%' }}
          />
        </Space>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Paragraph style={{ margin: 0 }}>
            The {label} returns to the value {hr} sends, in the profile and in the HR contract, and
            access follows. The removal is recorded in the audit log.
          </Paragraph>
          <Input.TextArea
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            aria-label="Reason (optional)"
          />
        </Space>
      )}
    </Modal>
  );
};

/** [Override] / [Change override] and, while one is active, [Remove override]. */
export const AttributeOverrideActions: React.FC<OverrideProps> = (props) => {
  const [mode, setMode] = useState<Mode | null>(null);
  const label = LABEL[props.attribute];
  return (
    <>
      <Space wrap size={4} style={{ display: 'flex', marginTop: 4 }}>
        <Button
          size="small"
          icon={<EditOutlined />}
          aria-label={props.control ? `Change the ${label} override` : `Override the ${label}`}
          onClick={() => setMode('set')}
        >
          {props.control ? 'Change override' : 'Override'}
        </Button>
        {props.control && (
          <Button
            size="small"
            icon={<UndoOutlined />}
            aria-label={`Remove the ${label} override`}
            onClick={() => setMode('remove')}
          >
            Remove override
          </Button>
        )}
      </Space>
      <OverrideModal key={mode ?? 'closed'} {...props} mode={mode} onClose={() => setMode(null)} />
    </>
  );
};
