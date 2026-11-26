import { isDeepStrictEqual } from 'util';

/** A canvas node as far as its connector settings are concerned. */
interface SettingsNode {
  id: string;
  data?: { type?: unknown; config?: unknown; [key: string]: unknown };
}

/** A canvas's connector settings, plaintext (secrets decrypted or restored). */
export interface CanvasSettings {
  nodes: SettingsNode[];
  connectorConfigs: Record<string, unknown>;
}

/** As stored: MongoDB keeps no undefined field. */
const asStored = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const differs = (a: unknown, b: unknown) => !isDeepStrictEqual(asStored(a), asStored(b));

/**
 * The connectors whose settings a canvas save changes, for its audit entry (the ISO 27001 report
 * counts such a save as a connector configuration change): a node whose `data.config` differs
 * from the stored node's of the same id (a node added or removed with settings too), named by its
 * connector (`data.type`, else the node id), and a `connectorConfigs` entry of a registered
 * connector that differs from the stored one. The Brain's `euroid-core` entry names no connector.
 */
export function changedConnectorSettings(
  before: CanvasSettings,
  after: CanvasSettings,
  isConnector: (id: string) => boolean,
): string[] {
  const changed = new Set<string>();
  const byId = (nodes: SettingsNode[]) => new Map(nodes.map((n) => [n.id, n]));
  const was = byId(before.nodes);
  const is = byId(after.nodes);
  for (const id of new Set([...was.keys(), ...is.keys()])) {
    const node = is.get(id) ?? was.get(id);
    const old = was.get(id)?.data?.config;
    const now = is.get(id)?.data?.config;
    if ((old != null || now != null) && differs(old, now)) {
      changed.add(typeof node?.data?.type === 'string' ? node.data.type : id);
    }
  }
  const keys = new Set([
    ...Object.keys(before.connectorConfigs),
    ...Object.keys(after.connectorConfigs),
  ]);
  for (const key of keys) {
    if (!isConnector(key)) continue;
    if (differs(before.connectorConfigs[key], after.connectorConfigs[key])) {
      changed.add(key);
    }
  }
  return [...changed].sort();
}
