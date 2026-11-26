/**
 * LicenseSkuSelect: the Entra ID licenses connector discovery put in the entitlement catalog.
 * The value is the catalog entry's nativeId, the license's Entra ID skuPartNumber: the Entra
 * connector assigns a license by it and SoD policies name it, so a policy, a role bundle and an
 * SoD policy on the same license match. A stored value the catalog does not hold (older
 * policies offered fixed names such as O365_E3) stays visible as such.
 */
import React from 'react';
import { Select } from 'antd';
import { useCatalogEntitlements } from '@api/entitlement-catalog-api';

export const LicenseSkuSelect: React.FC<{
  value?: string;
  onChange: (sku: string) => void;
  minWidth?: number;
}> = ({ value, onChange, minWidth = 160 }) => {
  const { data: licenses = [], isLoading } = useCatalogEntitlements('entra-id', 'License');
  const options = licenses
    .filter((l) => l.nativeId)
    .map((l) => ({ value: l.nativeId as string, label: l.name }));
  if (value && !options.some((o) => o.value === value)) {
    options.unshift({ value, label: `${value} (not in the entitlement catalog)` });
  }
  return (
    <Select
      aria-label="License SKU"
      value={value || undefined}
      onChange={onChange}
      placeholder="Select license..."
      size="small"
      style={{ minWidth }}
      loading={isLoading}
      options={options}
      showSearch
      optionFilterProp="label"
      notFoundContent="No licenses in the catalog: run Entra ID discovery"
    />
  );
};
