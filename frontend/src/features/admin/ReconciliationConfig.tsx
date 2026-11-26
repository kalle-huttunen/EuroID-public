/**
 * ReconciliationConfig — Admin UI for per-tenant reconciliation rules.
 * Configures HR source tags, source priority, contract-critical fields,
 * default field mastery, and target ID keys.
 */
import React, { useEffect, useState } from 'react';
import {
  App,
  Card,
  Form,
  Button,
  Input,
  Tag,
  Typography,
  Alert,
  Space,
  Skeleton,
  Table,
  Select,
  Checkbox,
  theme,
  Divider,
  Tooltip,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import {
  useReconciliationConfig,
  useUpsertReconciliationConfig,
} from '@api/reconciliation-config-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { ErrorState } from '@shared/ErrorState';

const { Text } = Typography;

const MASTERY_FIELDS_BY_CATEGORY: Record<string, string[]> = {
  Identity: [
    'firstName',
    'lastName',
    'displayName',
    'email',
    'personalEmail',
    'preferredName',
    'middleName',
  ],
  Employment: [
    'jobTitle',
    'departmentName',
    'departmentCode',
    'division',
    'costCenter',
    'managerEmail',
    'managerId',
    'employmentType',
    'startDate',
    'endDate',
    'employeeId',
  ],
  Contact: ['mobilePhone', 'workPhone', 'officeExtension'],
  Location: ['location', 'city', 'countryCode', 'stateProvince', 'officeName', 'officeLocation'],
  System: ['userPrincipalName', 'samAccountName', 'status'],
};

const ALL_FIELDS = Object.values(MASTERY_FIELDS_BY_CATEGORY).flat();

/** Reusable tag-style input for string arrays. */
function TagArrayInput({
  value = [],
  onChange,
  placeholder,
}: {
  value?: string[];
  onChange?: (v: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState('');
  const add = () => {
    const trimmed = input.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange?.([...value, trimmed]);
    }
    setInput('');
  };
  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        {value.map((tag) => (
          <Tag key={tag} closable onClose={() => onChange?.(value.filter((t) => t !== tag))}>
            {tag}
          </Tag>
        ))}
      </Space>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={add}
          placeholder={placeholder}
          style={{ maxWidth: 300 }}
        />
        <Button icon={<PlusOutlined />} onClick={add}>
          Add
        </Button>
      </Space.Compact>
    </div>
  );
}

/** Sortable list for source priority. */
function SortableList({
  value = [],
  onChange,
}: {
  value?: string[];
  onChange?: (v: string[]) => void;
}) {
  const [input, setInput] = useState('');
  const move = (idx: number, dir: -1 | 1) => {
    const arr = [...value];
    const target = idx + dir;
    if (target < 0 || target >= arr.length) return;
    [arr[idx], arr[target]] = [arr[target], arr[idx]];
    onChange?.(arr);
  };
  const add = () => {
    const trimmed = input.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange?.([...value, trimmed]);
    }
    setInput('');
  };
  const remove = (idx: number) => {
    onChange?.(value.filter((_, i) => i !== idx));
  };
  return (
    <div>
      {value.map((item, i) => (
        <div key={item} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Text style={{ minWidth: 24 }}>{i + 1}.</Text>
          <Tag>{item}</Tag>
          <Button
            size="small"
            aria-label="Move up"
            icon={<ArrowUpOutlined />}
            disabled={i === 0}
            onClick={() => move(i, -1)}
          />
          <Button
            size="small"
            aria-label="Move down"
            icon={<ArrowDownOutlined />}
            disabled={i === value.length - 1}
            onClick={() => move(i, 1)}
          />
          <Button
            size="small"
            aria-label="Remove"
            icon={<DeleteOutlined />}
            danger
            onClick={() => remove(i)}
          />
        </div>
      ))}
      <Space.Compact style={{ marginTop: 8, width: '100%' }}>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={add}
          placeholder="Add source name"
          style={{ maxWidth: 300 }}
        />
        <Button icon={<PlusOutlined />} onClick={add}>
          Add
        </Button>
      </Space.Compact>
    </div>
  );
}

/** Editor for defaultMastery: field -> ordered source list. */
function MasteryEditor({
  value = {},
  onChange,
}: {
  value?: Record<string, string[]>;
  onChange?: (v: Record<string, string[]>) => void;
}) {
  const [newField, setNewField] = useState('');
  const fields = Object.keys(value);

  const updateField = (field: string, sources: string[]) => {
    onChange?.({ ...value, [field]: sources });
  };
  const removeField = (field: string) => {
    const copy = { ...value };
    delete copy[field];
    onChange?.(copy);
  };
  const addField = () => {
    if (newField && !value[newField]) {
      onChange?.({ ...value, [newField]: [] });
      setNewField('');
    }
  };

  const columns = [
    {
      title: 'Field',
      dataIndex: 'field',
      key: 'field',
      width: 180,
      render: (f: string) => <Text code>{f}</Text>,
    },
    {
      title: 'Source Priority (first wins)',
      dataIndex: 'sources',
      key: 'sources',
      render: (_: string[], record: { field: string; sources: string[] }) => (
        <Select
          mode="tags"
          value={record.sources}
          onChange={(v) => updateField(record.field, v)}
          style={{ width: '100%' }}
          placeholder="Type source names in priority order"
          tokenSeparators={[',']}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 50,
      render: (_: unknown, record: { field: string }) => (
        <Button
          size="small"
          aria-label="Remove field"
          icon={<DeleteOutlined />}
          danger
          onClick={() => removeField(record.field)}
        />
      ),
    },
  ];

  const dataSource = fields.map((f) => ({ key: f, field: f, sources: value[f] }));

  return (
    <div>
      <Table
        dataSource={dataSource}
        columns={columns}
        pagination={false}
        size="small"
        style={{ marginBottom: 12 }}
      />
      <Space.Compact>
        <Select
          showSearch
          value={newField || undefined}
          onChange={setNewField}
          placeholder="Select or type field name"
          style={{ width: 250 }}
          options={ALL_FIELDS.filter((f) => !value[f]).map((f) => ({ label: f, value: f }))}
        />
        <Button icon={<PlusOutlined />} onClick={addField}>
          Add Field
        </Button>
      </Space.Compact>
    </div>
  );
}

export function ReconciliationConfig() {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const { data, isLoading, isError, error, refetch } = useReconciliationConfig();
  const upsert = useUpsertReconciliationConfig();

  const [hrSourceTags, setHrSourceTags] = useState<string[]>([]);
  const [sourcePriorityOrder, setSourcePriorityOrder] = useState<string[]>([]);
  const [contractCriticalFields, setContractCriticalFields] = useState<string[]>([]);
  const [defaultMastery, setDefaultMastery] = useState<Record<string, string[]>>({});
  const [targetIdKeys, setTargetIdKeys] = useState<string[]>([]);

  useEffect(() => {
    if (data?.config) {
      const cfg = data.config;
      queueMicrotask(() => {
        setHrSourceTags(cfg.hrSourceTags);
        setSourcePriorityOrder(cfg.sourcePriorityOrder);
        setContractCriticalFields(cfg.contractCriticalFields);
        setDefaultMastery(cfg.defaultMastery);
        setTargetIdKeys(cfg.targetIdKeys);
      });
    }
  }, [data]);

  const handleSave = async () => {
    try {
      await upsert.mutateAsync({
        hrSourceTags,
        sourcePriorityOrder,
        contractCriticalFields,
        defaultMastery,
        targetIdKeys,
      });
      message.success('Reconciliation config saved');
    } catch (err) {
      // The API's own message says what to fix (e.g. a refused contract-critical owner)
      message.error(apiErrorMessage(err, 'Failed to save config'));
    }
  };

  if (isLoading) {
    return (
      <div style={{ padding: 24, background: token.colorFillQuaternary, minHeight: '100%' }}>
        <Skeleton active paragraph={{ rows: 12 }} />
      </div>
    );
  }

  // A failed load offers no Save: the empty fields would be saved over the stored config
  if (isError) {
    return (
      <PageContainer>
        <PageHeader
          title="Reconciliation config"
          subtitle="Which sources are authoritative, in what order, and for which fields."
        />
        <ErrorState
          title="Reconciliation config could not be loaded"
          error={error}
          onRetry={() => void refetch()}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Reconciliation config"
        subtitle="Which sources are authoritative, in what order, and for which fields."
        actions={
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={upsert.isPending}
          >
            Save
          </Button>
        }
      />

      {!data?.configured && (
        <Alert
          type="warning"
          showIcon
          message="No reconciliation config found for this tenant."
          description="Configure the settings below and save. Until configured, reconciliation will run in open-merge mode (no mastery enforcement)."
          style={{ marginBottom: 16 }}
        />
      )}

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {/* HR Source Tags */}
        <Card
          size="small"
          title="HR source tags"
          extra={<Text type="secondary">Connector names treated as HR sources</Text>}
        >
          <TagArrayInput
            value={hrSourceTags}
            onChange={setHrSourceTags}
            placeholder="e.g. workday, csv-hr, personio"
          />
        </Card>

        {/* Source Priority Order */}
        <Card
          size="small"
          title="Source priority order"
          extra={<Text type="secondary">Lower position = higher priority</Text>}
        >
          <SortableList value={sourcePriorityOrder} onChange={setSourcePriorityOrder} />
        </Card>

        {/* Contract-Critical Fields */}
        <Card
          size="small"
          title="Contract-critical fields"
          extra={<Text type="secondary">Only the primary HR contract sets these</Text>}
        >
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            The primary HR contract always sets these fields; no mastery entry changes that. A
            default mastery or Field Mastery entry naming a secondary HR source or a target for one
            of them is refused on save. Choose the primary contract through the Contract Tag and
            ingest priority of the HR sources.
          </Text>
          {Object.entries(MASTERY_FIELDS_BY_CATEGORY).map(([cat, fields]) => (
            <div key={cat} style={{ marginBottom: 12 }}>
              <Text strong>{cat}</Text>
              <div style={{ marginTop: 4 }}>
                <Checkbox.Group
                  value={contractCriticalFields.filter((f) => fields.includes(f))}
                  onChange={(checked) => {
                    const others = contractCriticalFields.filter((f) => !fields.includes(f));
                    setContractCriticalFields([...others, ...(checked as string[])]);
                  }}
                  options={fields.map((f) => ({ label: f, value: f }))}
                />
              </div>
            </div>
          ))}
        </Card>

        {/* Default Mastery */}
        <Card
          size="small"
          title="Default field mastery"
          extra={
            <Text type="secondary">Per-field source priority (first source in list wins)</Text>
          }
        >
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            A field an HR source masters is read-only on the identity page: change it in HR. For a
            contract-critical field an entry may name only the primary HR source.
          </Text>
          <MasteryEditor value={defaultMastery} onChange={setDefaultMastery} />
        </Card>

        {/* Target ID Keys */}
        <Card
          size="small"
          title="Target ID keys"
          extra={<Text type="secondary">Keys redirected to customAttributes</Text>}
        >
          <TagArrayInput
            value={targetIdKeys}
            onChange={setTargetIdKeys}
            placeholder="e.g. objectId, objectGUID, id"
          />
        </Card>
      </Space>
    </PageContainer>
  );
}
