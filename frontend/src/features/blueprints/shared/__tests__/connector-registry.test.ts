import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  CONNECTOR_REGISTRY,
  POLICY_ACTION_TARGETS,
  getConnectorById,
  getConnectorByName,
  parseConnectorNameFromNodeId,
} from '../connector-registry';
import { ConnectorConfigs } from '../../connectors';
import { initialNodes } from '../../canvas/nodes';
import { buildNewConnector } from '../../canvas/handlers';

// The connectors the backend registers (register-connectors.ts) with their capabilities and
// config fields, pinned by backend/src/modules/connectors/plugin/connector-manifests-fixture.spec.ts.
// The UI must not offer a connector that has no backend: it can never provision anything.
interface BackendConnector {
  id: string;
  capabilities: string[];
  configSchema: Array<{ key: string; type: string; required: boolean }>;
}
const BACKEND: { connectors: BackendConnector[] } = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../../../backend/test/fixtures/connector-manifests.json'),
    'utf8',
  ),
);
const BACKEND_CONNECTOR_IDS = BACKEND.connectors.map((c) => c.id);

// Sources feed the hub (the backend's 'ingest' capability); everything else is a provisioning target.
const BACKEND_SOURCE_IDS = BACKEND.connectors
  .filter((c) => c.capabilities.includes('ingest'))
  .map((c) => c.id);

// Entra ID and Active Directory have settings forms of their own (connectors/entra.connector.tsx,
// connectors/ad.connector.tsx); every other target's Design studio form is its registry configSchema.
const OWN_FORM_IDS = ['entra-id', 'ad'];
const BACKEND_CONFIG_KEYS = Object.fromEntries(
  BACKEND.connectors
    .filter((c) => !BACKEND_SOURCE_IDS.includes(c.id) && !OWN_FORM_IDS.includes(c.id))
    .map((c) => [
      c.id,
      {
        keys: c.configSchema.map((f) => f.key),
        required: c.configSchema.filter((f) => f.required).map((f) => f.key),
        secrets: c.configSchema.filter((f) => f.type === 'password').map((f) => f.key),
      },
    ]),
);

describe('connector registry', () => {
  it('offers every connector the backend registers, so each can be added in the Design studio', () => {
    expect(CONNECTOR_REGISTRY.map((c) => c.id).sort()).toEqual([...BACKEND_CONNECTOR_IDS].sort());
    for (const c of CONNECTOR_REGISTRY) {
      expect(c.hasBackend, c.name).toBe(true);
    }
  });

  it('places HR connectors on the source side and the rest on the target side', () => {
    for (const c of CONNECTOR_REGISTRY) {
      expect(c.direction, c.name).toBe(BACKEND_SOURCE_IDS.includes(c.id!) ? 'source' : 'target');
    }
  });

  it.each(Object.entries(BACKEND_CONFIG_KEYS))(
    'asks for exactly the %s backend config, secrets masked',
    (id, expected) => {
      const schema = getConnectorById(id)!.configSchema;
      expect(schema.map((f) => f.key)).toEqual(expected.keys);
      expect(schema.filter((f) => f.required).map((f) => f.key)).toEqual(expected.required);
      expect(schema.filter((f) => f.type === 'password').map((f) => f.key)).toEqual(
        expected.secrets,
      );
    },
  );

  it('resolves the node "Add connector" creates back to the same connector', () => {
    for (const c of CONNECTOR_REGISTRY) {
      const { node } = buildNewConnector(c.name, c.direction, c.icon, []);
      expect(parseConnectorNameFromNodeId(node.id), node.id).toBe(c.name);
    }
  });

  it('gives every target its own settings form instead of the generic endpoint form', () => {
    for (const c of CONNECTOR_REGISTRY.filter((m) => m.direction === 'target')) {
      expect(ConnectorConfigs[c.name], c.name).toBeDefined();
    }
  });

  it('has a simulation config only for registered target connectors', () => {
    for (const name of Object.keys(ConnectorConfigs)) {
      expect(getConnectorByName(name)?.hasBackend, name).toBe(true);
    }
  });

  it('lets policy actions target only the registered target connectors, or all systems', () => {
    const targetIds = BACKEND_CONNECTOR_IDS.filter((id) => !BACKEND_SOURCE_IDS.includes(id));

    expect(POLICY_ACTION_TARGETS.map((t) => t.value).sort()).toEqual([...targetIds, 'all'].sort());
    expect(POLICY_ACTION_TARGETS.find((t) => t.value === 'ad')?.label).toBe('Active Directory');
    for (const c of CONNECTOR_REGISTRY.filter((m) => m.policyActions?.length)) {
      expect(c.direction, c.name).toBe('target');
    }
  });

  it('builds the default canvas only from registered connectors', () => {
    const connectorNodes = initialNodes.filter((n) => n.data.role !== 'brain');
    expect(connectorNodes.length).toBeGreaterThan(0);
    for (const node of connectorNodes) {
      const name = parseConnectorNameFromNodeId(node.id);
      expect(getConnectorByName(name)?.hasBackend, node.id).toBe(true);
    }
  });

  // Onboarding finds its targets by data.type (getActiveTargetSystems): a default node without
  // it, like the Entra ID node before 2.0da, is drawn on the canvas and provisioned nowhere.
  it('gives every default connector node its backend connector id as data.type', () => {
    const connectorNodes = initialNodes.filter((n) => n.data.role !== 'brain');
    for (const node of connectorNodes) {
      const connector = getConnectorByName(parseConnectorNameFromNodeId(node.id));
      expect(node.data.type, node.id).toBe(connector?.id);
      expect(BACKEND_CONNECTOR_IDS, node.id).toContain(node.data.type);
    }
    expect(initialNodes.find((n) => n.id === 'entra-target')?.data.type).toBe('entra-id');
  });
});
