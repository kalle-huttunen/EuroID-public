/**
 * Load the graph from MongoDB (POST /access-explorer/resync, super-admin): what it writes and
 * removes, confirmed in a centered modal; the counts it answers, or the API's message (503 without
 * a graph store, 409 while another resync runs) inside the modal.
 */
import React from 'react';
import { Alert, Button, Descriptions, Modal, Typography } from 'antd';
import { CloudSyncOutlined } from '@ant-design/icons';
import { useGraphResync } from '@api/access-explorer-api';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { RESYNC_EXPLANATION, RESYNC_TITLE } from './access-explorer-labels';

const { Paragraph } = Typography;

export const ResyncModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const resync = useGraphResync();
  const result = resync.data;
  const footer = result ? (
    <Button type="primary" onClick={onClose}>
      Close
    </Button>
  ) : (
    <>
      <Button onClick={onClose} disabled={resync.isPending}>
        Cancel
      </Button>
      <Button
        type="primary"
        icon={<CloudSyncOutlined />}
        loading={resync.isPending}
        onClick={() => resync.mutate()}
      >
        Load graph
      </Button>
    </>
  );

  return (
    <Modal
      open
      centered
      title={RESYNC_TITLE}
      onCancel={resync.isPending ? undefined : onClose}
      closable={!resync.isPending}
      maskClosable={false}
      footer={footer}
      width={560}
    >
      {result ? (
        <>
          <Alert
            type="success"
            showIcon
            message={`The graph was loaded in ${(result.durationMs / 1000).toFixed(1)} s`}
            style={{ marginBottom: 12 }}
          />
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Identities">{result.identities}</Descriptions.Item>
            <Descriptions.Item label="Entitlements">{result.entitlements}</Descriptions.Item>
            <Descriptions.Item label="Applications">{result.applications}</Descriptions.Item>
            <Descriptions.Item label="Access from policies">
              {result.grants.policy}
            </Descriptions.Item>
            <Descriptions.Item label="Access from requests">
              {result.grants.request}
            </Descriptions.Item>
            <Descriptions.Item label="Removed">
              {result.removed.identities} identities, {result.removed.entitlements} entitlements,{' '}
              {result.removed.applications} applications, {result.removed.relationships} links
            </Descriptions.Item>
          </Descriptions>
        </>
      ) : (
        <>
          {RESYNC_EXPLANATION.map((text) => (
            <Paragraph key={text}>{text}</Paragraph>
          ))}
          {resync.isError && (
            <Alert
              type="error"
              showIcon
              role="alert"
              message="The graph was not loaded"
              description={apiErrorMessage(resync.error, 'The request failed.')}
            />
          )}
        </>
      )}
    </Modal>
  );
};
