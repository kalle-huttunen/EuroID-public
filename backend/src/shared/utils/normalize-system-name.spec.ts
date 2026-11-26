/**
 * Unit tests for normalizeSystemName and getSystemType utilities.
 */
import {
  normalizeSystemName,
  getSystemType,
  catalogSystemName,
  systemKey,
} from './normalize-system-name';

describe('normalizeSystemName', () => {
  it('should lowercase and strip hyphens', () => {
    expect(normalizeSystemName('entra-id')).toBe('entraid');
    expect(normalizeSystemName('Entra-ID')).toBe('entraid');
    expect(normalizeSystemName('ENTRA')).toBe('entra');
    expect(normalizeSystemName('entraid')).toBe('entraid');
    expect(normalizeSystemName('ad')).toBe('ad');
    expect(normalizeSystemName('Active-Directory')).toBe('activedirectory');
    expect(normalizeSystemName('activedirectory')).toBe('activedirectory');
    expect(normalizeSystemName('slack')).toBe('slack');
    expect(normalizeSystemName('scim-connector')).toBe('scimconnector');
  });

  it('should handle null and undefined', () => {
    expect(normalizeSystemName(null)).toBe('');
    expect(normalizeSystemName(undefined)).toBe('');
  });

  it('should handle empty string', () => {
    expect(normalizeSystemName('')).toBe('');
  });
});

describe('getSystemType', () => {
  it('should map entra variants to entra', () => {
    expect(getSystemType('entra-id')).toBe('entra');
    expect(getSystemType('Entra-ID')).toBe('entra');
    expect(getSystemType('ENTRA')).toBe('entra');
    expect(getSystemType('entraid')).toBe('entra');
  });

  it('should map ad variants to ad', () => {
    expect(getSystemType('ad')).toBe('ad');
    expect(getSystemType('Active-Directory')).toBe('ad');
    expect(getSystemType('activedirectory')).toBe('ad');
  });

  it('should map unknown systems to unknown', () => {
    expect(getSystemType('slack')).toBe('unknown');
    expect(getSystemType('scim-connector')).toBe('unknown');
    expect(getSystemType('scim')).toBe('unknown');
    expect(getSystemType('')).toBe('unknown');
  });

  it('should handle null and undefined', () => {
    expect(getSystemType(null)).toBe('unknown');
    expect(getSystemType(undefined)).toBe('unknown');
  });
});

describe('catalogSystemName', () => {
  it('names Entra ID and AD as the policy engine and the catalog do', () => {
    expect(catalogSystemName('entra')).toBe('entra-id');
    expect(catalogSystemName('Entra-ID')).toBe('entra-id');
    expect(catalogSystemName('active-directory')).toBe('ad');
    expect(catalogSystemName('AD')).toBe('ad');
  });

  it('keeps any other name as given', () => {
    expect(catalogSystemName('GitHub')).toBe('GitHub');
    expect(catalogSystemName('all')).toBe('all');
    expect(catalogSystemName(undefined)).toBe('');
  });
});

describe('systemKey', () => {
  it('gives one key to every name of one system', () => {
    expect(systemKey('entra')).toBe(systemKey('entra-id'));
    expect(systemKey('ad')).toBe(systemKey('Active-Directory'));
    expect(systemKey('GitHub')).toBe(systemKey('github'));
    expect(systemKey('file-outbound')).toBe(systemKey('File-Outbound'));
  });

  it('keeps different systems apart', () => {
    expect(systemKey('entra-id')).not.toBe(systemKey('ad'));
    expect(systemKey('github')).not.toBe(systemKey('gitlab'));
  });
});
