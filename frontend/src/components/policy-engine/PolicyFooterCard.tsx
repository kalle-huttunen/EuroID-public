/**
 * PolicyFooterCard — Save, cancel, preview impact
 */

import React from 'react';
import { Card, Row, Col, Space, Button, Tag, Tooltip, Typography, theme } from 'antd';
import { SaveOutlined, EyeOutlined, InfoCircleOutlined } from '@ant-design/icons';
import type { Policy } from './types';

const { Text } = Typography;

interface PolicyFooterCardProps {
  conditionCount: number;
  actionCount: number;
  resolvedBundleCount: number;
  hasAnyActions: boolean;
  canSave: boolean;
  saveDisabledHint: string | null;
  isNew: boolean;
  editingPolicy: Partial<Policy>;
  onSave: (policy: Partial<Policy>) => void;
  onCancel: () => void;
  onPreview: (policy: Partial<Policy>) => void;
}

export const PolicyFooterCard: React.FC<PolicyFooterCardProps> = ({
  conditionCount,
  actionCount,
  resolvedBundleCount,
  hasAnyActions,
  canSave,
  saveDisabledHint,
  isNew,
  editingPolicy,
  onSave,
  onCancel,
  onPreview,
}) => {
  const { token } = theme.useToken();
  const totalActions = actionCount + resolvedBundleCount;

  return (
    <Card
      size="small"
      style={{ background: token.colorSuccessBg, borderColor: token.colorSuccessBorder }}
    >
      <Row justify="space-between" align="middle">
        <Col>
          <Space direction="vertical" size={0}>
            <Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {conditionCount} condition{conditionCount !== 1 ? 's' : ''} • {totalActions} action
                {totalActions !== 1 ? 's' : ''}
              </Text>
              {editingPolicy.status === 'draft' && <Tag color="blue">Draft</Tag>}
            </Space>
            {saveDisabledHint && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                <InfoCircleOutlined /> {saveDisabledHint}
              </Text>
            )}
          </Space>
        </Col>
        <Col>
          <Space>
            <Button onClick={onCancel}>Cancel</Button>
            <Button
              icon={<EyeOutlined />}
              onClick={() => onPreview(editingPolicy)}
              disabled={conditionCount === 0 || !hasAnyActions}
            >
              Preview Impact
            </Button>
            <Tooltip title={saveDisabledHint}>
              <span>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  onClick={() => onSave(editingPolicy)}
                  disabled={!canSave}
                >
                  {isNew ? 'Create Policy' : 'Save Changes'}
                </Button>
              </span>
            </Tooltip>
          </Space>
        </Col>
      </Row>
    </Card>
  );
};
