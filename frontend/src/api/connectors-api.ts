/**
 * Connector catalog and checks.
 *
 * GET /connectors/available lists every registered connector's manifest (capabilities, config
 * schema): the Marketplace shows it, and Test Connection reads a connector's `healthCheck`
 * capability from it, both under one query key. POST /connectors/:name/health-check with no
 * config checks the connector's saved settings.
 */
import { useQuery } from '@tanstack/react-query';
import { axiosInstance } from './data';
import { API_BASE } from './constants';
import type { AvailableConnector } from '@features/connectors/connector-api.types';

export const connectorKeys = {
  available: () => ['connectors', 'available'] as const,
};

export async function fetchAvailableConnectors(): Promise<AvailableConnector[]> {
  const { data } = await axiosInstance.get<AvailableConnector[]>(
    `${API_BASE}/connectors/available`,
  );
  return Array.isArray(data) ? data : [];
}

export function useAvailableConnectors() {
  return useQuery({ queryKey: connectorKeys.available(), queryFn: fetchAvailableConnectors });
}

/**
 * What the health check answers. Each connector fills it its own way: `healthy` (SCIM, the HR
 * sources, the others), `connected` (AD, Entra ID), `message` on success or to say the saved
 * settings were used, `error` on failure.
 */
export interface ConnectorHealthResult {
  healthy?: boolean;
  connected?: boolean;
  message?: string;
  error?: string;
}

/** Check the connector's saved settings (no config in the body). */
export async function checkConnectorHealth(connectorId: string): Promise<ConnectorHealthResult> {
  const { data } = await axiosInstance.post<ConnectorHealthResult>(
    `${API_BASE}/connectors/${encodeURIComponent(connectorId)}/health-check`,
    {},
  );
  return data ?? {};
}
