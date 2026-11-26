/**
 * useCanvasSimulation — Test users (identity list) and simulation modal visibility.
 * Extracted from BlueprintCanvas for separation of concerns.
 */
import { useMemo, useState } from 'react';
import { useList, useInvalidate } from '@api/resource-hooks';
import type { IStandardUser } from '../../../interfaces';
import { withoutPiiFields } from '../../../utils/pii-fields';

/** Stable empty list, so memoized consumers do not recompute while the list loads. */
const NO_USERS: IStandardUser[] = [];

export function useCanvasSimulation() {
  const [simulationVisible, setSimulationVisible] = useState(false);
  const { data: userData } = useList<IStandardUser>({ resource: 'identity' });
  const invalidate = useInvalidate();
  // The list carries PII masked; impact analysis validates and diffs what it is sent, so the
  // masked values are left out rather than echoed back.
  const listed = userData?.data as IStandardUser[] | undefined;
  const testUsers: IStandardUser[] = useMemo(
    () => (listed ? listed.map(withoutPiiFields) : NO_USERS),
    [listed],
  );
  /** Hub total (X-Total-Count); larger than testUsers.length when the list is capped. */
  const totalUsers = userData?.total;

  const handleSyncComplete = () => invalidate({ resource: 'identity', invalidates: ['list'] });

  return {
    simulationVisible,
    setSimulationVisible,
    testUsers,
    totalUsers,
    handleSyncComplete,
  };
}
