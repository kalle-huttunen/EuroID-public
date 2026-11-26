/**
 * The access graph's key of an entitlement: `<system>::<native id>`, the system as the
 * entitlement catalog names it (catalogSystemName: `entra-id`, `ad`, any other as given). The
 * catalog is unique on (tenant, system, native id), and a native id alone ("admin", a numeric
 * group id) can name entitlements in two systems, which one node keyed by it merged: holders of
 * both, a path to the wrong system, SoD conflicts across systems. GraphResyncService,
 * GraphSyncService and AccessExplorerService key :Entitlement nodes with it; the node keeps
 * `nativeId` and `system` as properties.
 */
import { z } from 'zod';
import { catalogSystemName } from '@shared/utils/normalize-system-name';

export const entitlementNodeId = (system: string, nativeId: string): string =>
  `${catalogSystemName(system)}::${nativeId}`;

/** An entitlement id the access explorer API takes: a graph key, never a bare native id. */
export const EntitlementNodeIdSchema = z
  .string()
  .max(400)
  .regex(
    /^[^:]+::.+$/,
    'must be <system>::<id in that system>, as the graph answers it, e.g. entra-id::<group object id>',
  );
