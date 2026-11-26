/**
 * DriftActionPanel — F-03: Drift correction actions from the entitlement map, in a centered
 * modal.
 *
 * Shows drift details for a target system and provides Correct/Absorb actions per drift
 * with confirmation modals (Safety Rule #6: simulate before commit).
 */

import React from 'react';
import { App, Button, Descriptions, Grid, List, Modal, Space, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  SwapOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { correctDrift, ignoreDrift, reconciliationKeys } from '@api/reconciliation-api';
import { identityMapKeys } from '@api/identity-map-api';
import { apiErrorMessage } from '../../dead-letter/dead-letter-labels';
import { SEMANTIC } from '@theme/themeConfig';
import type { IDrift } from '../../../interfaces';

const { Text } = Typography;

interface DriftActionPanelProps {
  targetSystem: string | null;
  drifts: IDrift[];
  identityId: string;
  open: boolean;
  onClose: () => void;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: SEMANTIC.statusError,
  high: SEMANTIC.statusError,
  medium: SEMANTIC.statusDriftText,
  low: SEMANTIC.statusSynced,
};

export const DriftActionPanel: React.FC<DriftActionPanelProps> = ({
  targetSystem,
  drifts,
  identityId,
  open,
  onClose,
}) => {
  const queryClient = useQueryClient();
  const screens = Grid.useBreakpoint();
  // The App hooks render inside the app's providers; antd's static Modal.confirm and message
  // render in a root of their own, with only the theme handed to them (contexts/color-mode).
  const { message, modal } = App.useApp();

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: reconciliationKeys.driftsPrefix() });
    queryClient.invalidateQueries({ queryKey: identityMapKeys.byId(identityId) });
    queryClient.invalidateQueries({ queryKey: identityMapKeys.all() });
  };

  const correctMutation = useMutation({
    mutationFn: correctDrift,
    onSuccess: () => {
      message.success('Drift corrected — pushing desired state to target.');
      invalidateAll();
    },
    onError: (err) => {
      message.error(apiErrorMessage(err, 'Failed to correct drift.'));
    },
  });

  const absorbMutation = useMutation({
    mutationFn: ignoreDrift,
    onSuccess: () => {
      message.success('Drift absorbed — accepting actual state as desired.');
      invalidateAll();
    },
    onError: (err) => {
      message.error(apiErrorMessage(err, 'Failed to absorb drift.'));
    },
  });

  const handleCorrect = (drift: IDrift) => {
    modal.confirm({
      title: 'Correct Drift?',
      icon: <ExclamationCircleOutlined />,
      content: (
        <Space direction="vertical" size={4}>
          <Text>
            This will push the <strong>desired state</strong> (Hub value) to the target system.
          </Text>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Field">{drift.field ?? drift.type}</Descriptions.Item>
            <Descriptions.Item label="Hub Value">{drift.hubValue ?? 'N/A'}</Descriptions.Item>
            <Descriptions.Item label="Target Value">{drift.targetValue ?? 'N/A'}</Descriptions.Item>
          </Descriptions>
        </Space>
      ),
      okText: 'Correct',
      okType: 'primary',
      onOk: () => correctMutation.mutate(drift.id),
    });
  };

  const handleAbsorb = (drift: IDrift) => {
    modal.confirm({
      title: 'Absorb Drift?',
      icon: <ExclamationCircleOutlined />,
      content: (
        <Space direction="vertical" size={4}>
          <Text>
            This will <strong>accept the actual state</strong> from the target system as the new
            desired state.
          </Text>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Field">{drift.field ?? drift.type}</Descriptions.Item>
            <Descriptions.Item label="Current Hub">{drift.hubValue ?? 'N/A'}</Descriptions.Item>
            <Descriptions.Item label="Will become">{drift.targetValue ?? 'N/A'}</Descriptions.Item>
          </Descriptions>
        </Space>
      ),
      okText: 'Absorb',
      okType: 'default',
      onOk: () => absorbMutation.mutate(drift.id),
    });
  };

  return (
    <Modal
      title={
        <Space>
          <SyncOutlined />
          <span>Drift Details: {targetSystem}</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      styles={{ body: { maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' } }}
    >
      {drifts.length === 0 ? (
        <Text type="secondary">No active drifts for this system.</Text>
      ) : (
        <List
          // On a phone the actions go below the drift, which keeps the width of the modal.
          itemLayout={screens.sm ? 'horizontal' : 'vertical'}
          dataSource={drifts}
          renderItem={(drift) => (
            <List.Item
              actions={[
                <Button
                  key="correct"
                  type="primary"
                  size="small"
                  icon={<CheckCircleOutlined />}
                  loading={correctMutation.isPending}
                  onClick={() => handleCorrect(drift)}
                >
                  Correct
                </Button>,
                <Button
                  key="absorb"
                  size="small"
                  icon={<SwapOutlined />}
                  loading={absorbMutation.isPending}
                  onClick={() => handleAbsorb(drift)}
                >
                  Absorb
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space wrap>
                    <Text strong>{drift.field ?? drift.type}</Text>
                    <Tag color={SEVERITY_COLORS[drift.severity] ?? SEMANTIC.statusInactive}>
                      {drift.severity}
                    </Tag>
                    <Tag>{drift.type}</Tag>
                  </Space>
                }
                description={
                  <Space direction="vertical" size={2}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Hub: {drift.hubValue ?? 'N/A'} → Target: {drift.targetValue ?? 'N/A'}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      Detected: {new Date(drift.detectedAt).toLocaleString()}
                    </Text>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      )}
    </Modal>
  );
};
