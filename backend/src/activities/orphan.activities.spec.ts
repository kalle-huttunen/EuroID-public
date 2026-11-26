import { OrphanActivities } from './orphan.activities';
import type { EntraActivities } from './entra.activities';
import type { DriftService } from '../modules/reconciliation/drift.service';
import type { IdentityService } from '../modules/identity/identity.service';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import type { OrphanDetectionService } from '../modules/reconciliation/orphan-detection.service';
import type { AdService } from '../modules/connectors/ad-connector/ad.service';
import type { SCIMService } from '../modules/connectors/scim-connector/scim.service';
import type { ConnectorConfigService } from '../modules/connectors/connector-config.service';

describe('OrphanActivities.emitOrphanDetected (orphan cleanup workflow)', () => {
  const emit = jest.fn();
  const activities = new OrphanActivities(
    {} as EntraActivities,
    {} as DriftService,
    {} as IdentityService,
    { emit } as unknown as DomainEventEmitterService,
    {} as OrphanDetectionService,
    {} as AdService,
    {} as SCIMService,
    {} as ConnectorConfigService,
  );

  beforeEach(() => emit.mockClear());

  // The workflow passes the drift's userEmail as the account identifier
  it.each([
    ['an Entra ID account by its object id', 'entra-obj-1', 'entra-obj-1'],
    [
      'an AD account (DN id) by its masked UPN',
      'CN=Ada Lovelace,OU=Users,DC=corp',
      'a•••@corp.example',
    ],
  ])('names %s, never the address', async (_label, externalId, expected) => {
    await activities.emitOrphanDetected(
      'drift-1',
      'entra-id',
      externalId,
      'ada.lovelace@corp.example',
      'tenant-a',
    );

    const [type, aggregateId, payload] = emit.mock.calls[0];
    expect(type).toBe(DomainEventType.ORPHAN_DETECTED);
    expect(aggregateId).toBe(externalId);
    expect(payload).toEqual({
      driftId: 'drift-1',
      targetSystem: 'entra-id',
      externalId,
      accountIdentifier: expected,
      tenantId: 'tenant-a',
    });
    expect(EVENT_SCHEMAS[DomainEventType.ORPHAN_DETECTED]!.parse(payload)).toEqual(payload);
    expect(JSON.stringify(payload)).not.toContain('ada.lovelace@corp.example');
  });
});

/**
 * The orphan cleanup asks before it disables or deletes (patch orphan-cleanup:recheck-before-
 * acting): after a 30-day grace the account may belong to an identity created since, and
 * detection never closed the drift (hunt r2-05 N4).
 */
describe('OrphanActivities.confirmOrphan', () => {
  const drift = {
    _id: 'drift-1',
    type: 'ORPHAN_ACCOUNT',
    status: 'quarantined',
    userId: 'obj-1',
    userEmail: 'ada@corp.example',
    orphanDetails: { externalId: 'obj-1' },
  };
  const driftService = {
    getDriftById: jest.fn(),
    closeOrphanDrift: jest.fn().mockResolvedValue(undefined),
  };
  const orphanDetection = { isStillOrphan: jest.fn() };
  const activities = new OrphanActivities(
    {} as EntraActivities,
    driftService as unknown as DriftService,
    {} as IdentityService,
    { emit: jest.fn() } as unknown as DomainEventEmitterService,
    orphanDetection as unknown as OrphanDetectionService,
    {} as AdService,
    {} as SCIMService,
    {} as ConnectorConfigService,
  );

  beforeEach(() => {
    driftService.getDriftById.mockReset().mockResolvedValue(drift);
    driftService.closeOrphanDrift.mockClear();
    orphanDetection.isStillOrphan.mockReset();
  });

  it('lets the cleanup act on an account that is still an orphan', async () => {
    orphanDetection.isStillOrphan.mockResolvedValue(true);

    const check = await activities.confirmOrphan('drift-1', 'Ada@corp.example', 'tenant-a');

    expect(check).toEqual({ orphan: true });
    expect(orphanDetection.isStillOrphan).toHaveBeenCalledWith({
      id: 'obj-1',
      objectGuid: 'obj-1',
      userPrincipalName: 'Ada@corp.example',
      mail: 'ada@corp.example',
    });
    expect(driftService.closeOrphanDrift).not.toHaveBeenCalled();
  });

  it('closes the drift of an account an identity has now, and stops the cleanup', async () => {
    orphanDetection.isStillOrphan.mockResolvedValue(false);

    const check = await activities.confirmOrphan('drift-1', 'ada@corp.example', 'tenant-a');

    expect(check.orphan).toBe(false);
    expect(driftService.closeOrphanDrift).toHaveBeenCalledWith('drift-1', 'no_longer_orphan');
  });

  it.each(['ignored', 'corrected'])('stops the cleanup of a drift already %s', async (status) => {
    driftService.getDriftById.mockResolvedValue({ ...drift, status });

    const check = await activities.confirmOrphan('drift-1', 'ada@corp.example', 'tenant-a');

    expect(check).toEqual({ orphan: false, reason: `its drift is ${status}` });
    expect(orphanDetection.isStillOrphan).not.toHaveBeenCalled();
    expect(driftService.closeOrphanDrift).not.toHaveBeenCalled();
  });
});

/** The cleanup disabled only Entra ID accounts and stamped disabledAt for the others (05 F9). */
describe('OrphanActivities.disableOrphanAccount', () => {
  const adService = { getUserByEmail: jest.fn(), setUserEnabled: jest.fn() };
  const scimService = { setActive: jest.fn() };
  const connectorConfig = { getConfig: jest.fn() };
  const entraActivities = { disableEntraUser: jest.fn() };
  const activities = new OrphanActivities(
    entraActivities as unknown as EntraActivities,
    {} as DriftService,
    {} as IdentityService,
    { emit: jest.fn() } as unknown as DomainEventEmitterService,
    {} as OrphanDetectionService,
    adService as unknown as AdService,
    scimService as unknown as SCIMService,
    connectorConfig as unknown as ConnectorConfigService,
  );

  it('disables an AD orphan by the DN of the account its UPN finds', async () => {
    connectorConfig.getConfig.mockResolvedValue({
      config: { host: 'dc.corp.example', rootBaseDn: 'DC=corp,DC=example' },
    });
    adService.getUserByEmail.mockResolvedValue({ id: 'CN=Svc,DC=corp,DC=example' });
    adService.setUserEnabled.mockResolvedValue({ outcome: 'done', detail: 'disabled' });

    await expect(
      activities.disableOrphanAccount('ad', 'svc@corp.example', 'tenant-a'),
    ).resolves.toBe(true);
    expect(adService.setUserEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'dc.corp.example' }),
      'CN=Svc,DC=corp,DC=example',
      false,
    );
  });

  it('answers false for a SCIM account the target no longer has', async () => {
    connectorConfig.getConfig.mockResolvedValue({
      config: { baseUrl: 'https://scim.example.com', authType: 'bearer', token: 't' },
    });
    scimService.setActive.mockResolvedValue({ outcome: 'not-found', detail: 'no such user' });

    await expect(
      activities.disableOrphanAccount('scim', 'gone@corp.example', 'tenant-a'),
    ).resolves.toBe(false);
  });

  it('disables an Entra ID orphan as before', async () => {
    entraActivities.disableEntraUser.mockResolvedValue(true);

    await expect(
      activities.disableOrphanAccount('entra-id', 'ada@corp.example', 'tenant-a'),
    ).resolves.toBe(true);
    expect(entraActivities.disableEntraUser).toHaveBeenCalledWith('ada@corp.example', 'tenant-a');
  });
});

/**
 * Delete worked in Entra ID only (HX-F report follow-up). Decision: a SCIM orphan is deleted
 * with DELETE /Users/{id}; an AD orphan is never deleted (no recycle bin guarantee, and the SID
 * is lost), and the reason goes on its drift.
 */
describe('OrphanActivities.deleteOrphanAccount per system', () => {
  const adService = { getUserByEmail: jest.fn(), setUserEnabled: jest.fn() };
  const scimService = { deleteUser: jest.fn() };
  const connectorConfig = { getConfig: jest.fn() };
  const entraActivities = { deleteUser: jest.fn() };
  const driftService = { updateOrphanDrift: jest.fn().mockResolvedValue(null) };
  const activities = new OrphanActivities(
    entraActivities as unknown as EntraActivities,
    driftService as unknown as DriftService,
    {} as IdentityService,
    { emit: jest.fn() } as unknown as DomainEventEmitterService,
    {} as OrphanDetectionService,
    adService as unknown as AdService,
    scimService as unknown as SCIMService,
    connectorConfig as unknown as ConnectorConfigService,
  );
  const scimConfig = { baseUrl: 'https://scim.example.com', authType: 'bearer', token: 't' };

  beforeEach(() => {
    jest.clearAllMocks();
    connectorConfig.getConfig.mockResolvedValue({ config: scimConfig });
  });

  // HX-F2 follow-up: a SCIM orphan was found by its accountIdentifier (userName or email) only,
  // so a user without such a match was never deleted. The cleanup now passes the SCIM id the
  // drift holds (externalId) and the user is deleted by it.
  it('deletes a SCIM orphan by its SCIM id when the cleanup passes it', async () => {
    scimService.deleteUser.mockResolvedValue({ outcome: 'done' });

    await expect(
      activities.deleteOrphanAccount('scim', 'old@corp.example', 'tenant-a', undefined, 'scim-77'),
    ).resolves.toEqual({ success: true });
    expect(scimService.deleteUser).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://scim.example.com' }),
      { id: 'scim-77' },
    );
  });

  // A cleanup started before the patch passes no external id
  it('deletes a SCIM orphan by the user its userName or email finds', async () => {
    scimService.deleteUser.mockResolvedValue({ outcome: 'done' });

    await expect(
      activities.deleteOrphanAccount('scim', 'old@corp.example', 'tenant-a'),
    ).resolves.toEqual({ success: true });
    expect(scimService.deleteUser).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://scim.example.com' }),
      { userNames: ['old@corp.example'], emails: ['old@corp.example'] },
    );
  });

  it('counts a SCIM user already gone as deleted, and none found as not deleted', async () => {
    scimService.deleteUser.mockResolvedValueOnce({ outcome: 'already-gone' });
    await expect(
      activities.deleteOrphanAccount('scim', 'old@corp.example', 'tenant-a'),
    ).resolves.toEqual({ success: true });

    scimService.deleteUser.mockResolvedValueOnce({ outcome: 'not-found' });
    await expect(
      activities.deleteOrphanAccount('scim', 'old@corp.example', 'tenant-a'),
    ).resolves.toEqual({ success: false, error: 'No such account in scim' });
  });

  // HX-F3 follow-up: an Entra ID orphan was deleted by its UPN or mail although the cleanup
  // passes the object id the drift holds. A renamed orphan was not found, and a UPN another
  // account took over would name that account.
  it('deletes an Entra ID orphan by its object id when the cleanup passes it', async () => {
    entraActivities.deleteUser.mockResolvedValue({ success: true, outcome: 'deprovisioned' });

    const result = await activities.deleteOrphanAccount(
      'entra-id',
      'old@corp.example',
      'tenant-a',
      undefined,
      '0b6f1c9e-entra-object-id',
    );

    expect(result.success).toBe(true);
    expect(entraActivities.deleteUser).toHaveBeenCalledTimes(1);
    expect(entraActivities.deleteUser).toHaveBeenCalledWith(
      '0b6f1c9e-entra-object-id',
      undefined,
      undefined,
      'tenant-a',
    );
  });

  // A cleanup started before the patch passes no external id
  it('deletes an Entra ID orphan by its UPN or mail when no object id is passed', async () => {
    entraActivities.deleteUser.mockResolvedValue({ success: true, outcome: 'deprovisioned' });

    await activities.deleteOrphanAccount('entra-id', 'old@corp.example', 'tenant-a');

    expect(entraActivities.deleteUser).toHaveBeenCalledWith(
      'old@corp.example',
      undefined,
      undefined,
      'tenant-a',
    );
  });

  it('never deletes an AD orphan, and says why', async () => {
    const result = await activities.deleteOrphanAccount('ad', 'old@corp.example', 'tenant-a');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/never deletes an Active Directory account.*SID/);
    expect(adService.getUserByEmail).not.toHaveBeenCalled();
    expect(adService.setUserEnabled).not.toHaveBeenCalled();
  });

  it('records why an orphan is kept on its drift, which stays quarantined', async () => {
    await activities.keepOrphanAccount('drift-1', 'kept for a reason', 'tenant-a');

    expect(driftService.updateOrphanDrift).toHaveBeenCalledWith('drift-1', {
      'orphanDetails.keptReason': 'kept for a reason',
    });
  });
});
