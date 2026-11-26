/**
 * Issue a short-lived credential for an agent (POST /nhi/:agentId/credentials, super-admin). The
 * credential is a bearer secret while it is valid, so it is shown once: it lives only in this
 * component's state (no query or mutation cache, no storage, no URL) and closing the modal
 * discards it. The API keeps only a fingerprint of the signature and cannot show it again.
 */
import React, { useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  InputNumber,
  Modal,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd';
import { KeyOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { issueAgentCredential, nhiKeys } from '@api/nhi-api';
import type { IAgentCredential, IAgentIdentity } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import {
  DEFAULT_CREDENTIAL_TTL_MINUTES,
  MAX_CREDENTIAL_TTL_MINUTES,
  VERIFY_NOTE,
  formatDateTime,
} from './nhi-labels';

const { Paragraph, Text } = Typography;

const MODAL_WIDTH = 640;
const formatSeconds = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm:ss');

const Issued: React.FC<{ credential: IAgentCredential; ttlSeconds: number }> = ({
  credential,
  ttlSeconds,
}) => {
  const { token } = theme.useToken();
  const { payload } = credential;
  const json = JSON.stringify(credential, null, 2);
  // From the API's own timestamps: the credential never outlives the agent.
  const shortened = dayjs(payload.expiresAt).diff(dayjs(payload.issuedAt), 'second') < ttlSeconds;
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="warning"
        showIcon
        message="Copy the credential now: it is shown only once."
        description="Anyone who holds it can act as the agent, with its scope, until it expires. EuroID keeps only a fingerprint of its signature and cannot show it again. Closing this window discards it."
      />
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="Expires">
          {formatSeconds(payload.expiresAt)}
          {shortened && (
            <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              Shortened to the agent&apos;s own expiry.
            </Text>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="SPIFFE id">
          <Text code style={{ wordBreak: 'break-all' }}>
            {payload.spiffeId}
          </Text>
        </Descriptions.Item>
        <Descriptions.Item label="Scope">
          <Space size={[4, 4]} wrap>
            {payload.scope.map((s) => (
              <Tag key={s}>{s}</Tag>
            ))}
          </Space>
        </Descriptions.Item>
      </Descriptions>
      <pre
        aria-label="Issued credential"
        style={{
          margin: 0,
          fontSize: 12,
          background: token.colorFillQuaternary,
          padding: 12,
          borderRadius: token.borderRadius,
          overflowX: 'auto',
          maxHeight: 240,
        }}
      >
        {json}
      </pre>
      <Text copyable={{ text: json, tooltips: ['Copy the credential', 'Copied'] }}>
        Copy the credential as JSON
      </Text>
    </Space>
  );
};

export const IssueCredentialModal: React.FC<{ agent: IAgentIdentity; onClose: () => void }> = ({
  agent,
  onClose,
}) => {
  const qc = useQueryClient();
  const [minutes, setMinutes] = useState<number | null>(DEFAULT_CREDENTIAL_TTL_MINUTES);
  const [issued, setIssued] = useState<{ credential: IAgentCredential; ttlSeconds: number }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issue = async () => {
    const ttlSeconds = (minutes ?? DEFAULT_CREDENTIAL_TTL_MINUTES) * 60;
    setPending(true);
    setError(null);
    try {
      setIssued({ credential: await issueAgentCredential(agent.agentId, ttlSeconds), ttlSeconds });
    } catch (err) {
      setError(`Could not issue a credential: ${apiErrorMessage(err, 'the request failed')}`);
    } finally {
      setPending(false);
      // The agent's last-issued time changed (or a refusal marked it expired): reload it.
      void qc.invalidateQueries({ queryKey: nhiKeys.all });
    }
  };

  const close = () => {
    if (pending) return;
    setIssued(undefined);
    onClose();
  };

  const footer = issued ? (
    <Button type="primary" onClick={close}>
      Done
    </Button>
  ) : (
    <Space wrap style={{ justifyContent: 'flex-end' }}>
      <Button onClick={close} disabled={pending}>
        Cancel
      </Button>
      <Button
        type="primary"
        icon={<KeyOutlined />}
        disabled={!minutes}
        loading={pending}
        onClick={issue}
      >
        Issue credential
      </Button>
    </Space>
  );

  return (
    <Modal
      open
      centered
      width={MODAL_WIDTH}
      title={
        issued ? `Credential for "${agent.agentId}"` : `Issue a credential for "${agent.agentId}"?`
      }
      footer={footer}
      onCancel={close}
      maskClosable={false}
      closable={!pending}
      keyboard={!pending}
      destroyOnHidden
      styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {issued ? (
          <Issued credential={issued.credential} ttlSeconds={issued.ttlSeconds} />
        ) : (
          <>
            <Paragraph style={{ margin: 0 }}>
              Issues an Ed25519-signed credential for <Text code>{agent.agentId}</Text> that carries
              its scope. It expires after the time you choose, at most {MAX_CREDENTIAL_TTL_MINUTES}{' '}
              minutes, and never after the agent&apos;s own expiry (
              {formatDateTime(agent.expiresAt)}).
            </Paragraph>
            <Space wrap>
              <label htmlFor="nhi-credential-ttl">Valid for (minutes)</label>
              <InputNumber
                id="nhi-credential-ttl"
                min={1}
                max={MAX_CREDENTIAL_TTL_MINUTES}
                precision={0}
                value={minutes}
                onChange={setMinutes}
                disabled={pending}
              />
            </Space>
            {error && <Alert type="error" showIcon message={error} />}
          </>
        )}
        <Text type="secondary">{VERIFY_NOTE}</Text>
      </Space>
    </Modal>
  );
};
