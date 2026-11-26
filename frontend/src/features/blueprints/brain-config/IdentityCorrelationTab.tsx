/**
 * IdentityCorrelationTab — Correlation rules, field mastery, and writeback settings.
 * Exposes backend CorrelationConfig to the admin via the Brain config drawer.
 */
import React, { useEffect, useState } from 'react';
import {
  Card,
  Form,
  Table,
  Button,
  Space,
  Select,
  Switch,
  Input,
  Radio,
  Slider,
  message,
  Tooltip,
  Typography,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import type { CorrelationRule, CorrelationStrategy, DefaultMasteryView } from '../../../interfaces';
import type { ActiveConnectorInfo } from '../canvas';
import { apiErrorMessage } from '../../dead-letter/dead-letter-labels';

const { Text } = Typography;

/**
 * Golden Record fields that support mastery overrides. A field without an override takes the
 * tenant's default mastery (Admin → Recon Config), shown in the "Default" column.
 */
const MASTERY_FIELDS = [
  'email',
  'firstName',
  'lastName',
  'jobTitle',
  'departmentName',
  'employmentType',
  'location',
  'userPrincipalName',
  'samAccountName',
  'mobilePhone',
].map((key) => ({ key, label: key }));

const STRATEGY_LABELS: Record<CorrelationStrategy, string> = {
  employeeNumber: 'Employee Number',
  email: 'Email (fallback)',
  hashedNationalId: 'Hashed National ID',
  composite: 'Composite (multiple fields)',
  heuristicName: 'Heuristic Name Match',
};

const DEFAULT_CORRELATION_CONFIG = {
  rules: [{ strategy: 'email' as const }],
  conflictAction: 'review' as const,
  fieldMasteryOverrides: {} as Record<string, string>,
  hrWriteback: false,
  targetWriteback: true,
};

export interface CorrelationConfigFormValues {
  rules: CorrelationRule[];
  conflictAction: 'auto-link' | 'review';
  /** Key=field, value=owner id or '__default__' for no override */
  fieldMasteryOverrides: Record<string, string>;
  hrWriteback: boolean;
  targetWriteback: boolean;
}

interface Props {
  brainConfig: CorrelationConfigFormValues | null;
  activeConnectors: ActiveConnectorInfo[];
  onSave: (values: CorrelationConfigFormValues) => Promise<void>;
  /** The tenant's default mastery (useDefaultMastery), for the "Default" column. */
  defaultMastery?: DefaultMasteryView;
  /** Below policy-admin: the settings are read-only and there is no Save. */
  readOnly?: boolean;
}

/** What the "Default" column says for a field: the owners reconcile uses without an override. */
function defaultOwners(
  view: DefaultMasteryView,
  field: string,
  activeConnectors: ActiveConnectorInfo[],
): string {
  if (view.state === 'unreadable') return 'Recon Config (policy-admin)';
  if (view.state === 'unconfigured') return 'None: Recon Config not set';
  if (view.state === 'loading') return '…';
  const owners = view.mastery[field] ?? [];
  if (owners.length === 0) return 'None: primary HR source';
  return owners.map((id) => activeConnectors.find((c) => c.name === id)?.label ?? id).join(' → ');
}

export const IdentityCorrelationTab: React.FC<Props> = ({
  brainConfig,
  activeConnectors,
  onSave,
  defaultMastery = { state: 'loading' },
  readOnly = false,
}) => {
  const [form] = Form.useForm<CorrelationConfigFormValues>();
  const [saving, setSaving] = useState(false);

  const initialValues = brainConfig
    ? {
        ...DEFAULT_CORRELATION_CONFIG,
        ...brainConfig,
        fieldMasteryOverrides: brainConfig.fieldMasteryOverrides || {},
      }
    : DEFAULT_CORRELATION_CONFIG;

  useEffect(() => {
    form.setFieldsValue(initialValues);
  }, [brainConfig, form]);

  const rules = Form.useWatch('rules', form) ?? initialValues.rules;

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      // The rules table edits `rules` through setFieldsValue, not a Form.Item, so
      // validateFields() (registered fields only) leaves them out: read them from the store.
      const rules: CorrelationRule[] = form.getFieldValue('rules') ?? [];

      if (rules.length === 0) {
        message.error('At least one correlation rule is required');
        return;
      }

      const hashedRule = rules.find((r: CorrelationRule) => r.strategy === 'hashedNationalId');
      if (hashedRule && !hashedRule.nationalIdSourceField?.trim()) {
        message.error('Hashed National ID strategy requires a source field (e.g. hetu, ssn)');
        return;
      }

      setSaving(true);
      const overrides = values.fieldMasteryOverrides || {};
      const fieldMasteryOverrides: Record<string, string> = {};
      for (const [k, v] of Object.entries(overrides)) {
        if (v && v !== '__default__') fieldMasteryOverrides[k] = v;
      }
      await onSave({
        ...values,
        rules,
        fieldMasteryOverrides,
      });
      message.success('Identity correlation settings saved');
    } catch (err: unknown) {
      const e = err as { errorFields?: unknown[] };
      if (e?.errorFields) return;
      // The API's message says what to fix, e.g. a Field Mastery owner refused for a
      // contract-critical field
      message.error(apiErrorMessage(err, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  const masteryOptions = [
    { value: '__default__', label: 'Default (Recon Config)' },
    ...activeConnectors.map((c) => ({
      value: c.name,
      label: c.label,
    })),
  ];

  const addRule = () => {
    const current = form.getFieldValue('rules') || [];
    form.setFieldsValue({
      rules: [...current, { strategy: 'email' }],
    });
  };

  const removeRule = (index: number) => {
    const current = form.getFieldValue('rules') || [];
    const next = current.filter((_: unknown, i: number) => i !== index);
    form.setFieldsValue({ rules: next });
  };

  const moveRule = (index: number, direction: 'up' | 'down') => {
    const current = form.getFieldValue('rules') || [];
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= current.length) return;
    const next = [...current];
    [next[index], next[newIndex]] = [next[newIndex], next[index]];
    form.setFieldsValue({ rules: next });
  };

  const updateRule = (index: number, field: keyof CorrelationRule, value: unknown) => {
    const current = form.getFieldValue('rules') || [];
    const next = [...current];
    next[index] = { ...next[index], [field]: value };
    form.setFieldsValue({ rules: next });
  };

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={initialValues}
      onValuesChange={() => {}}
      disabled={readOnly}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        {/* Section 1: Correlation Rules */}
        <Card
          title={
            <Space>
              <span>Correlation Rules</span>
              <Button type="primary" size="small" icon={<PlusOutlined />} onClick={addRule}>
                Add
              </Button>
            </Space>
          }
        >
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            Rules are evaluated in order. First match wins.
          </Text>
          <Table
            dataSource={rules}
            pagination={false}
            size="small"
            rowKey={(_, i) => String(i)}
            columns={[
              {
                title: '#',
                width: 36,
                render: (_, __, i) => i + 1,
              },
              {
                title: 'Strategy',
                render: (_, record, i) => (
                  <Select
                    value={record.strategy}
                    onChange={(v) => updateRule(i, 'strategy', v)}
                    style={{ width: '100%', minWidth: 160 }}
                    options={Object.entries(STRATEGY_LABELS).map(([k, l]) => ({
                      value: k,
                      label: l,
                    }))}
                  />
                ),
              },
              {
                title: 'Config',
                render: (_, record, i) => {
                  if (record.strategy === 'hashedNationalId') {
                    return (
                      <Input
                        placeholder="Field: hetu, ssn, personalId"
                        value={record.nationalIdSourceField}
                        onChange={(e) => updateRule(i, 'nationalIdSourceField', e.target.value)}
                      />
                    );
                  }
                  if (record.strategy === 'composite') {
                    return (
                      <Input
                        placeholder="Comma-separated fields"
                        value={record.compositeFields?.join(', ')}
                        onChange={(e) =>
                          updateRule(
                            i,
                            'compositeFields',
                            e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          )
                        }
                      />
                    );
                  }
                  if (record.strategy === 'heuristicName') {
                    return (
                      <Space direction="vertical" size={4} style={{ width: '100%' }}>
                        <Space align="center" wrap>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            Threshold:
                          </Text>
                          <Slider
                            min={0.5}
                            max={1}
                            step={0.05}
                            value={record.nameMatchThreshold ?? 0.8}
                            onChange={(v) => updateRule(i, 'nameMatchThreshold', v)}
                            style={{ width: 100 }}
                          />
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {(record.nameMatchThreshold ?? 0.8).toFixed(2)}
                          </Text>
                        </Space>
                        <Radio.Group
                          size="small"
                          value={record.nameMatchMode ?? 'both'}
                          onChange={(e) => updateRule(i, 'nameMatchMode', e.target.value)}
                          options={[
                            { value: 'exact', label: 'Exact only' },
                            { value: 'fuzzy', label: 'Fuzzy' },
                            { value: 'both', label: 'Both (default)' },
                          ]}
                        />
                        <Text type="warning" style={{ fontSize: 11, display: 'block' }}>
                          Name matching is a last resort. Use only when no unique identifiers are
                          available.
                        </Text>
                      </Space>
                    );
                  }
                  return <Text type="secondary">—</Text>;
                },
              },
              {
                title: '',
                width: 90,
                render: (_, __, i) => (
                  <Space size={4}>
                    <Button
                      type="text"
                      size="small"
                      aria-label="Move rule up"
                      icon={<ArrowUpOutlined />}
                      disabled={i === 0}
                      onClick={() => moveRule(i, 'up')}
                    />
                    <Button
                      type="text"
                      size="small"
                      aria-label="Move rule down"
                      icon={<ArrowDownOutlined />}
                      disabled={i === (rules?.length ?? 0) - 1}
                      onClick={() => moveRule(i, 'down')}
                    />
                    <Button
                      type="text"
                      size="small"
                      danger
                      aria-label="Remove rule"
                      icon={<DeleteOutlined />}
                      onClick={() => removeRule(i)}
                    />
                  </Space>
                ),
              },
            ]}
          />
          <Form.Item name="conflictAction" label="Conflict action" style={{ marginTop: 16 }}>
            <Radio.Group>
              <Radio value="review">Flag for review</Radio>
              <Radio value="auto-link">Auto-link</Radio>
            </Radio.Group>
          </Form.Item>
        </Card>

        {/* Section 2: Field Mastery */}
        <Card title="Field Mastery">
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            Configure which source system is authoritative for each identity attribute. The owner,
            HR source or target such as Entra ID, replaces the Golden Record value, and no other
            source changes it once the owner has sent one. Until then another source may fill an
            empty field. If not set, defaults apply. A field an HR source owns is read-only on the
            identity page.
          </Text>
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            Contract-critical fields (Recon Config) always come from the primary HR contract. An
            owner set here for one of them, or an HR source node&apos;s mastery of one, may name
            only that primary source: a secondary HR source or a target is refused on save. Choose
            the primary contract through the Contract Tag and ingest priority of the HR sources.
          </Text>
          <Table
            dataSource={MASTERY_FIELDS}
            pagination={false}
            size="small"
            scroll={{ x: 'max-content' }}
            rowKey="key"
            columns={[
              { title: 'Field', dataIndex: 'label', key: 'label', width: 160 },
              {
                title: 'Owner (Priority)',
                key: 'owner',
                render: (_, record) => (
                  <Form.Item name={['fieldMasteryOverrides', record.key]} noStyle>
                    <Select
                      placeholder="Default"
                      allowClear
                      style={{ width: '100%', minWidth: 140 }}
                      options={masteryOptions}
                    />
                  </Form.Item>
                ),
              },
              {
                title: 'Default',
                key: 'default',
                width: 180,
                render: (_, record) => (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {defaultOwners(defaultMastery, record.key, activeConnectors)}
                  </Text>
                ),
              },
            ]}
          />
          <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
            &quot;Default&quot;: the owners from Admin → Recon Config (default mastery), in priority
            order, used when no owner is set here. &quot;None&quot;: the primary HR source&apos;s
            value wins, another HR source fills what it leaves empty.
          </Text>
        </Card>

        {/* Section 3: Writeback Settings */}
        <Card title="Attribute Writeback">
          <Form.Item
            name="targetWriteback"
            label={
              <Space>
                <span>Target → Brain</span>
                <Tooltip title="When target systems generate attributes (email, UPN), write them back to the Golden Record.">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
          >
            <Switch checkedChildren="Enabled" unCheckedChildren="Disabled" />
          </Form.Item>
          <Text type="secondary" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
            When target systems generate attributes (email, UPN), write them back to the Golden
            Record.
          </Text>

          <Form.Item
            name="hrWriteback"
            label={
              <Space>
                <span>Brain → HR Source</span>
                <Tooltip title="Push generated attributes back to the HR system. Requires HR connector with write support.">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
          >
            <Switch checkedChildren="Enabled" unCheckedChildren="Disabled" />
          </Form.Item>
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
            Push generated attributes back to the HR system. Requires HR connector with write
            support.
          </Text>
        </Card>

        {!readOnly && (
          <Button type="primary" onClick={handleSave} loading={saving}>
            Save Identity Correlation Settings
          </Button>
        )}
      </Space>
    </Form>
  );
};
