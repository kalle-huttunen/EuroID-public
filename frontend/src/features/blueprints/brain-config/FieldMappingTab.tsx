/**
 * FieldMappingTab -- shows how user attributes flow from HR → Hub → Target.
 * Receives activeConnectors so tabs update dynamically when connectors
 * are added to or removed from the canvas. The values are a fixed sample
 * record (field-mapping.data.ts) and are labelled as such, never as live data.
 */
import React, { useState } from 'react';
import { Space, Alert, Tabs, Table, Tag, Tooltip, Typography, theme } from 'antd';
import {
  TableOutlined,
  ThunderboltOutlined,
  ArrowRightOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { TARGET_CONNECTORS } from '../shared';
import { FIELD_MAPPINGS } from './field-mapping.data';

const { Text } = Typography;

/** Shape of a single entry in FIELD_MAPPINGS */
interface FieldMappingRecord {
  key: string;
  hrField: string;
  hrValue: string;
  euroIdField: string;
  hubValue: string;
  transformation: string;
  required: boolean;
  targets: Record<string, { attr: string; value: string }>;
}

interface Props {
  /** Names of target connectors currently on the canvas */
  activeConnectors: string[];
}

export const FieldMappingTab: React.FC<Props> = ({ activeConnectors }) => {
  const { token } = theme.useToken();

  // Build the target system tabs from the registry, filtered by what's on the canvas
  const visibleTargets = TARGET_CONNECTORS.filter((c) =>
    activeConnectors.some((ac) => ac === c.name),
  );

  // Default to the first visible target (or fallback)
  const [activeTarget, setActiveTarget] = useState(
    visibleTargets[0]?.fieldMappingKey || 'Entra ID',
  );

  // If current tab was removed, reset to first available
  const currentMeta = visibleTargets.find((c) => c.fieldMappingKey === activeTarget);
  const effectiveTarget = currentMeta ? activeTarget : visibleTargets[0]?.fieldMappingKey || '';

  if (visibleTargets.length === 0) {
    return (
      <Alert
        message="No Target Connectors"
        description="Add at least one target connector to the canvas to see field mappings."
        type="warning"
        showIcon
      />
    );
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        message="Attribute Flow Configuration"
        description="See how user attributes flow from HR source through the EuroID Hub to each target system. Select a target system tab to see its specific mappings. The values shown are an illustrative sample record, not data from your identity hub."
        type="info"
        showIcon
        icon={<TableOutlined />}
      />

      {/* Target System Tabs (dynamic from canvas) */}
      <Tabs
        activeKey={effectiveTarget}
        onChange={setActiveTarget}
        type="card"
        items={visibleTargets.map((c) => ({
          key: c.fieldMappingKey!,
          label: (
            <Space>
              {c.icon}
              <span>{c.fieldMappingKey}</span>
            </Space>
          ),
        }))}
        style={{ marginBottom: 0 }}
      />

      {/* Three-Column Mapping Table: Source → Hub → Target */}
      <Table
        dataSource={FIELD_MAPPINGS}
        pagination={false}
        size="small"
        bordered
        scroll={{ y: 400 }}
        columns={[
          {
            title: (
              <Text strong>HR Source</Text>
            ),
            key: 'source',
            width: '28%',
            render: (_: unknown, record: FieldMappingRecord) => (
              <Space direction="vertical" size={2}>
                <Space>
                  <Text code style={{ fontSize: 11 }}>
                    {record.hrField}
                  </Text>
                  {record.required && (
                    <Tag color="red" style={{ fontSize: 9, lineHeight: '14px' }}>
                      Required
                    </Tag>
                  )}
                </Space>
                <Text style={{ fontSize: 12, color: token.colorSuccessActive, fontWeight: 500 }}>
                  {record.hrValue}
                </Text>
              </Space>
            ),
          },
          {
            title: (
              <Space>
                <ArrowRightOutlined style={{ color: token.colorTextTertiary, fontSize: 10 }} />
                <RobotOutlined style={{ color: token.colorPrimary }} />
                <Text strong>EuroID Hub</Text>
              </Space>
            ),
            key: 'hub',
            width: '28%',
            render: (_: unknown, record: FieldMappingRecord) => (
              <Space direction="vertical" size={2}>
                <Space>
                  <Tag color="purple" style={{ fontSize: 11 }}>
                    {record.euroIdField}
                  </Tag>
                  {record.transformation !== 'Direct mapping' && (
                    <Tooltip title={record.transformation}>
                      <ThunderboltOutlined style={{ color: token.colorWarning }} />
                    </Tooltip>
                  )}
                </Space>
                <Text style={{ fontSize: 12, color: token.colorPrimary, fontWeight: 500 }}>
                  {record.hubValue}
                </Text>
              </Space>
            ),
          },
          {
            title: (() => {
              const meta = visibleTargets.find((c) => c.fieldMappingKey === effectiveTarget);
              return (
                <Space>
                  <ArrowRightOutlined style={{ color: token.colorTextTertiary, fontSize: 10 }} />
                  {meta?.icon}
                  <Text strong>{effectiveTarget}</Text>
                </Space>
              );
            })(),
            key: 'target',
            width: '34%',
            render: (_: unknown, record: FieldMappingRecord) => {
              const target = record.targets[effectiveTarget];
              if (!target) return <Text disabled>Not mapped</Text>;
              const meta = visibleTargets.find((c) => c.fieldMappingKey === effectiveTarget);
              return (
                <Space direction="vertical" size={2}>
                  <Text type="secondary" style={{ fontSize: 11, fontFamily: token.fontFamilyCode }}>
                    {target.attr}
                  </Text>
                  <Text
                    style={{
                      fontSize: 12,
                      color: meta?.color || token.colorPrimary,
                      fontWeight: 500,
                      wordBreak: 'break-all',
                    }}
                  >
                    {target.value}
                  </Text>
                </Space>
              );
            },
          },
        ]}
      />
    </Space>
  );
};
