/**
 * ConnectorMarketplace.tsx
 *
 * Browse and install connectors from GET /api/v1/connectors/available.
 * Installed connectors become available in the Design Studio "Add Connector" dropdown.
 * Configuration is done in Design Studio when adding a connector node to the blueprint.
 *
 * Design reference: Vercel Integrations -- clean grid of cards.
 */
import React, { useState, useMemo, useEffect } from 'react';
import {
  Row,
  Col,
  Card,
  Input,
  Tag,
  Button,
  Space,
  Typography,
  Skeleton,
  Popconfirm,
  Empty,
  theme,
  App,
} from 'antd';
import { usePermission } from '../../auth';
import { SearchOutlined, CheckCircleFilled } from '@ant-design/icons';
import { useConnectorStore } from '@stores/connector-store';
import type { AvailableConnector } from './connector-api.types';
import { getConnectorIcon } from './connector-icons';
import { useAvailableConnectors } from '@api/connectors-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { ErrorState } from '@shared/ErrorState';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text, Paragraph } = Typography;

// ── ConnectorCard ────────────────────────────────────────────────────────

interface CardProps {
  connector: AvailableConnector;
  installed: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}

const ConnectorCard: React.FC<CardProps & { canManage: boolean }> = ({
  connector,
  installed,
  onInstall,
  onUninstall,
  canManage,
}) => {
  const { token } = theme.useToken();

  return (
    <Card
      style={{
        height: '100%',
        borderColor: installed ? token.colorSuccessBorder : undefined,
      }}
      styles={{
        body: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          padding: 20,
        },
      }}
    >
      {/* Header: icon + name + tags */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <div
          style={{
            fontSize: 22,
            color: token.colorPrimary,
            lineHeight: 1,
            flexShrink: 0,
            width: 40,
            height: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: token.colorPrimaryBg,
            borderRadius: 8,
          }}
        >
          {getConnectorIcon(connector.icon)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 15, display: 'block' }}>
            {connector.name}
          </Text>
          <Space size={4} wrap style={{ marginTop: 6 }}>
            {connector.capabilities.map((cap) => (
              <Tag key={cap} bordered={false} style={{ margin: 0 }}>
                {cap}
              </Tag>
            ))}
          </Space>
        </div>
        {installed && (
          <Tag icon={<CheckCircleFilled />} color="success" style={{ margin: 0, flexShrink: 0 }}>
            Installed
          </Tag>
        )}
      </div>

      {/* Description */}
      <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ flex: 1, marginBottom: 16 }}>
        {connector.description}
      </Paragraph>

      {/* Actions — Install/Uninstall only. Configuration is done in Design Studio. */}
      <div style={{ marginTop: 'auto' }}>
        {canManage ? (
          installed ? (
            <Popconfirm
              title="Uninstall this connector?"
              description="It will be removed from Design studio."
              onConfirm={onUninstall}
              okText="Uninstall"
              okButtonProps={{ danger: true }}
            >
              <Button block>Uninstall</Button>
            </Popconfirm>
          ) : (
            <Button
              block
              onClick={onInstall}
              style={{ color: token.colorPrimary, borderColor: token.colorPrimary }}
            >
              Install
            </Button>
          )
        ) : installed ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Configure in Design studio
          </Text>
        ) : null}
      </div>
    </Card>
  );
};

// ── Skeleton card (loading state) ────────────────────────────────────────

const SkeletonCard: React.FC = () => (
  <Card style={{ height: '100%' }}>
    <Skeleton avatar={{ shape: 'square', size: 40 }} active paragraph={{ rows: 3 }} />
  </Card>
);

// ── Main Page ────────────────────────────────────────────────────────────

export const ConnectorMarketplace: React.FC = () => {
  const canManageConnectors = usePermission('connector-admin');
  const [search, setSearch] = useState('');

  const { data: connectors = [], isLoading, isError, error, refetch } = useAvailableConnectors();

  const { message } = App.useApp();
  const { installed, isInstalled, install, uninstall, syncFromBackend, syncError } =
    useConnectorStore();

  useEffect(() => {
    syncFromBackend();
  }, [syncFromBackend]);

  // The store changes only once the backend accepted the change; a refusal shows its reason
  const handleInstall = (connector: AvailableConnector) =>
    install(connector.id, {}).catch((err: unknown) => {
      message.error(apiErrorMessage(err, `Could not install ${connector.name}`));
    });

  const handleUninstall = (connector: AvailableConnector) =>
    uninstall(connector.id).catch((err: unknown) => {
      message.error(apiErrorMessage(err, `Could not uninstall ${connector.name}`));
    });

  const filtered = useMemo(() => {
    return connectors.filter((c) => {
      const matchesSearch =
        !search ||
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.description.toLowerCase().includes(search.toLowerCase());
      return matchesSearch;
    });
  }, [connectors, search]);

  const installedCount = installed.length;
  const totalCount = connectors.length;

  return (
    <PageContainer>
      <PageHeader
        title="Connectors"
        subtitle={
          isLoading || isError || syncError
            ? 'Source and target systems EuroID can connect to'
            : `${installedCount} of ${totalCount} installed. Installed connectors appear in Design studio.`
        }
        actions={
          <Input
            placeholder="Search connectors"
            prefix={<SearchOutlined />}
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 260 }}
            aria-label="Search connectors"
          />
        }
      />

      {/* ── Grid ─────────────────────────────────────────────────── */}
      {isError ? (
        <ErrorState title="Could not load connectors" error={error} onRetry={() => refetch()} />
      ) : syncError ? (
        // Never the persisted names with empty configs: which are installed is unknown
        <ErrorState
          title="Could not load the installed connectors"
          error={syncError}
          onRetry={() => syncFromBackend()}
        />
      ) : isLoading ? (
        <Row gutter={[16, 16]}>
          {[1, 2, 3].map((i) => (
            <Col xs={24} md={12} lg={8} key={i}>
              <SkeletonCard />
            </Col>
          ))}
        </Row>
      ) : filtered.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<span>No connectors match &quot;{search}&quot;</span>}
        />
      ) : (
        <Row gutter={[16, 16]}>
          {filtered.map((connector) => (
            <Col xs={24} md={12} lg={8} key={connector.id}>
              <ConnectorCard
                connector={connector}
                installed={isInstalled(connector.id)}
                canManage={canManageConnectors}
                onInstall={() => handleInstall(connector)}
                onUninstall={() => handleUninstall(connector)}
              />
            </Col>
          ))}
        </Row>
      )}
    </PageContainer>
  );
};
