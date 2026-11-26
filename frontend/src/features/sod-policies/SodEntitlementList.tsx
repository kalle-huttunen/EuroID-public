/**
 * A policy's conflicting entitlements, readable: each by its catalog name with the system and
 * kind it is matched on. An entitlement the catalog does not hold keeps its stored id.
 */
import React from 'react';
import { Space, Typography } from 'antd';
import type { SodEntitlementRef } from '../../interfaces';
import { catalogKey, kindLabelOfRef, kindOfRef } from './sod-labels';
import type { EntitlementNames } from './useEntitlementNames';

const { Text } = Typography;

const Entitlement: React.FC<{ entitlement: SodEntitlementRef; lookup: EntitlementNames }> = ({
  entitlement,
  lookup,
}) => {
  const kind = kindOfRef(entitlement);
  const name = kind
    ? lookup.names.get(catalogKey(kind.system, kind.catalogType, entitlement.targetId))
    : undefined;
  const kindLabel = kindLabelOfRef(entitlement);
  const notCataloged = !name && (!kind || lookup.loadedKinds.has(kind.key));
  return (
    <div style={{ minWidth: 0 }}>
      {name ? (
        <Text>{name}</Text>
      ) : (
        <Text code style={{ wordBreak: 'break-all' }}>
          {entitlement.targetId}
        </Text>
      )}
      <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
        {notCataloged ? `${kindLabel}, not in the entitlement catalog` : kindLabel}
      </Text>
    </div>
  );
};

export const SodEntitlementList: React.FC<{
  entitlements: SodEntitlementRef[];
  lookup: EntitlementNames;
}> = ({ entitlements, lookup }) => (
  <Space direction="vertical" size={6} style={{ width: '100%' }}>
    {entitlements.map((e, i) => (
      <Entitlement
        key={`${e.system}:${e.type}:${e.targetId}:${i}`}
        entitlement={e}
        lookup={lookup}
      />
    ))}
  </Space>
);
