/**
 * CanvasToolbar — Design studio header: title, pipeline state, and the
 * Add connector / Save / Simulate / Deploy-Pause-Stop actions.
 * A deployed pipeline shows the single EU-gold LIVE mark next to its status.
 * Extracted from BlueprintCanvas for separation of concerns.
 */
import React from 'react';
import { Space, Button, Tag, Dropdown, Typography, theme } from 'antd';
import {
  PlusCircleOutlined,
  SaveOutlined,
  ExperimentOutlined,
  RocketOutlined,
  PauseCircleOutlined,
  PlayCircleFilled,
  StopOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { LIVE } from '../../../theme';

const { Title } = Typography;

export interface CanvasToolbarProps {
  /** policy-admin, which save, impact analysis, deploy, pause, resume and stop require. */
  canEdit: boolean;
  isPolicyDirty: boolean;
  pipelineStatus: string;
  isSaving: boolean;
  onSave: () => void;
  onSimulate: () => void;
  onDeploy: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  addConnectorItems: MenuProps['items'];
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  SIMULATED: 'Simulated',
  DEPLOYED: 'Live',
  PAUSED: 'Paused',
  STOPPED: 'Stopped',
};

const PipelineStatus: React.FC<{ status: string }> = ({ status }) => {
  const { token } = theme.useToken();
  const label = STATUS_LABELS[status] ?? status;

  if (status === 'DEPLOYED') {
    return (
      <span
        role="status"
        aria-label="Pipeline status: live, deployed"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 24,
          padding: '0 10px',
          borderRadius: 12,
          border: `1px solid ${token.colorBorder}`,
          background: token.colorBgContainer,
          fontSize: 12,
          fontWeight: 500,
          color: token.colorText,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: LIVE.color,
            boxShadow: `0 0 0 3px ${LIVE.glowSoft}`,
          }}
        />
        {label}
        <span style={{ color: token.colorTextSecondary, fontWeight: 400 }}>Deployed</span>
      </span>
    );
  }

  const color =
    status === 'PAUSED'
      ? 'warning'
      : status === 'STOPPED'
        ? 'error'
        : status === 'SIMULATED'
          ? 'processing'
          : 'default';
  return (
    <Tag color={color} style={{ margin: 0 }} role="status" aria-label={`Pipeline status: ${label}`}>
      {label}
    </Tag>
  );
};

export const CanvasToolbar: React.FC<CanvasToolbarProps> = ({
  canEdit,
  isPolicyDirty,
  pipelineStatus,
  isSaving,
  onSave,
  onSimulate,
  onDeploy,
  onPause,
  onResume,
  onStop,
  addConnectorItems,
}) => {
  const { token } = theme.useToken();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
        padding: '12px 24px',
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Space size={12} align="center" wrap>
        <Title level={4} style={{ margin: 0, fontWeight: 600 }}>
          Design studio
        </Title>
        <PipelineStatus status={pipelineStatus} />
        {isPolicyDirty && (
          <Tag color="warning" style={{ margin: 0 }}>
            Unsaved changes
          </Tag>
        )}
      </Space>

      {/* A role below policy-admin reads the canvas: every action here needs policy-admin */}
      {canEdit && (
        <Space wrap>
          <Dropdown menu={{ items: addConnectorItems }}>
            <Button icon={<PlusCircleOutlined />}>Add connector</Button>
          </Dropdown>
          <Button icon={<SaveOutlined />} onClick={onSave} loading={isSaving}>
            Save
          </Button>
          <Button icon={<ExperimentOutlined />} onClick={onSimulate}>
            Run impact simulation
          </Button>
          {pipelineStatus === 'DRAFT' || pipelineStatus === 'SIMULATED' ? (
            <Button type="primary" icon={<RocketOutlined />} onClick={onDeploy}>
              Deploy
            </Button>
          ) : pipelineStatus === 'DEPLOYED' ? (
            <>
              <Button icon={<PauseCircleOutlined />} onClick={onPause}>
                Pause
              </Button>
              <Button danger icon={<StopOutlined />} onClick={onStop}>
                Stop
              </Button>
            </>
          ) : pipelineStatus === 'PAUSED' ? (
            <>
              <Button type="primary" icon={<PlayCircleFilled />} onClick={onResume}>
                Resume
              </Button>
              <Button danger icon={<StopOutlined />} onClick={onStop}>
                Stop
              </Button>
            </>
          ) : pipelineStatus === 'STOPPED' ? (
            <Button type="primary" icon={<RocketOutlined />} onClick={onDeploy}>
              Re-deploy
            </Button>
          ) : null}
        </Space>
      )}
    </div>
  );
};
