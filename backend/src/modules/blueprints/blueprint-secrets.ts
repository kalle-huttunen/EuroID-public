/**
 * Connector secrets in Design studio configs never leave the server. Every blueprint response
 * masks them (SECRET_PLACEHOLDER), and a save that sends the mask back keeps the stored value
 * (restoreMaskedSecrets). The UI needs no secret value: forms show the mask and send it back.
 *
 * A secret is a key the node's connector manifest declares `type: 'password'` (the connector is
 * the node's `data.type`, the update's `nodeType`, or the connectorConfigs key). A config that
 * names no registered connector (the Entra node of a canvas saved from the default canvas before
 * plan 2.0da has no `data.type`) has its
 * keys judged by declaration in any registered manifest, or by a credential-like name.
 */

import {
  hasMaskedSecret,
  isSecretByName,
  maskSecrets,
  restoreMaskedSecrets,
} from '@infrastructure/secrets/config-secret-mask';
import type { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';

export type SecretPredicate = (key: string) => boolean;

/** A canvas node as far as its config is concerned. */
interface ConfigNode {
  id: string;
  data?: { type?: unknown; config?: unknown; [key: string]: unknown };
}

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Which config keys are secret for the connector a node or config entry names. */
export function secretPredicateFor(
  registry: PluginRegistryService,
  connectorId: unknown,
): SecretPredicate {
  const declared =
    typeof connectorId === 'string' ? registry.getSecretConfigKeys(connectorId) : undefined;
  if (declared) return (key) => declared.has(key);
  let anyDeclared: ReadonlySet<string> | undefined;
  return (key) => {
    anyDeclared ??= registry.getAllSecretConfigKeys();
    return anyDeclared.has(key) || isSecretByName(key);
  };
}

/** Nodes with the secrets of their configs masked. */
export function maskNodeSecrets<N extends ConfigNode>(
  nodes: N[],
  registry: PluginRegistryService,
): N[] {
  return nodes.map((node) => {
    const config = node.data?.config;
    if (!isPlainObject(config)) return node;
    const masked = maskSecrets(config, secretPredicateFor(registry, node.data?.type));
    return { ...node, data: { ...node.data, config: masked } };
  });
}

/** connectorConfigs with the secrets of every object entry masked (by the connector its key names). */
export function maskConnectorConfigSecrets(
  configs: Record<string, unknown>,
  registry: PluginRegistryService,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [connectorId, value] of Object.entries(configs)) {
    out[connectorId] = isPlainObject(value)
      ? maskSecrets(value, secretPredicateFor(registry, connectorId))
      : value;
  }
  return out;
}

/**
 * Configs to store for nodes a client saves: a masked secret takes the stored value of the same
 * node (by id), an emptied one is removed (see restoreMaskedSecrets). `storedConfigOf` is called
 * only for a node that still holds a mask.
 */
export function restoreNodeSecrets<N extends ConfigNode>(
  nodes: N[],
  storedConfigOf: (nodeId: string) => Record<string, unknown> | undefined,
  registry: PluginRegistryService,
): N[] {
  return nodes.map((node) => {
    const config = node.data?.config;
    if (!isPlainObject(config)) return node;
    const isSecret = secretPredicateFor(registry, node.data?.type);
    const stored = hasMaskedSecret(config, isSecret) ? storedConfigOf(node.id) : undefined;
    return {
      ...node,
      data: { ...node.data, config: restoreMaskedSecrets(config, stored, isSecret) },
    };
  });
}

/** connectorConfigs to store: the same rule as restoreNodeSecrets, by connectorConfigs key. */
export function restoreConnectorConfigSecrets(
  configs: Record<string, unknown>,
  storedConfigOf: (connectorId: string) => Record<string, unknown> | undefined,
  registry: PluginRegistryService,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [connectorId, value] of Object.entries(configs)) {
    if (!isPlainObject(value)) {
      out[connectorId] = value;
      continue;
    }
    const isSecret = secretPredicateFor(registry, connectorId);
    const stored = hasMaskedSecret(value, isSecret) ? storedConfigOf(connectorId) : undefined;
    out[connectorId] = restoreMaskedSecrets(value, stored, isSecret);
  }
  return out;
}
