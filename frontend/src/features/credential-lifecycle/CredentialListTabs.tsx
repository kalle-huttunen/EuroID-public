/**
 * The operator lists of the credential lifecycle page: credentials due within N days (overdue
 * included, GET /credential-lifecycle/expiring) and the ones the nightly check could not judge,
 * with the reason (GET /credential-lifecycle/inventory?status=UNKNOWN). Also the identity page's
 * Credentials tab (GET /credential-lifecycle/inventory/:identityId).
 */
import React, { useState } from 'react';
import { Segmented, Skeleton, Space, Typography } from 'antd';
import {
  CREDENTIAL_LIST_LIMIT,
  useCredentialsByStatus,
  useDueCredentials,
  useIdentityCredentials,
} from '@api/credential-lifecycle-api';
import { EmptyState } from '@shared/EmptyState';
import { ErrorState } from '@shared/ErrorState';
import type { ICredentialRecord } from '../../interfaces';
import { CredentialTable } from './CredentialTable';
import { WHERE_ENTRIES_COME_FROM } from './credential-labels';

const { Text } = Typography;

/** Due-within choices; 30 is the API's default. */
const DAYS_AHEAD = [7, 30, 90] as const;

interface ListQuery {
  data?: ICredentialRecord[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/** Loading, error, empty or the table, with a note when the list was cut at the limit. */
function listBody(
  query: ListQuery,
  what: string,
  empty: { title: string; description: string },
  table: (rows: ICredentialRecord[]) => React.ReactNode,
): React.ReactNode {
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 5 }} />;
  if (query.isError) {
    return (
      <ErrorState
        title={`Could not load ${what}`}
        error={query.error}
        onRetry={() => query.refetch()}
      />
    );
  }
  const rows = query.data ?? [];
  if (!rows.length) return <EmptyState title={empty.title} description={empty.description} />;
  return (
    <>
      {rows.length >= CREDENTIAL_LIST_LIMIT && (
        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          Showing the first {CREDENTIAL_LIST_LIMIT}.
        </Text>
      )}
      {table(rows)}
    </>
  );
}

export const DueCredentialsTab: React.FC = () => {
  const [daysAhead, setDaysAhead] = useState<number>(30);
  const due = useDueCredentials(daysAhead);
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap>
        <Text>Due within</Text>
        <Segmented<number>
          aria-label="Due within"
          value={daysAhead}
          onChange={setDaysAhead}
          options={DAYS_AHEAD.map((d) => ({ value: d, label: `${d} days` }))}
        />
      </Space>
      {listBody(
        due,
        'the due credentials',
        {
          title: `Nothing is due in the next ${daysAhead} days`,
          description: `${WHERE_ENTRIES_COME_FROM} Accounts it could not check are under Could not be checked.`,
        },
        (rows) => (
          <CredentialTable rows={rows} showIdentity label="Due and overdue credentials" />
        ),
      )}
    </Space>
  );
};

export const UnknownCredentialsTab: React.FC = () => {
  const unknown = useCredentialsByStatus('UNKNOWN');
  return (
    <>
      {listBody(
        unknown,
        'the credentials that could not be checked',
        {
          title: 'No account is waiting on a check',
          description: `${WHERE_ENTRIES_COME_FROM} An account it cannot judge (system not configured, account not readable, no policy) is listed here with the reason.`,
        },
        (rows) => (
          <CredentialTable
            rows={rows}
            showIdentity
            showReason
            label="Credentials that could not be checked"
          />
        ),
      )}
    </>
  );
};

/** The identity page's Credentials tab (operator, like GET /inventory/:identityId). */
export const IdentityCredentialsTab: React.FC<{ identityId: string }> = ({ identityId }) => {
  const credentials = useIdentityCredentials(identityId);
  return (
    <>
      {listBody(
        credentials,
        'this identity’s credentials',
        {
          title: 'No credentials recorded for this identity',
          description: `${WHERE_ENTRIES_COME_FROM} Its accounts appear here after the first nightly check once they are provisioned.`,
        },
        (rows) => (
          <CredentialTable rows={rows} showMfa showReason label="Credentials of this identity" />
        ),
      )}
    </>
  );
};
