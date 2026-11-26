/**
 * PriorityMasteryTab — HR connector config: ingest priority, contract tag, field mastery.
 *
 * Shown only for connectors with ingest capability (HR sources).
 * Lower priority number = higher priority. Contract tag drives primary/secondary.
 * Mastery checkboxes define which fields this source is authoritative for.
 */
import React, { useState } from 'react';
import { Form, InputNumber, Radio, Checkbox, Input, Button, Space, Typography, theme } from 'antd';
import { PlusOutlined, CloseOutlined } from '@ant-design/icons';

const { Text } = Typography;

/** Standard Golden Record fields grouped by category (from StandardUserDto). */
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
};

export interface PriorityMasteryTabProps {
  value?: {
    ingestPriority?: number;
    contractTag?: 'PRIMARY' | 'SECONDARY';
    masteryFields?: string[];
  };
  onChange?: (value: {
    ingestPriority?: number;
    contractTag?: 'PRIMARY' | 'SECONDARY';
    masteryFields?: string[];
  }) => void;
}

export const PriorityMasteryTab: React.FC<PriorityMasteryTabProps> = ({ value = {}, onChange }) => {
  const { token } = theme.useToken();
  const [customField, setCustomField] = useState('');
  const { ingestPriority = 1, contractTag = 'PRIMARY', masteryFields = [] } = value;

  const handleChange = (updates: Partial<typeof value>) => {
    onChange?.({ ...value, ...updates });
  };

  const toggleMastery = (field: string, checked: boolean) => {
    const next = checked ? [...masteryFields, field] : masteryFields.filter((f) => f !== field);
    handleChange({ masteryFields: next });
  };

  const addCustomField = () => {
    const trimmed = customField.trim().toLowerCase().replace(/\s+/g, '_');
    if (trimmed && !masteryFields.includes(trimmed)) {
      handleChange({ masteryFields: [...masteryFields, trimmed] });
      setCustomField('');
    }
  };

  const removeCustomField = (field: string) => {
    handleChange({ masteryFields: masteryFields.filter((f) => f !== field) });
  };

  const standardFields = Object.keys(MASTERY_FIELDS_BY_CATEGORY).flatMap(
    (cat) => MASTERY_FIELDS_BY_CATEGORY[cat],
  );
  const customFields = masteryFields.filter((f) => !standardFields.includes(f));

  return (
    <div style={{ padding: '8px 0' }}>
      <Form.Item
        label="Ingest Priority"
        extra="Lower number = higher priority. Primary source (1) wins attribute conflicts."
      >
        <InputNumber
          min={1}
          max={99}
          value={ingestPriority}
          onChange={(v) => handleChange({ ingestPriority: v ?? 1 })}
          style={{ width: 80 }}
        />
      </Form.Item>

      <Form.Item
        label="Contract Tag"
        extra="Primary: main employees. Secondary: side gigs, concurrent roles."
      >
        <Radio.Group
          value={contractTag}
          onChange={(e) => handleChange({ contractTag: e.target.value })}
        >
          <Radio value="PRIMARY">Primary</Radio>
          <Radio value="SECONDARY">Secondary</Radio>
        </Radio.Group>
      </Form.Item>

      <div
        style={{
          marginTop: 24,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          paddingTop: 16,
        }}
      >
        <Text strong style={{ display: 'block', marginBottom: 12 }}>
          Field Mastery (this source is authoritative for):{' '}
        </Text>
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          Contract-critical fields (Recon Config) always come from the primary HR contract. Only the
          source the Contract Tag and ingest priority make primary may list them; on a secondary
          source the save is refused.
        </Text>
        {Object.entries(MASTERY_FIELDS_BY_CATEGORY).map(([category, fields]) => (
          <div key={category} style={{ marginBottom: 16 }}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
              {category}:
            </Text>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {fields.map((field) => (
                <Checkbox
                  key={field}
                  checked={masteryFields.includes(field)}
                  onChange={(e) => toggleMastery(field, e.target.checked)}
                >
                  {field}
                </Checkbox>
              ))}
            </div>
          </div>
        ))}

        <div style={{ marginTop: 16 }}>
          <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
            Custom Fields:
          </Text>
          <Space.Compact style={{ width: '100%', maxWidth: 320 }}>
            <Input
              placeholder="e.g. research_grant_id"
              value={customField}
              onChange={(e) => setCustomField(e.target.value)}
              onPressEnter={addCustomField}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={addCustomField}>
              Add
            </Button>
          </Space.Compact>
          {customFields.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {customFields.map((field) => (
                <span
                  key={field}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    background: token.colorFillTertiary,
                    borderRadius: 4,
                  }}
                >
                  {field}
                  <CloseOutlined
                    style={{ cursor: 'pointer', fontSize: 10 }}
                    onClick={() => removeCustomField(field)}
                  />
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
