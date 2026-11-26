/**
 * Picks the person who owns an agent: GET /identity searched by every word of the name or work
 * email as the user types (debounced, viewer). Offboarded people are never offered. With
 * `requireActive` (create and delegate) a person whose status is not ACTIVE is listed but
 * disabled, since the API refuses such an owner. Works as a Form control (value: identity `_id`).
 */
import React, { useEffect, useState } from 'react';
import { Select, Typography } from 'antd';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { identityKeys, searchIdentities, type IdentityOption } from '@api/identity-api';
import { IDENTITY_PICKER_LIMIT } from '@config/pagination';
import { POLL_INTERVALS } from '@config/polling';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { identityLabel } from '../compliance/gdpr-labels';
import { ownerProblem } from './nhi-labels';

const { Text } = Typography;

export const OwnerPicker: React.FC<{
  /** Set by Form.Item, so its label names the box. */
  id?: string;
  value?: string;
  onChange?: (identityId: string | undefined) => void;
  /** The option for a value set before any search (the parent's owner, a filtered owner). */
  initial?: IdentityOption;
  requireActive?: boolean;
  ariaLabel: string;
  placeholder?: string;
  style?: React.CSSProperties;
}> = ({ id, value, onChange, initial, requireActive, ariaLabel, placeholder, style }) => {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<IdentityOption | undefined>(initial);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(input.trim()), POLL_INTERVALS.SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  const identities = useQuery({
    queryKey: identityKeys.search(search, false),
    queryFn: () =>
      searchIdentities({ search, includeDeleted: false, limit: IDENTITY_PICKER_LIMIT }),
    placeholderData: keepPreviousData,
  });
  const found = identities.data?.options ?? [];
  // The picked person stays offered after a new search leaves them out.
  const current = picked?.id === value ? picked : undefined;
  const options = current && !found.some((o) => o.id === current.id) ? [current, ...found] : found;
  const total = identities.data?.total ?? 0;

  return (
    <>
      <Select
        id={id}
        showSearch
        allowClear
        aria-label={ariaLabel}
        placeholder={placeholder ?? 'Search by name or email'}
        filterOption={false}
        onSearch={setInput}
        loading={identities.isFetching}
        value={value}
        onChange={(id?: string) => {
          setPicked(options.find((o) => o.id === id));
          onChange?.(id);
        }}
        options={options.map((o) => {
          const problem = requireActive ? ownerProblem(o) : undefined;
          return {
            value: o.id,
            label: problem ? `${identityLabel(o)}, ${problem}` : identityLabel(o),
            disabled: !!problem,
          };
        })}
        notFoundContent={identities.isFetching ? 'Searching…' : 'No person matches'}
        style={{ width: '100%', ...style }}
      />
      {identities.isError && (
        <Text type="danger" style={{ display: 'block', fontSize: 12 }}>
          Search failed: {apiErrorMessage(identities.error, 'the request failed')}
        </Text>
      )}
      {total > found.length && (
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          Showing the first {found.length} of {total} matches: type more to narrow them.
        </Text>
      )}
    </>
  );
};
