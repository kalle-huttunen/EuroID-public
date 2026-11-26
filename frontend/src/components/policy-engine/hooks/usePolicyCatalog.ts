/**
 * usePolicyCatalog — Fetches groups, roles, and resolved bundle actions
 */

import { useState, useEffect, useCallback } from 'react';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type { CatalogGroup, CatalogRole } from '../../../interfaces';
import type { PolicyAction } from '../types';

const CATALOG_API = `${API_BASE}/entitlement-catalog`;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY_SYSTEMS = ['entra-id', 'ad'] as const;

export function usePolicyCatalog(roleBundleId?: string) {
  const [catalogGroups, setCatalogGroups] = useState<CatalogGroup[]>([]);
  const [catalogRoles, setCatalogRoles] = useState<CatalogRole[]>([]);
  const [resolvedBundleActions, setResolvedBundleActions] = useState<PolicyAction[]>([]);

  const fetchCatalog = useCallback(() => {
    Promise.all(
      IDENTITY_SYSTEMS.map((system) =>
        axiosInstance
          .get(CATALOG_API, { params: { system, type: 'Group' } })
          .then(({ data }) => ({
            system,
            groups: (data.entitlements ?? []).map((e: { name: string; nativeId?: string }) => ({
              name: e.name,
              nativeId: e.nativeId ?? e.name,
              system,
            })),
          }))
          .catch(() => ({ system, groups: [] })),
      ),
    ).then((results) => {
      const allGroups = results.flatMap((r) => r.groups);
      const byKey = new Map<string, CatalogGroup>();
      for (const g of allGroups) {
        const key = `${g.system}:${g.nativeId}`;
        const existing = byKey.get(key);
        const gNameIsGuid = UUID_REGEX.test(g.name);
        if (!existing) {
          byKey.set(key, g);
          continue;
        }
        const existingNameIsGuid = UUID_REGEX.test(existing.name);
        if (gNameIsGuid && !existingNameIsGuid) continue;
        if (!gNameIsGuid && existingNameIsGuid) byKey.set(key, g);
      }
      setCatalogGroups(Array.from(byKey.values()));
    });
  }, []);

  const fetchCatalogRoles = useCallback(() => {
    axiosInstance
      .get(CATALOG_API, { params: { system: 'entra-id', type: 'DirectoryRole' } })
      .then(({ data }) => {
        const roles = (data.entitlements ?? []).map(
          (e: { name: string; nativeId?: string; adminTier?: string }) => ({
            name: e.name,
            nativeId: e.nativeId ?? e.name,
            system: 'entra-id',
            adminTier: e.adminTier,
          }),
        );
        setCatalogRoles(roles);
      })
      .catch(() => setCatalogRoles([]));
  }, []);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  useEffect(() => {
    fetchCatalogRoles();
  }, [fetchCatalogRoles]);

  useEffect(() => {
    let cancelled = false;
    if (roleBundleId) {
      axiosInstance
        .get<{ actions: PolicyAction[] }>(`${API_BASE}/role-bundles/${roleBundleId}/resolved`)
        .then(({ data }) => {
          if (!cancelled) setResolvedBundleActions(data.actions ?? []);
        })
        .catch(() => {
          if (!cancelled) setResolvedBundleActions([]);
        });
    } else {
      Promise.resolve().then(() => {
        if (!cancelled) setResolvedBundleActions([]);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [roleBundleId]);

  return {
    catalogGroups,
    catalogRoles,
    resolvedBundleActions,
    fetchCatalog,
    fetchCatalogRoles,
  };
}
