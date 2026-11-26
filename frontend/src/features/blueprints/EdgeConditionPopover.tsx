/**
 * EdgeConditionPopover – Flow-scoped conditions for Brain → Connector edges.
 * "Only sync if..." rules that filter which users flow through this edge.
 */
import React, { useState, useMemo, useCallback } from 'react';
import {
    Card,
    Space,
    Select,
    Input,
    Button,
    Radio,
    Row,
    Col,
    Typography,
    Tooltip,
    theme,
} from 'antd';
import { CloseOutlined, PlusOutlined } from '@ant-design/icons';
import {
    ConditionOperator,
    AVAILABLE_FIELDS,
} from '../../components/policy-engine/types';
import type { EdgeFlowData, EdgeConditionGroup, EdgeCondition } from './types/edge-condition.types';

const { Text } = Typography;

export interface EdgeConditionPopoverProps {
    edgeId: string;
    edgeData: EdgeFlowData;
    position: { x: number; y: number };
    onSave: (edgeId: string, data: EdgeFlowData) => void;
    onClose: () => void;
    /** Optional: users to estimate "Matching" count (e.g. identity list) */
    usersForCount?: Array<Record<string, unknown>>;
}

function getOperatorOptions(fieldType?: string): { value: ConditionOperator; label: string }[] {
    const base: { value: ConditionOperator; label: string }[] = [
        { value: 'equals', label: 'equals' },
        { value: 'not_equals', label: 'does not equal' },
        { value: 'is_empty', label: 'is empty' },
        { value: 'is_not_empty', label: 'is not empty' },
    ];
    if (fieldType === 'string') {
        return [...base, { value: 'contains', label: 'contains' }, { value: 'in', label: 'is one of' }];
    }
    if (fieldType === 'enum') {
        return [...base, { value: 'in', label: 'is one of' }, { value: 'not_in', label: 'is not one of' }];
    }
    return base;
}

function defaultEdgeData(): EdgeFlowData {
    return {
        conditionsEnabled: true,
        conditionGroups: [
            {
                id: `ecg-${Date.now()}`,
                join: 'AND',
                conditions: [
                    { id: `ec-${Date.now()}`, field: 'status', operator: 'equals', value: 'Active' },
                ],
            },
        ],
    };
}

/** Evaluate a single condition against a user record (StandardUserDto-like). */
function matchesCondition(user: Record<string, unknown>, c: EdgeCondition): boolean {
    const raw = user[c.field];
    const val = raw != null ? String(raw).trim() : '';
    const target = Array.isArray(c.value) ? c.value : c.value ? String(c.value).trim() : '';

    switch (c.operator) {
        case 'equals':
            return val === target;
        case 'not_equals':
            return val !== target;
        case 'contains':
            return val.toLowerCase().includes((target as string).toLowerCase());
        case 'in':
            if (Array.isArray(c.value)) return c.value.some(v => String(v) === val);
            return val === target;
        case 'not_in':
            if (Array.isArray(c.value)) return !c.value.some(v => String(v) === val);
            return val !== target;
        case 'is_empty':
            return val === '';
        case 'is_not_empty':
            return val !== '';
        default:
            return false;
    }
}

function matchesGroup(user: Record<string, unknown>, group: EdgeConditionGroup): boolean {
    if (!group.conditions.length) return true;
    const results = group.conditions.map(c => matchesCondition(user, c));
    return group.join === 'AND' ? results.every(Boolean) : results.some(Boolean);
}

function countMatchingUsers(
    conditionGroups: EdgeConditionGroup[] | undefined,
    enabled: boolean,
    users: Array<Record<string, unknown>>
): number {
    if (!enabled || !conditionGroups?.length) return users.length;
    // User matches if they match ANY condition group (OR across groups)
    return users.filter(user =>
        conditionGroups.some(group => matchesGroup(user, group))
    ).length;
}

function conditionSummary(edgeData: EdgeFlowData): string {
    const groups = edgeData.conditionGroups;
    if (!groups?.length) return 'No conditions';
    const parts = groups.flatMap(g =>
        g.conditions.map(c => {
            const f = AVAILABLE_FIELDS.find(x => x.value === c.field);
            const label = f?.label ?? c.field;
            const v = Array.isArray(c.value) ? c.value.join(', ') : c.value;
            return `${label} ${c.operator} ${v}`;
        })
    );
    return parts.join('; ') || 'Flow conditions active';
}

export const EdgeConditionPopover: React.FC<EdgeConditionPopoverProps> = ({
    edgeId,
    edgeData: initialData,
    position,
    onSave,
    onClose,
    usersForCount = [],
}) => {
    const { token } = theme.useToken();

    const [data, setData] = useState<EdgeFlowData>(() => ({
        ...defaultEdgeData(),
        ...initialData,
        conditionGroups: initialData.conditionGroups?.length
            ? initialData.conditionGroups
            : defaultEdgeData().conditionGroups,
        conditionsEnabled: initialData.conditionsEnabled ?? true,
    }));

    const updateGroup = useCallback((groupId: string, updates: Partial<EdgeConditionGroup>) => {
        setData(prev => ({
            ...prev,
            conditionGroups: prev.conditionGroups?.map(g =>
                g.id === groupId ? { ...g, ...updates } : g
            ) ?? [],
        }));
    }, []);

    const updateCondition = useCallback((groupId: string, conditionId: string, updates: Partial<EdgeCondition>) => {
        setData(prev => ({
            ...prev,
            conditionGroups: prev.conditionGroups?.map(g =>
                g.id === groupId
                    ? { ...g, conditions: g.conditions.map(c => c.id === conditionId ? { ...c, ...updates } : c) }
                    : g
            ) ?? [],
        }));
    }, []);

    const addCondition = useCallback((groupId: string) => {
        const group = data.conditionGroups?.find(g => g.id === groupId);
        if (!group) return;
        const newCond: EdgeCondition = {
            id: `ec-${Date.now()}`,
            field: group.conditions[0]?.field || 'status',
            operator: 'equals',
            value: '',
        };
        setData(prev => ({
            ...prev,
            conditionGroups: prev.conditionGroups?.map(g =>
                g.id === groupId ? { ...g, conditions: [...g.conditions, newCond] } : g
            ) ?? [],
        }));
    }, [data.conditionGroups]);

    const removeCondition = useCallback((groupId: string, conditionId: string) => {
        setData(prev => ({
            ...prev,
            conditionGroups: prev.conditionGroups?.map(g => {
                if (g.id !== groupId) return g;
                const next = g.conditions.filter(c => c.id !== conditionId);
                return { ...g, conditions: next.length ? next : [{ id: `ec-${Date.now()}`, field: 'status', operator: 'equals', value: '' }] };
            }) ?? [],
        }));
    }, []);

    const addGroup = useCallback(() => {
        setData(prev => ({
            ...prev,
            conditionGroups: [
                ...(prev.conditionGroups ?? []),
                { id: `ecg-${Date.now()}`, join: 'OR', conditions: [{ id: `ec-${Date.now()}`, field: 'status', operator: 'equals', value: '' }] },
            ],
        }));
    }, []);

    const matchingCount = useMemo(
        () => countMatchingUsers(data.conditionGroups, data.conditionsEnabled ?? false, usersForCount),
        [data.conditionGroups, data.conditionsEnabled, usersForCount]
    );

    const handleApply = () => {
        onSave(edgeId, data);
    };

    const fieldOptions = useMemo(() => {
        const byCat = AVAILABLE_FIELDS.reduce<Record<string, typeof AVAILABLE_FIELDS>>((acc, f) => {
            if (!acc[f.category]) acc[f.category] = [];
            acc[f.category].push(f);
            return acc;
        }, {});
        return Object.entries(byCat).map(([category, fields]) => ({
            label: category,
            options: fields.map(f => ({ value: f.value, label: f.label })),
        }));
    }, []);

    return (
        <>
            <div
                role="presentation"
                style={{
                    position: 'fixed',
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                    zIndex: 1000,
                }}
                onClick={onClose}
            />
            <Card
                size="small"
                title={
                    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                        <span>Flow conditions</span>
                        <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} aria-label="Close flow conditions" />
                    </Space>
                }
                style={{
                    position: 'fixed',
                    left: Math.min(position.x, typeof window !== 'undefined' ? window.innerWidth - 400 : position.x),
                    top: Math.min(position.y, typeof window !== 'undefined' ? window.innerHeight - 420 : position.y),
                    width: 380,
                    zIndex: 1001,
                    boxShadow: token.boxShadowSecondary,
                }}
                onClick={e => e.stopPropagation()}
            >
                <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
                    Only sync users matching:
                </Text>

                {(data.conditionGroups ?? []).map((group, groupIdx) => (
                    <div key={group.id} style={{ marginBottom: 12 }}>
                        {groupIdx > 0 && (
                            <Text type="secondary" style={{ fontSize: 11, marginBottom: 6, display: 'block' }}>
                                OR
                            </Text>
                        )}
                        <div style={{ background: token.colorFillQuaternary, borderRadius: 6, padding: 8, border: `1px solid ${token.colorBorderSecondary}` }}>
                            <div style={{ marginBottom: 6 }}>
                                <Radio.Group
                                    size="small"
                                    value={group.join}
                                    onChange={e => updateGroup(group.id, { join: e.target.value as 'AND' | 'OR' })}
                                >
                                    <Radio.Button value="AND">AND</Radio.Button>
                                    <Radio.Button value="OR">OR</Radio.Button>
                                </Radio.Group>
                            </div>
                            {group.conditions.map((condition, condIdx) => {
                                const selectedField = AVAILABLE_FIELDS.find(f => f.value === condition.field);
                                return (
                                    <div key={condition.id} style={{ marginBottom: condIdx < group.conditions.length - 1 ? 8 : 0 }}>
                                        {condIdx > 0 && (
                                            <Text type="secondary" style={{ fontSize: 10, margin: '4px 0' }}>{group.join}</Text>
                                        )}
                                        <Row gutter={6} align="middle">
                                            <Col flex="120px">
                                                <Select
                                                    value={condition.field || undefined}
                                                    onChange={v => updateCondition(group.id, condition.id, { field: v, value: '' })}
                                                    placeholder="Field"
                                                    style={{ width: '100%' }}
                                                    size="small"
                                                    showSearch
                                                    optionFilterProp="label"
                                                    options={fieldOptions}
                                                />
                                            </Col>
                                            <Col flex="100px">
                                                <Select
                                                    value={condition.operator}
                                                    onChange={v => updateCondition(group.id, condition.id, { operator: v as ConditionOperator })}
                                                    style={{ width: '100%' }}
                                                    size="small"
                                                    options={getOperatorOptions(selectedField?.type)}
                                                />
                                            </Col>
                                            <Col flex="1">
                                                {condition.operator !== 'is_empty' && condition.operator !== 'is_not_empty' && (
                                                    selectedField?.enumValues ? (
                                                        <Select
                                                            mode={condition.operator === 'in' || condition.operator === 'not_in' ? 'multiple' : undefined}
                                                            value={condition.value || undefined}
                                                            onChange={v => updateCondition(group.id, condition.id, { value: v })}
                                                            placeholder="Value"
                                                            style={{ width: '100%' }}
                                                            size="small"
                                                            options={selectedField.enumValues.map(v => ({ value: v, label: v }))}
                                                        />
                                                    ) : (
                                                        <Input
                                                            value={typeof condition.value === 'string' ? condition.value : ''}
                                                            onChange={e => updateCondition(group.id, condition.id, { value: e.target.value })}
                                                            placeholder="Value"
                                                            size="small"
                                                        />
                                                    )
                                                )}
                                            </Col>
                                            <Col flex="28px">
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
                                style={{ marginTop: 6 }}
                            >
                                Add {group.join}
                            </Button>
                        </div>
                    </div>
                ))}

                <Button type="dashed" size="small" onClick={addGroup} style={{ marginBottom: 12 }}>
                    Add OR group
                </Button>

                <div style={{ marginBottom: 12 }}>
                    <Text type="secondary" style={{ marginRight: 8 }}>Conditions:</Text>
                    <Radio.Group
                        size="small"
                        value={data.conditionsEnabled ? 'enabled' : 'disabled'}
                        onChange={e => setData(prev => ({ ...prev, conditionsEnabled: e.target.value === 'enabled' }))}
                    >
                        <Radio.Button value="enabled">Enabled</Radio.Button>
                        <Radio.Button value="disabled">Disabled</Radio.Button>
                    </Radio.Group>
                </div>

                <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
                    Matching: ~{matchingCount} users
                </Text>

                <Space>
                    <Button size="small" onClick={onClose}>Cancel</Button>
                    <Button type="primary" size="small" onClick={handleApply}>Apply</Button>
                </Space>
            </Card>
        </>
    );
};

/** Helper for canvas: get tooltip text for an edge with flow data */
export function getEdgeConditionTooltip(edgeData: EdgeFlowData): string | null {
    if (!edgeData.conditionsEnabled || !edgeData.conditionGroups?.length) return null;
    return `Flow conditions active: ${conditionSummary(edgeData)}`;
}
