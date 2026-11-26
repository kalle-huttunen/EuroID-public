/**
 * The GDPR page's person picker: GET /identity searched by every word of the name or work email
 * as the operator types (debounced), offboarded people included for operator and above
 * (includeDeleted, the usual erasure case) and marked as such. It offers the first
 * IDENTITY_PICKER_LIMIT matches and says when typing more would narrow them.
 */
import React, { useEffect, useState } from 'react';
import { Select, Space, Tag, Typography } from 'antd';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { identityKeys, searchIdentities, type IdentityOption } from '@api/identity-api';
import { IDENTITY_PICKER_LIMIT } from '@config/pagination';
import { POLL_INTERVALS } from '@config/polling';
import { ErrorState } from '@shared/ErrorState';
import { usePermission } from '../../auth/usePermission';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { pickerLabel } from './gdpr-labels';

const { Text } = Typography;

export const GdprPersonPicker: React.FC<{
  selected?: IdentityOption;
  onSelect: (identity: IdentityOption | undefined) => void;
}> = ({ selected, onSelect }) => {
  // GET /identity?includeDeleted=true is refused below operator.
  const includeDeleted = usePermission('operator');
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(input.trim()), POLL_INTERVALS.SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  const identities = useQuery({
    queryKey: identityKeys.search(search, includeDeleted),
    queryFn: () => searchIdentities({ search, includeDeleted, limit: IDENTITY_PICKER_LIMIT }),
    placeholderData: keepPreviousData,
  });
  const found = identities.data?.options ?? [];
  // The picked person stays offered after a new search (or an erasure) leaves them out.
  const options =
    selected && !found.some((o) => o.id === selected.id) ? [selected, ...found] : found;
  const total = identities.data?.total ?? 0;

  if (identities.isError && !identities.data) {
    return (
      <ErrorState
        compact
        title="Could not load the identity list"
        error={identities.error}
        onRetry={() => identities.refetch()}
      />
    );
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Select
        showSearch
        allowClear
        aria-label="Person"
        placeholder="Search by name or email"
        filterOption={false}
        onSearch={setInput}
        loading={identities.isFetching}
        value={selected?.id}
        onChange={(id?: string) => onSelect(options.find((o) => o.id === id))}
        options={options.map((o) => ({ value: o.id, label: pickerLabel(o) }))}
        notFoundContent={identities.isFetching ? 'Searching…' : 'No person matches'}
        style={{ width: '100%', maxWidth: 560 }}
      />
      {selected && (
        <Space size={8} wrap>
          <Text type="secondary">
            Identity id{' '}
            <Text code copyable>
              {selected.id}
            </Text>
          </Text>
          {selected.offboarded && <Tag color="default">Offboarded</Tag>}
        </Space>
      )}
      {identities.isError && (
        <Text type="danger">
          Search failed: {apiErrorMessage(identities.error, 'the request failed')}
        </Text>
      )}
      <Text type="secondary" style={{ fontSize: 12 }}>
        {includeDeleted
          ? 'Offboarded people are included and marked as such.'
          : 'Offboarded people are listed for operators and above only.'}
        {total > found.length &&
          ` Showing the first ${found.length} of ${total} matches: type more of the name or email to narrow them.`}
      </Text>
    </Space>
  );
};
