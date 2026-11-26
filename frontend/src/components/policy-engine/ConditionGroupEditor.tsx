/**
 * ConditionGroupEditor — Renders condition groups for IF section.
 * Supports reordering conditions via up/down buttons.
 */

import React from 'react';
import { Space, Select, Input, Button, Tag, Typography, Radio, Row, Col, theme, Tooltip } from 'antd';
import { PlusOutlined, CloseOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';
import { AVAILABLE_FIELDS } from './types';
import type { ConditionGroup, PolicyCondition, ConditionOperator } from './types';

const { Text } = Typography;

function getOperatorOptions(fieldType?: string): { value: string; label: string }[] {
  const baseOps = [
    { value: 'equals', label: 'equals' },
    { value: 'not_equals', label: 'does not equal' },
    { value: 'is_empty', label: 'is empty' },
    { value: 'is_not_empty', label: 'is not empty' },
  ];
  if (fieldType === 'string') {
    return [
      ...baseOps,
      { value: 'contains', label: 'contains' },
      { value: 'starts_with', label: 'starts with' },
      { value: 'ends_with', label: 'ends with' },
      { value: 'in', label: 'is one of' },
      { value: 'regex', label: 'matches regex' },
    ];
  }
  if (fieldType === 'number') {
    return [
      ...baseOps,
      { value: 'greater_than', label: 'greater than' },
      { value: 'less_than', label: 'less than' },
    ];
  }
  if (fieldType === 'enum') {
    return [
      ...baseOps,
      { value: 'in', label: 'is one of' },
      { value: 'not_in', label: 'is not one of' },
    ];
  }
  return baseOps;
}

interface ConditionGroupEditorProps {
  conditionGroups: ConditionGroup[];
  updateConditionGroup: (groupId: string, updates: Partial<ConditionGroup>) => void;
  updateCondition: (
    groupId: string,
    conditionId: string,
    updates: Partial<PolicyCondition>,
  ) => void;
  addCondition: (groupId: string) => void;
  removeCondition: (groupId: string, conditionId: string) => void;
  reorderCondition?: (groupId: string, oldIndex: number, newIndex: number) => void;
}

export const ConditionGroupEditor: React.FC<ConditionGroupEditorProps> = ({
  conditionGroups,
  updateConditionGroup,
  updateCondition,
  addCondition,
  removeCondition,
  reorderCondition,
}) => {
  const { token } = theme.useToken();

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {conditionGroups?.map((group, groupIdx) => (
        <div key={group.id}>
          {groupIdx > 0 && (
            <div style={{ textAlign: 'center', margin: '8px 0' }}>
              <Tag color="purple">AND</Tag>
            </div>
          )}

          {group.conditions.length > 1 && (
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 11, marginRight: 8 }}>
                Match:
              </Text>
              <Radio.Group
                value={group.join}
                onChange={(e) => updateConditionGroup(group.id, { join: e.target.value })}
                size="small"
              >
                <Radio.Button value="AND">ALL conditions (AND)</Radio.Button>
                <Radio.Button value="OR">ANY condition (OR)</Radio.Button>
              </Radio.Group>
            </div>
          )}

          {group.conditions.map((condition, condIdx) => {
            const selectedField = AVAILABLE_FIELDS.find((f) => f.value === condition.field);
            return (
              <div key={condition.id} style={{ marginBottom: 8 }}>
                {condIdx > 0 && (
                  <Tag
                    color={group.join === 'AND' ? 'blue' : 'orange'}
                    style={{ margin: '4px 0 8px 0', fontSize: 10 }}
                  >
                    {group.join}
                  </Tag>
                )}
                <Row
                  gutter={8}
                  align="middle"
                  style={{
                    background: token.colorFillQuaternary,
                    borderRadius: 6,
                    padding: '8px 12px',
                    border: `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  {/* Reorder buttons */}
                  {reorderCondition && group.conditions.length > 1 && (
                    <Col flex="48px">
                      <Space direction="vertical" size={0}>
                        <Tooltip title="Move up">
                          <Button
                            type="text"
                            size="small"
                            aria-label="Move condition up" icon={<ArrowUpOutlined style={{ fontSize: 10 }} />}
                            disabled={condIdx === 0}
                            onClick={() => reorderCondition(group.id, condIdx, condIdx - 1)}
                            style={{ padding: '0 4px', height: 18 }}
                          />
                        </Tooltip>
                        <Tooltip title="Move down">
                          <Button
                            type="text"
                            size="small"
                            aria-label="Move condition down" icon={<ArrowDownOutlined style={{ fontSize: 10 }} />}
                            disabled={condIdx === group.conditions.length - 1}
                            onClick={() => reorderCondition(group.id, condIdx, condIdx + 1)}
                            style={{ padding: '0 4px', height: 18 }}
                          />
                        </Tooltip>
                      </Space>
                    </Col>
                  )}

                  <Col flex="180px">
                    <Select
                      value={condition.field || undefined}
                      onChange={(val) =>
                        updateCondition(group.id, condition.id, { field: val, value: '' })
                      }
                      placeholder="Select field..."
                      style={{ width: '100%' }}
                      size="small"
                      showSearch
                      optionFilterProp="label"
                      options={Object.entries(
                        AVAILABLE_FIELDS.reduce<Record<string, typeof AVAILABLE_FIELDS>>(
                          (acc, f) => {
                            if (!acc[f.category]) acc[f.category] = [];
                            acc[f.category].push(f);
                            return acc;
                          },
                          {},
                        ),
                      ).map(([category, fields]) => ({
                        label: category,
                        options: fields.map((f) => ({ value: f.value, label: f.label })),
                      }))}
                    />
                  </Col>

                  <Col flex="160px">
                    <Select
                      value={condition.operator}
                      onChange={(val) =>
                        updateCondition(group.id, condition.id, {
                          operator: val as ConditionOperator,
                        })
                      }
                      style={{ width: '100%' }}
                      size="small"
                      options={getOperatorOptions(selectedField?.type)}
                    />
                  </Col>

                  <Col flex="auto">
                    {condition.operator !== 'is_empty' &&
                      condition.operator !== 'is_not_empty' &&
                      (selectedField?.enumValues ? (
                        <Select
                          mode={
                            condition.operator === 'in' || condition.operator === 'not_in'
                              ? 'multiple'
                              : undefined
                          }
                          value={condition.value || undefined}
                          onChange={(val) =>
                            updateCondition(group.id, condition.id, { value: val })
                          }
                          placeholder="Select value..."
                          style={{ width: '100%' }}
                          size="small"
                          options={selectedField.enumValues.map((v) => ({ value: v, label: v }))}
                        />
                      ) : (
                        <Input
                          value={typeof condition.value === 'string' ? condition.value : ''}
                          onChange={(e) =>
                            updateCondition(group.id, condition.id, { value: e.target.value })
                          }
                          placeholder="Enter value..."
                          size="small"
                        />
                      ))}
                  </Col>

                  <Col flex="32px">
                    <Button
                      type="text"
                      danger
                      size="small"
                      aria-label="Remove condition" icon={<CloseOutlined />}
                      onClick={() => removeCondition(group.id, condition.id)}
                      disabled={group.conditions.length <= 1}
                    />
                  </Col>
                </Row>
              </div>
            );
          })}

          <Button
            type="dashed"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => addCondition(group.id)}
            style={{ marginTop: 4 }}
          >
            Add Condition
          </Button>
        </div>
      ))}
    </Space>
  );
};
