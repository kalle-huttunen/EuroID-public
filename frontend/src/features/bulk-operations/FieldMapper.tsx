/**
 * Maps CSV columns to StandardUser fields. Auto-maps on load; supports operation type and target systems.
 */
import React from 'react';
import { Alert, Form, Select, Checkbox, Space, Typography, Row, Col, Card } from 'antd';
import { TARGET_CONNECTORS } from '../blueprints/shared/connector-registry';
import { BULK_TARGET_SYSTEM_IDS } from '@config/connector-mapping';
import type { BulkOperationType } from '../../interfaces/bulk-operation.interface';
import type { ParsedCsv } from './CsvUploader';

const { Text } = Typography;

/** StandardUser fields we can map from CSV. Required ones first. */
export const STANDARD_USER_FIELD_OPTIONS: { value: string; label: string; required?: boolean }[] = [
  { value: 'firstName', label: 'First name', required: true },
  { value: 'lastName', label: 'Last name', required: true },
  { value: 'email', label: 'Email', required: true },
  { value: 'sourceSystem', label: 'Source system', required: true },
  { value: 'sourceUserId', label: 'Source user ID', required: true },
  { value: 'tenantId', label: 'Tenant ID' },
  { value: 'middleName', label: 'Middle name' },
  { value: 'preferredName', label: 'Preferred name' },
  { value: 'displayName', label: 'Display name' },
  { value: 'personalEmail', label: 'Personal email' },
  { value: 'mobilePhone', label: 'Mobile phone' },
  { value: 'workPhone', label: 'Work phone' },
  { value: 'jobTitle', label: 'Job title' },
  { value: 'departmentCode', label: 'Department code' },
  { value: 'departmentName', label: 'Department name' },
  { value: 'employeeId', label: 'Employee ID' },
  { value: 'employeeNumber', label: 'Employee number' },
  { value: 'location', label: 'Location' },
  { value: 'status', label: 'Status' },
  { value: 'userPrincipalName', label: 'User principal name' },
  { value: 'managerEmail', label: 'Manager email' },
  { value: 'startDate', label: 'Start date' },
  { value: 'endDate', label: 'End date' },
];

const OPTION_NONE = '__none__';

const normalize = (name: string) => name.toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Suggested fields for unmapped columns, none twice and none already in `taken`: first each
 * column that names a field exactly ("Manager Email" is managerEmail), then each column that
 * contains a field's name, the longest name first ("personal_email_address" is personalEmail).
 * A column that only contains a taken field's name stays unmapped, so a manager's or a personal
 * email never overwrites the user's email.
 */
function autoMapColumns(columns: string[], taken: Set<string>): FieldMapping {
  const suggested: FieldMapping = {};
  const assign = (column: string, field: string | undefined) => {
    if (!field) return;
    suggested[column] = field;
    taken.add(field);
  };
  for (const column of columns) {
    const exact = STANDARD_USER_FIELD_OPTIONS.find((o) => normalize(o.value) === normalize(column));
    if (exact && !taken.has(exact.value)) assign(column, exact.value);
  }
  for (const column of columns) {
    if (column in suggested) continue;
    const contained = STANDARD_USER_FIELD_OPTIONS.filter(
      (o) => !taken.has(o.value) && normalize(column).includes(normalize(o.value)),
    ).sort((a, b) => b.value.length - a.value.length);
    assign(column, contained[0]?.value);
  }
  return suggested;
}

/** Fields more than one column maps to, with those columns. */
function duplicateMappings(mapping: FieldMapping): Array<{ field: string; columns: string[] }> {
  const byField = new Map<string, string[]>();
  for (const [column, field] of Object.entries(mapping)) {
    byField.set(field, [...(byField.get(field) ?? []), column]);
  }
  return [...byField.entries()]
    .filter(([, columns]) => columns.length > 1)
    .map(([field, columns]) => ({ field, columns }));
}

export interface FieldMapping {
  [csvColumn: string]: string;
}

interface FieldMapperProps {
  parsedCsv: ParsedCsv | null;
  mapping: FieldMapping;
  onMappingChange: (m: FieldMapping) => void;
  operationType: BulkOperationType;
  onOperationTypeChange: (t: BulkOperationType) => void;
  targetSystems: string[];
  onTargetSystemsChange: (s: string[]) => void;
}

export const FieldMapper: React.FC<FieldMapperProps> = ({
  parsedCsv,
  mapping,
  onMappingChange,
  operationType,
  onOperationTypeChange,
  targetSystems,
  onTargetSystemsChange,
}) => {
  const headers = parsedCsv?.headers ?? [];
  const requiredFields = STANDARD_USER_FIELD_OPTIONS.filter((f) => f.required).map((f) => f.value);

  const handleMapChange = (csvCol: string, fieldValue: string) => {
    const next = { ...mapping };
    if (fieldValue === OPTION_NONE) {
      delete next[csvCol];
    } else {
      next[csvCol] = fieldValue;
    }
    onMappingChange(next);
  };

  React.useEffect(() => {
    if (!parsedCsv || headers.length === 0) return;
    const unmapped = headers.filter((h) => mapping[h] === undefined);
    const suggested = autoMapColumns(unmapped, new Set(Object.values(mapping)));
    if (Object.keys(suggested).length > 0) onMappingChange({ ...mapping, ...suggested });
  }, [parsedCsv?.headers?.join(',')]);

  const fieldOptions = [
    { value: OPTION_NONE, label: "(Don't map)" },
    ...STANDARD_USER_FIELD_OPTIONS.map((o) => ({
      value: o.value,
      label: o.label + (o.required ? ' (required)' : ''),
    })),
  ];

  const duplicates = duplicateMappings(mapping);
  const labelOf = (field: string) =>
    STANDARD_USER_FIELD_OPTIONS.find((o) => o.value === field)?.label ?? field;

  const targetOptions = TARGET_CONNECTORS.filter(
    (c) => c.hasBackend && BULK_TARGET_SYSTEM_IDS.includes(c.id ?? ''),
  ).map((c) => ({
    label: c.name,
    value: c.name,
  }));

  if (headers.length === 0) {
    return (
      <Card>
        <Text type="secondary">Upload a CSV in step 1 to map columns to user fields.</Text>
      </Card>
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Form layout="vertical">
        <Form.Item label="What should we do with these users?" required>
          <Select
            value={operationType}
            onChange={onOperationTypeChange}
            options={[
              { value: 'CREATE', label: 'Create' },
              { value: 'UPDATE', label: 'Update' },
              { value: 'DELETE', label: 'Delete' },
            ]}
            style={{ width: 200 }}
          />
        </Form.Item>

        <Form.Item label="Target systems" required>
          <Checkbox.Group
            value={targetSystems}
            onChange={(vals) => onTargetSystemsChange(vals as string[])}
            options={targetOptions}
          />
        </Form.Item>
      </Form>

      {duplicates.map(({ field, columns }) => (
        <Alert
          key={field}
          type="warning"
          showIcon
          message={`${columns.length} columns map to ${labelOf(field)}: ${columns.join(', ')}. Each user gets the value of the last one; map the others to another field or to (Don't map).`}
        />
      ))}
      <Card title="Column mapping" size="small">
        <Row gutter={[16, 12]}>
          {headers.map((col) => {
            const mapped = mapping[col] || OPTION_NONE;
            const isRequired = mapped !== OPTION_NONE && requiredFields.includes(mapped);
            return (
              <Col xs={24} sm={12} key={col}>
                <Space align="center">
                  <Text strong style={{ minWidth: 140 }}>
                    {col}
                  </Text>
                  <Text type="secondary">→</Text>
                  <Select
                    value={mapped}
                    onChange={(v) => handleMapChange(col, v)}
                    options={fieldOptions}
                    style={{ minWidth: 200 }}
                    status={isRequired ? undefined : 'warning'}
                  />
                  {isRequired && <Text type="danger">*</Text>}
                </Space>
              </Col>
            );
          })}
        </Row>
      </Card>
    </Space>
  );
};
