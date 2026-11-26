/**
 * The explorer's inputs. An identity is picked by name or work email (GET /identity, the NHI owner
 * picker); one opened by link is named from GET /identity/:id. An entitlement is picked from the
 * entitlement catalog (kind, then entry: only entries with an id in their system) or typed as that
 * id, for entitlements the catalog does not list. Either way the value is the graph's key,
 * `<system>::<id in that system>` (backend entitlement-node-id.ts), the system the kind's: a native
 * id alone can name entitlements in two systems.
 */
import React, { useState } from 'react';
import { Button, Input, Select, Space, Typography } from 'antd';
import { useIdentity, type IdentityOption } from '@api/identity-api';
import { useCatalogEntitlements } from '@api/entitlement-catalog-api';
import { getUserDisplayName } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { OwnerPicker } from '../nhi/OwnerPicker';
import { SOD_KINDS } from '../sod-policies/sod-labels';

const { Text } = Typography;

export const IdentityPicker: React.FC<{
  value?: string;
  onChange: (identityId: string | undefined) => void;
}> = ({ value, onChange }) => {
  const identity = useIdentity(value);
  const initial: IdentityOption | undefined = identity.data
    ? {
        id: value as string,
        email: identity.data.email,
        displayName: getUserDisplayName(identity.data),
        status: identity.data.status,
      }
    : undefined;
  return (
    <div style={{ width: 360, maxWidth: '100%' }}>
      <OwnerPicker
        // Mounted again once the linked identity's name is known, so the box shows it
        key={initial ? `named-${initial.id}` : 'unnamed'}
        ariaLabel="Identity"
        placeholder="Identity: search by name or email"
        value={value}
        initial={initial}
        onChange={onChange}
      />
    </div>
  );
};

const KIND_OPTIONS = SOD_KINDS.map((k) => ({ value: k.key, label: k.label }));

export const EntitlementPicker: React.FC<{
  value?: string;
  onChange: (entitlementId: string | undefined) => void;
}> = ({ value, onChange }) => {
  const [kindKey, setKindKey] = useState<string>();
  const [typed, setTyped] = useState('');
  const kind = SOD_KINDS.find((k) => k.key === kindKey);
  const catalog = useCatalogEntitlements(kind?.system, kind?.catalogType);
  const keyOf = (id: string) => `${kind?.system}::${id}`;
  const options = (catalog.data ?? [])
    .filter((e) => e.nativeId)
    .map((e) => ({ value: keyOf(e.nativeId as string), label: e.name }));
  const listed = options.some((o) => o.value === value);

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space wrap size={8}>
        <Select
          aria-label="Kind of entitlement"
          placeholder="Kind of entitlement"
          options={KIND_OPTIONS}
          value={kindKey}
          onChange={setKindKey}
          style={{ width: 200, maxWidth: '100%' }}
        />
        <Select
          aria-label="Entitlement"
          placeholder={kind ? 'Search the catalog' : 'Choose the kind first'}
          disabled={!kind}
          showSearch
          optionFilterProp="label"
          loading={catalog.isLoading}
          options={options}
          value={listed ? value : undefined}
          onChange={(id: string) => onChange(id)}
          notFoundContent={
            catalog.isLoading ? undefined : 'No entry with an id in this system in the catalog'
          }
          style={{ width: 280, maxWidth: '100%' }}
        />
        <Input.Search
          aria-label="Entitlement id"
          placeholder={kind ? 'or the id in its system' : 'Choose the kind first'}
          disabled={!kind}
          enterButton="Use"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onSearch={(id) => id.trim() && onChange(keyOf(id.trim()))}
          style={{ width: 280, maxWidth: '100%' }}
        />
      </Space>
      {catalog.isError && (
        <Text type="danger" style={{ fontSize: 12 }}>
          Could not load the catalog: {apiErrorMessage(catalog.error, 'the request failed')}
        </Text>
      )}
      {value && !listed && (
        <Space size={8} wrap>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Entitlement id
          </Text>
          <Text code style={{ wordBreak: 'break-all' }}>
            {value}
          </Text>
          <Button size="small" type="link" onClick={() => onChange(undefined)}>
            Clear
          </Button>
        </Space>
      )}
    </Space>
  );
};
