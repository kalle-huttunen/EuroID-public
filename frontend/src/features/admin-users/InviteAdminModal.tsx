/**
 * Invite an admin in a centered modal: email and role. The API answers the invite code once and
 * keeps only its hash; nothing mails it. So after creating the invite the modal shows the code to
 * copy and how the invitee uses it, until the inviter closes it. The code lives in this
 * component's state only: never logged, stored or sent anywhere else.
 */
import React, { useState } from 'react';
import { Alert, Form, Input, Modal, Radio, Space, Typography } from 'antd';
import dayjs from 'dayjs';
import { useInviteAdmin } from '@api/admin-users-api';
import type { AdminRole, IAdminInvite } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { ROLE_LABEL, ROLE_OPTIONS } from './admin-user-labels';

const { Paragraph, Text } = Typography;

const MODAL_WIDTH = 560;

interface FormValues {
  email: string;
  role: AdminRole;
}

export const InviteAdminModal: React.FC<{
  open: boolean;
  /**
   * Emails that already have an admin account here. Registering one fails (409), so the form
   * refuses to invite it.
   */
  emailsInUse: string[];
  onClose: () => void;
}> = ({ open, emailsInUse, onClose }) => {
  const [form] = Form.useForm<FormValues>();
  const invite = useInviteAdmin();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<
    (IAdminInvite & { email: string; role: AdminRole }) | null
  >(null);

  const close = () => {
    setError(null);
    setCreated(null);
    onClose();
  };

  const submit = async (values: FormValues) => {
    setError(null);
    const email = values.email.trim().toLowerCase();
    try {
      const result = await invite.mutateAsync({ email, roles: [values.role] });
      setCreated({ ...result, email, role: values.role });
    } catch (err) {
      setError(apiErrorMessage(err, 'the request failed'));
    }
  };

  const inUse = new Set(emailsInUse.map((e) => e.toLowerCase()));

  return (
    <Modal
      open={open}
      title={created ? 'Invite created' : 'Invite an admin'}
      width={MODAL_WIDTH}
      okText={created ? 'Done' : 'Create invite'}
      confirmLoading={invite.isPending}
      onOk={() => (created ? close() : form.submit())}
      onCancel={close}
      cancelButtonProps={created ? { style: { display: 'none' } } : undefined}
      maskClosable={!created}
      destroyOnHidden
      styles={{ body: { maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' } }}
    >
      {created ? (
        <>
          <Paragraph>
            Give this code to <Text strong>{created.email}</Text>. EuroID shows it only now, keeps
            only a hash of it and sends no email: copy it before you close this window.
          </Paragraph>
          <Paragraph
            copyable={{ text: created.token, tooltips: ['Copy the code', 'Copied'] }}
            style={{ wordBreak: 'break-all' }}
          >
            <Text code aria-label="Invite code">
              {created.token}
            </Text>
          </Paragraph>
          <Paragraph>
            Valid once, until {dayjs(created.expiresAt).format('YYYY-MM-DD HH:mm')}. On the sign-in
            page the invitee chooses to create an account and enters their name, this email address,
            a password and the code. They join this tenant as{' '}
            <Text strong>{ROLE_LABEL[created.role]}</Text>.
          </Paragraph>
        </>
      ) : (
        <>
          {error && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              message={`Not invited: ${error}`}
            />
          )}
          <Form<FormValues>
            form={form}
            layout="vertical"
            initialValues={{ role: 'viewer' }}
            onFinish={submit}
            requiredMark="optional"
          >
            <Form.Item
              name="email"
              label="Email"
              extra="The invitee must register with this address."
              normalize={(value?: string) => value?.trim()}
              rules={[
                { required: true, whitespace: true, message: 'Enter the email address.' },
                { type: 'email', message: 'Enter a valid email address.' },
                {
                  validator: (_, value?: string) =>
                    value && inUse.has(value.trim().toLowerCase())
                      ? Promise.reject(new Error('This address already has an admin account.'))
                      : Promise.resolve(),
                },
              ]}
            >
              <Input placeholder="name@example.com" autoComplete="off" />
            </Form.Item>
            <Form.Item
              name="role"
              label="Role"
              extra="Every role acts in this tenant only, and none makes the person a platform admin."
              rules={[{ required: true }]}
            >
              <Radio.Group>
                <Space direction="vertical" size={8}>
                  {ROLE_OPTIONS.map((option) => (
                    <Radio key={option.value} value={option.value}>
                      <Text strong>{option.label}</Text>
                      <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                        {option.description}
                      </Text>
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
            </Form.Item>
          </Form>
        </>
      )}
    </Modal>
  );
};
