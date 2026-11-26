/**
 * Every registered target connector has an offboarding path: one that can deprovision
 * ('deprovision' capability) gets a deprovision call, one that keeps no account is reported
 * "not applicable". A new target fails here until offboarding handles it.
 */
import type { ConnectorManifest } from '../modules/connectors/plugin/connector-manifest.interface';
import type { PluginRegistryService } from '../modules/connectors/plugin/plugin-registry.service';
import { registerBuiltInConnectors } from '../modules/connectors/plugin/register-connectors';
import { offboardingTargetKind } from './offboarding-targets';

const manifests: ConnectorManifest[] = [];
registerBuiltInConnectors({
  register: (m: ConnectorManifest) => manifests.push(m),
} as unknown as PluginRegistryService);
const targets = manifests.filter((m) => !m.capabilities.includes('ingest'));

describe('offboardingTargetKind', () => {
  it('covers the registered targets', () => {
    expect(targets.map((m) => m.id).sort()).toEqual([
      'ad',
      'discord-webhook',
      'entra-id',
      'file-outbound',
      'github',
      'google-sheets',
      'okta',
      'scim',
      'servicenow',
    ]);
  });

  it.each(targets.map((m) => [m.id, m] as const))('%s', (_id, manifest) => {
    const kind = offboardingTargetKind(manifest.id);
    if (manifest.capabilities.includes('deprovision')) {
      expect(['not-applicable', 'unknown']).not.toContain(kind);
    } else {
      expect(kind).toBe('not-applicable');
    }
  });

  it('reads the names provisioning stores (canvas types without -id/-target)', () => {
    expect(offboardingTargetKind('entra')).toBe('entra');
    expect(offboardingTargetKind('active-directory')).toBe('ad');
    expect(offboardingTargetKind('Okta')).toBe('okta');
    expect(offboardingTargetKind('salesforce')).toBe('unknown');
  });
});
