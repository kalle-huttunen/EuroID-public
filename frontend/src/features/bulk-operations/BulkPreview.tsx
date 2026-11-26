/**
 * Preview step before bulk execute. Shows operation list, dry-run toggle, and batch settings.
 */
import React from 'react';
import { Button, Table, Switch, Select, Space, Typography, Tag } from 'antd';
import { usePermission } from '../../auth';
import { WarningOutlined, PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import type { IBulkOperation, BulkOperationType } from '../../interfaces/bulk-operation.interface';
import type { IStandardUser } from '../../interfaces/standard-user.interface';
import { UserStatus } from '../../interfaces/standard-user.interface';
import type { ParsedCsv } from './CsvUploader';
import type { FieldMapping } from './FieldMapper';

const { Text } = Typography;

function buildUserFromRow(
  row: string[],
  headers: string[],
  mapping: FieldMapping,
): Partial<IStandardUser> {
  const user: Record<string, unknown> = {};
  headers.forEach((col, i) => {
    const field = mapping[col];
    if (field && row[i] !== undefined && row[i] !== '') {
      user[field] = row[i];
    }
  });
  if (!user.status) user.status = UserStatus.ACTIVE;
  return user as Partial<IStandardUser>;
}

function buildOperations(
  parsedCsv: ParsedCsv,
  mapping: FieldMapping,
  operationType: BulkOperationType,
  targetSystems: string[],
): IBulkOperation[] {
  const required = ['firstName', 'lastName', 'email', 'sourceSystem', 'sourceUserId'];
  const ops: IBulkOperation[] = [];
  parsedCsv.rows.forEach((row, index) => {
    const user = buildUserFromRow(row, parsedCsv.headers, mapping);
    const hasRequired = required.every((r) => user[r as keyof IStandardUser]);
    if (!hasRequired) return;
    ops.push({
      id: `op-${index + 1}`,
      type: operationType,
      user,
      targetSystems: targetSystems.length > 0 ? targetSystems : ['entra-id'],
      priority: 1,
      requiresApproval: operationType === 'DELETE',
    });
  });
  return ops;
}

interface BulkPreviewProps {
  parsedCsv: ParsedCsv | null;
  mapping: FieldMapping;
  operationType: BulkOperationType;
  targetSystems: string[];
  dryRun: boolean;
  continueOnError: boolean;
  batchSize: number;
  requireApprovalForDeletes: boolean;
  onDryRunChange: (v: boolean) => void;
  onContinueOnErrorChange: (v: boolean) => void;
  onBatchSizeChange: (v: number) => void;
  onRequireApprovalChange: (v: boolean) => void;
  /** Starts the batch; Execute stays disabled until the returned promise settles. */
  onExecute: (operations: IBulkOperation[]) => Promise<void> | void;
}

const typeColors: Record<BulkOperationType, string> = {
  CREATE: 'green',
  UPDATE: 'blue',
  DELETE: 'red',
  DISABLE: 'orange',
};

const typeIcons: Record<BulkOperationType, React.ReactNode> = {
  CREATE: <PlusOutlined />,
  UPDATE: <EditOutlined />,
  DELETE: <DeleteOutlined />,
  DISABLE: <WarningOutlined />,
};

export const BulkPreview: React.FC<BulkPreviewProps> = (props) => {
  const canExecute = usePermission('operator');
  const {
    parsedCsv,
    mapping,
    operationType,
    targetSystems,
    dryRun,
    continueOnError,
    batchSize,
    requireApprovalForDeletes,
    onDryRunChange,
    onContinueOnErrorChange,
    onBatchSizeChange,
    onRequireApprovalChange,
    onExecute,
  } = props;

  const operations = React.useMemo(() => {
    if (!parsedCsv) return [];
    return buildOperations(parsedCsv, mapping, operationType, targetSystems);
  }, [parsedCsv, mapping, operationType, targetSystems]);

  const stats = React.useMemo(() => {
    const creates = operations.filter((o) => o.type === 'CREATE').length;
    const updates = operations.filter((o) => o.type === 'UPDATE').length;
    const deletes = operations.filter((o) => o.type === 'DELETE').length;
    const disables = operations.filter((o) => o.type === 'DISABLE').length;
    return { creates, updates, deletes, disables };
  }, [operations]);

  const canExecuteOperations = operations.length > 0 && targetSystems.length > 0;
  // Rows without every required field get no operation: say so rather than drop them unseen
  const leftOut = (parsedCsv?.rows.length ?? 0) - operations.length;
  // One start per click: a second click while the start request runs would start a second batch
  const [executing, setExecuting] = React.useState(false);
  const executingRef = React.useRef(false);
  const execute = async () => {
    if (executingRef.current) return;
    executingRef.current = true;
    setExecuting(true);
    try {
      await onExecute(operations);
    } finally {
      executingRef.current = false;
      setExecuting(false);
    }
  };

  const columns = [
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 100,
      render: (t: BulkOperationType) => (
        <Tag color={typeColors[t]} icon={typeIcons[t]}>
          {t}
        </Tag>
      ),
    },
    {
      title: 'User',
      key: 'user',
      render: (_: unknown, r: IBulkOperation) => {
        const u = r.user;
        const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '—';
        return <Text>{name}</Text>;
      },
    },
    {
      title: 'Email',
      dataIndex: ['user', 'email'],
      key: 'email',
      ellipsis: true,
    },
    {
      title: 'Target systems',
      dataIndex: 'targetSystems',
      key: 'targetSystems',
      render: (sys: string[]) => sys?.join(', ') || '—',
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div>
        <Text strong>Stats: </Text>
        {stats.creates > 0 && <Tag color="green">{stats.creates} Creates</Tag>}
        {stats.updates > 0 && <Tag color="blue">{stats.updates} Updates</Tag>}
        {stats.deletes > 0 && <Tag color="red">{stats.deletes} Deletes</Tag>}
        {stats.disables > 0 && <Tag color="orange">{stats.disables} Disables</Tag>}
      </div>

      <Table
        size="small"
        rowClassName={(r) => `bulk-row-${r.type.toLowerCase()}`}
        columns={columns}
        dataSource={operations.map((o) => ({ ...o, key: o.id }))}
        pagination={{ pageSize: 10 }}
        scroll={{ x: 'max-content' }}
      />

      <Space wrap align="center" size="middle">
        <Space>
          <Text>Dry run</Text>
          <Switch checked={dryRun} onChange={onDryRunChange} />
        </Space>
        <Space>
          <Text>Continue on error</Text>
          <Switch checked={continueOnError} onChange={onContinueOnErrorChange} />
        </Space>
        <Space>
          <Text>Batch size</Text>
          <Select
            value={batchSize}
            onChange={onBatchSizeChange}
            options={[10, 25, 50, 100].map((n) => ({ value: n, label: String(n) }))}
            style={{ width: 80 }}
          />
        </Space>
        <Space>
          <Text>Require approval for deletes</Text>
          <Switch checked={requireApprovalForDeletes} onChange={onRequireApprovalChange} />
        </Space>
      </Space>

      {leftOut > 0 && (
        <Text type="warning">
          {leftOut} {leftOut === 1 ? 'row' : 'rows'} left out: a required field is empty (first
          name, last name, email, source system or source user ID).
        </Text>
      )}
      {!canExecuteOperations && (
        <Text type="secondary">
          Map required fields and select at least one target system to enable Execute.
        </Text>
      )}
      <div style={{ marginTop: 8 }}>
        {canExecute && (
          <Button
            type="primary"
            size="large"
            disabled={!canExecuteOperations || executing}
            loading={executing}
            onClick={execute}
          >
            Execute
          </Button>
        )}
      </div>
    </Space>
  );
};
