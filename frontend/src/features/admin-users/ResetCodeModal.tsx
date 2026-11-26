/**
 * The one-time password reset code a super-admin issued for an admin, in a centered modal: shown
 * once with a copy button, its expiry and how the admin uses it. The API keeps only its hash; the
 * code lives in the page's state only and is dropped when the modal closes.
 */
import React from 'react';
import { Modal, Typography } from 'antd';
import dayjs from 'dayjs';
import type { IAdminUser, IPasswordResetCode } from '../../interfaces';

const { Paragraph, Text } = Typography;

const MODAL_WIDTH = 560;

export const ResetCodeModal: React.FC<{
  /** The admin and the code the API answered; null while closed. */
  issued: { admin: IAdminUser; code: IPasswordResetCode } | null;
  onClose: () => void;
}> = ({ issued, onClose }) => (
  <Modal
    open={!!issued}
    title="Password reset code"
    width={MODAL_WIDTH}
    okText="Done"
    onOk={onClose}
    onCancel={onClose}
    cancelButtonProps={{ style: { display: 'none' } }}
    maskClosable={false}
    destroyOnHidden
    styles={{ body: { maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' } }}
  >
    {issued && (
      <>
        <Paragraph>
          Give this code to <Text strong>{issued.admin.name}</Text> ({issued.admin.email}) in a way
          only they can read. EuroID shows it only now and keeps only a hash of it: copy it before
          you close this window.
        </Paragraph>
        <Paragraph
          copyable={{ text: issued.code.token, tooltips: ['Copy the code', 'Copied'] }}
          style={{ wordBreak: 'break-all' }}
        >
          <Text code aria-label="Reset code">
            {issued.code.token}
          </Text>
        </Paragraph>
        <Paragraph>
          Valid once, until {dayjs(issued.code.expiresAt).format('YYYY-MM-DD HH:mm')}. On the
          sign-in page they choose Forgot password? and then I have a reset code, enter the code and
          a new password. Their sessions end then; their MFA stays as it is. A newer code or reset
          link replaces this one.
        </Paragraph>
      </>
    )}
  </Modal>
);
