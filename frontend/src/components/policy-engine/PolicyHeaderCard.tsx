/**
 * PolicyHeaderCard — Policy name, description, risk, priority
 */

import React from 'react';
import { Card, Space, Select, Input, Row, Col, theme } from 'antd';
import type { Policy } from './types';

interface PolicyHeaderCardProps {
  editingPolicy: Partial<Policy>;
  setEditingPolicy: React.Dispatch<React.SetStateAction<Partial<Policy>>>;
}

export const PolicyHeaderCard: React.FC<PolicyHeaderCardProps> = ({
  editingPolicy,
  setEditingPolicy,
}) => {
  const { token } = theme.useToken();

  return (
    <Card
      size="small"
      style={{ background: token.colorPrimaryBg, borderColor: token.colorPrimaryBorder }}
    >
      <Row gutter={16} align="middle">
        <Col flex="auto">
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Input
              value={editingPolicy.name}
              onChange={(e) => setEditingPolicy((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="Policy name (e.g. Finance Department Access)"
              style={{
                fontSize: 16,
                fontWeight: 600,
                border: 'none',
                padding: 0,
                background: 'transparent',
              }}
              variant="borderless"
            />
            <Input
              value={editingPolicy.description}
              onChange={(e) =>
                setEditingPolicy((prev) => ({ ...prev, description: e.target.value }))
              }
              placeholder="Description of what this policy does..."
              style={{
                fontSize: 12,
                color: token.colorTextSecondary,
                border: 'none',
                padding: 0,
                background: 'transparent',
              }}
              variant="borderless"
            />
          </Space>
        </Col>
        <Col>
          <Space>
            <Select
              value={editingPolicy.risk}
              onChange={(val) => setEditingPolicy((prev) => ({ ...prev, risk: val }))}
              style={{ width: 110 }}
              options={[
                { value: 'Low', label: '🟢 Low Risk' },
                { value: 'Medium', label: '🟡 Medium' },
                { value: 'High', label: '🔴 High' },
                { value: 'Critical', label: '🔴 Critical' },
              ]}
              size="small"
            />
            <Select
              value={editingPolicy.priority}
              onChange={(val) => setEditingPolicy((prev) => ({ ...prev, priority: val }))}
              style={{ width: 80 }}
              options={[
                { value: 1, label: 'P1' },
                { value: 2, label: 'P2' },
                { value: 3, label: 'P3' },
                { value: 4, label: 'P4' },
                { value: 5, label: 'P5' },
              ]}
              size="small"
            />
          </Space>
        </Col>
      </Row>
    </Card>
  );
};
