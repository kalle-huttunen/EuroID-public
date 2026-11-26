/**
 * The identity page's Raw data tab. It said it showed the complete JSON of the user object, but
 * GET /identity/:id leaves out the sources, provisioning and controls. It now says what it shows,
 * and adds the sources and provisioning state from the full identity record the page already
 * loads (GET /identity/v2/by-email, masked by the API) when that record is this identity.
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../../test/test-utils';
import { RawDataTab, type RawIdentityRecord } from '../RawDataTab';
import type { IStandardUser } from '../../../../interfaces';

const ID = '64b7f0c2a1b2c3d4e5f60812';

/** As GET /identity/:id answers it (no sources, provisioning or controls). */
const user = {
  _id: ID,
  sourceSystem: 'csv-hr',
  sourceUserId: 'E1042',
  tenantId: 'default',
  firstName: 'Tiina',
  lastName: 'Ahonen',
  email: 'tiina.ahonen@corp.example',
  mobilePhone: '+358 40 ••• 4567',
  status: 'ACTIVE',
} as unknown as IStandardUser;

/** As GET /identity/v2/by-email answers it under `identity`. */
const record: RawIdentityRecord & Record<string, unknown> = {
  _id: ID,
  profile: { email: 'tiina.ahonen@corp.example' },
  sources: [
    {
      sourceName: 'csv-hr',
      externalId: 'E1042',
      lastSync: '2026-11-23T06:00:00.000Z',
      rawData: { employeeId: 'E1042', mobilePhone: '+358 40 ••• 4567' },
    },
  ],
  provisioning: [{ targetSystem: 'entra-id', status: 'PROVISIONED' }],
  controls: { isLoginDisabled: false },
};

const json = () => JSON.parse(document.querySelector('pre')!.textContent!);

describe('RawDataTab', () => {
  it('says what it shows instead of claiming the complete user object', () => {
    renderWithProviders(<RawDataTab user={user} />);

    expect(screen.queryByText(/complete JSON/)).not.toBeInTheDocument();
    expect(screen.getByText(/Profile and metadata as the API returns them\./)).toBeInTheDocument();
    expect(json()).toEqual(user);
  });

  it("adds the identity's sources and provisioning state from the full record", () => {
    renderWithProviders(<RawDataTab user={user} identity={record} />);

    expect(
      screen.getByText(/with the identity's sources and provisioning state/),
    ).toBeInTheDocument();
    const shown = json();
    expect(shown).toMatchObject({ _id: ID, email: user.email });
    expect(shown.sources).toEqual(record.sources);
    expect(shown.provisioning).toEqual(record.provisioning);
    // The masked values stay as the API sent them.
    expect(shown.sources[0].rawData.mobilePhone).toBe('+358 40 ••• 4567');
    // Only the two layers named in the text; controls stay out.
    expect(shown).not.toHaveProperty('controls');
  });

  it('leaves them out when the record found by email is another identity', () => {
    const other = { ...record, _id: '64b7f0c2a1b2c3d4e5f60899' };
    renderWithProviders(<RawDataTab user={user} identity={other} />);

    expect(json()).not.toHaveProperty('sources');
    expect(json()).not.toHaveProperty('provisioning');
    expect(screen.queryByText(/sources and provisioning state/)).not.toBeInTheDocument();
  });
});
