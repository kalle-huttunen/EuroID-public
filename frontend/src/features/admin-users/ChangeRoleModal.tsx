/**
 * Choose another tenant role for an admin in a centered modal: the five roles with what each may
 * do, the current one preselected. Choosing hands the role to the page, which asks for a
 * confirmation before it calls the API.
 */
import React, { useState } from 'react';
import { Modal, Radio, Space, Typography } from 'antd';
import type { AdminRole, IAdminUser } from '../../interfaces';
import { ROLE_LABEL, ROLE_OPTIONS } from './admin-user-labels';

const { Paragraph, Text } = Typography;

const MODAL_WIDTH = 560;

export const ChangeRoleModal: React.FC<{
  /** The admin whose role changes; null while closed. */
  admin: IAdminUser | null;
  onChoose: (admin: IAdminUser, role: AdminRole) => void;
  onClose: () => void;
}> = ({ admin, onChoose, onClose }) => {
  // The choice belongs to the admin it was made for: opening the modal for another admin starts
  // from that admin's current role.
  const [choice, setChoice] = useState<{ id: string; role: AdminRole } | null>(null);
  const role = choice && admin && choice.id === admin.id ? choice.role : admin?.role;
  const unchanged = !admin || role === admin.role;

  return (
    <Modal
      open={!!admin}
      title={admin ? `Change the role of ${admin.name}` : ''}
      width={MODAL_WIDTH}
      okText="Continue"
      okButtonProps={{ disabled: unchanged }}
      onOk={() => admin && role && onChoose(admin, role)}
      onCancel={() => {
        setChoice(null);
        onClose();
      }}
      destroyOnHidden
      styles={{ body: { maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' } }}
    >
      {admin && (
        <>
          <Paragraph>
            {admin.name} ({admin.email}) is{' '}
            <Text strong>{ROLE_LABEL[admin.role] ?? admin.role}</Text>. Every role acts in this
            tenant only, and none makes the person a platform admin.
          </Paragraph>
          <Radio.Group
            value={role}
            onChange={(e) => setChoice({ id: admin.id, role: e.target.value as AdminRole })}
            aria-label="New role"
          >
            <Space direction="vertical" size={8}>
              {ROLE_OPTIONS.map((option) => (
                <Radio key={option.value} value={option.value}>
                  <Text strong>{option.label}</Text>
                  {option.value === admin.role && <Text type="secondary"> (current)</Text>}
                  <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                    {option.description}
                  </Text>
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </>
      )}
    </Modal>
  );
};
