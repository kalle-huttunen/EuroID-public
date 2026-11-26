/**
 * A checkpoint's signed anchor in a centered modal (GET /audit/merkle-roots/:checkpointId/anchor,
 * super-admin; the checkpoint's UUID): the server's own check of the Ed25519 signature, the signed
 * payload, the key fingerprint and the external witness delivery, plus the whole envelope to copy
 * for a check outside EuroID. The body scrolls under a fixed title and footer.
 */
import React from 'react';
import { Alert, Button, Descriptions, Modal, Skeleton, Space, Typography, theme } from 'antd';
import { useAnchorProof } from '@api/audit-integrity-api';
import type { IMerkleCheckpoint } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { formatTime } from './audit-integrity-labels';

const { Paragraph, Text } = Typography;

/** Fits a 64-character hash on one line; on narrow screens Ant Design caps it at the viewport. */
const MODAL_WIDTH = 720;

const Witness: React.FC<{ delivery: IMerkleCheckpoint['externalAnchor'] }> = ({ delivery }) =>
  delivery ? (
    <>
      HTTP {delivery.responseStatus ?? 'status unknown'} from <Text code>{delivery.endpoint}</Text>{' '}
      on {formatTime(delivery.deliveredAt)}
      {delivery.witness && (
        <>
          , witness id <Text code>{delivery.witness}</Text>
        </>
      )}
    </>
  ) : (
    <Text type="secondary">Not delivered (no witness endpoint was configured, or it failed)</Text>
  );

export const AnchorProofModal: React.FC<{
  checkpoint: IMerkleCheckpoint | null;
  onClose: () => void;
}> = ({ checkpoint, onClose }) => {
  const { token } = theme.useToken();
  const anchor = useAnchorProof(checkpoint?.checkpointId);

  let body: React.ReactNode;
  if (anchor.isLoading) {
    body = <Skeleton active paragraph={{ rows: 6 }} />;
  } else if (anchor.isError) {
    body = (
      <Alert
        type="error"
        showIcon
        message={`Could not load the anchor: ${apiErrorMessage(anchor.error, 'the request failed')}`}
      />
    );
  } else if (anchor.data) {
    const { envelope, verified } = anchor.data;
    body = (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {verified ? (
          <Alert
            type="success"
            showIcon
            message="The signature verifies"
            description="The EuroID server checked the Ed25519 signature over the payload below with its configured public key."
          />
        ) : (
          <Alert
            type="error"
            showIcon
            message="The signature does not verify"
            description="Checked with the server's configured public key: the payload changed after it was signed, or the server now holds another key or none (compare the key fingerprint)."
          />
        )}
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="Algorithm">Ed25519</Descriptions.Item>
          <Descriptions.Item label="Key fingerprint">
            <Text code copyable style={{ wordBreak: 'break-all' }}>
              {envelope.keyFingerprint}
            </Text>
          </Descriptions.Item>
          <Descriptions.Item label="Signed">{formatTime(envelope.signedAt)}</Descriptions.Item>
          <Descriptions.Item label="External witness">
            <Witness delivery={checkpoint?.externalAnchor} />
          </Descriptions.Item>
        </Descriptions>
        <div>
          <Text strong>Signed payload</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
            Signed as compact JSON with the keys in this order.
          </Text>
          <pre
            aria-label="Signed payload"
            style={{
              margin: 0,
              fontSize: 12,
              background: token.colorFillQuaternary,
              padding: 12,
              borderRadius: token.borderRadius,
              overflowX: 'auto',
            }}
          >
            {JSON.stringify(envelope.payload, null, 2)}
          </pre>
        </div>
        <div>
          <Text strong>Signature</Text>
          <Paragraph
            code
            copyable
            style={{ margin: '4px 0 0', wordBreak: 'break-all', fontSize: 12 }}
          >
            {envelope.signature}
          </Paragraph>
        </div>
        <Paragraph type="secondary" style={{ margin: 0 }}>
          To prove it outside EuroID, verify the signature over the payload with the public key
          whose fingerprint is above.{' '}
          <Text copyable={{ text: JSON.stringify(envelope) }}>Copy the whole envelope</Text>
        </Paragraph>
      </Space>
    );
  }

  return (
    <Modal
      open={!!checkpoint}
      onCancel={onClose}
      destroyOnHidden
      width={MODAL_WIDTH}
      title={
        <Space size={8} wrap>
          Anchor proof
          <Text code style={{ wordBreak: 'break-all' }}>
            {checkpoint?.checkpointId}
          </Text>
        </Space>
      }
      footer={<Button onClick={onClose}>Close</Button>}
      styles={{ body: { maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' } }}
    >
      {body}
    </Modal>
  );
};
