/**
 * One conflicting entitlement in the create form: its kind (system and type), then an entry of
 * the entitlement catalog for that kind. Stores the entry's nativeId (its name when it has none),
 * the id the policy engine and access requests are matched on.
 */
import React from 'react';
import { Button, Form, Select, Space, Typography } from 'antd';
import { MinusCircleOutlined } from '@ant-design/icons';
import type { FormListFieldData } from 'antd/es/form';
import { useCatalogEntitlements } from '@api/entitlement-catalog-api';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { SOD_KINDS } from './sod-labels';

const { Text } = Typography;

const KIND_OPTIONS = SOD_KINDS.map((k) => ({ value: k.key, label: k.label }));

export const SodEntitlementPicker: React.FC<{
  field: FormListFieldData;
  index: number;
  /** Absent while the policy has only the two entitlements the API requires. */
  onRemove?: () => void;
}> = ({ field, index, onRemove }) => {
  const form = Form.useFormInstance();
  const kindKey = Form.useWatch(['entitlements', field.name, 'kind'], form) as string | undefined;
  const kind = SOD_KINDS.find((k) => k.key === kindKey);
  const catalog = useCatalogEntitlements(kind?.system, kind?.catalogType);
  const number = index + 1;

  // The list's duplicate check (SodPolicyFormModal) runs on submit; while it shows an error, a
  // change here runs it again, so the error goes once the duplicate does (one that remains is
  // shown again on the list, so the rejection needs no handling here).
  const recheckDuplicates = () => {
    if (form.getFieldError('entitlements').length === 0) return;
    form.validateFields([['entitlements']]).catch(() => undefined);
  };

  const options = (catalog.data ?? []).map((e) => ({
    value: e.nativeId ?? e.name,
    label: e.name,
    nativeId: e.nativeId,
  }));

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
      <Form.Item
        name={[field.name, 'kind']}
        rules={[{ required: true, message: 'Choose the kind of entitlement' }]}
        style={{ flex: '1 1 200px', marginBottom: 8, minWidth: 0 }}
      >
        <Select
          aria-label={`Kind of entitlement ${number}`}
          placeholder="Kind of entitlement"
          options={KIND_OPTIONS}
          // Another kind lists other entries: the picked one no longer applies.
          onChange={() => {
            form.setFieldValue(['entitlements', field.name, 'targetId'], undefined);
            recheckDuplicates();
          }}
        />
      </Form.Item>
      <Form.Item
        name={[field.name, 'targetId']}
        rules={[{ required: true, message: 'Choose an entitlement' }]}
        extra={
          catalog.isError
            ? `Could not load the catalog: ${apiErrorMessage(catalog.error, 'the request failed')}`
            : undefined
        }
        style={{ flex: '2 1 220px', marginBottom: 8, minWidth: 0 }}
      >
        <Select
          aria-label={`Entitlement ${number}`}
          placeholder={kind ? 'Search the catalog' : 'Choose the kind first'}
          disabled={!kind}
          onChange={recheckDuplicates}
          loading={catalog.isLoading}
          showSearch
          optionFilterProp="label"
          options={options}
          notFoundContent={
            catalog.isLoading ? undefined : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                No {kind?.label.toLowerCase() ?? 'entries'} in the entitlement catalog. Run
                discovery for the connector first.
              </Text>
            )
          }
          optionRender={(opt) => (
            <Space direction="vertical" size={0}>
              <Text>{opt.data.label}</Text>
              {opt.data.nativeId && opt.data.nativeId !== opt.data.label && (
                <Text type="secondary" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                  {opt.data.nativeId}
                </Text>
              )}
            </Space>
          )}
        />
      </Form.Item>
      {onRemove && (
        <Button
          type="text"
          icon={<MinusCircleOutlined />}
          aria-label={`Remove entitlement ${number}`}
          onClick={onRemove}
        />
      )}
    </div>
  );
};
