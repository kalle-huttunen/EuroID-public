/**
 * The admin UPN from ADMIN_UPN_PATTERN (admin-upn.ts). Entra ID accepts only ASCII letters,
 * digits and a few marks in a UPN's local part, so a name with diacritics must not reach it as
 * is; `{tier}` lets a pattern give each admin tier of a person its own UPN; a name that gave an
 * ASCII UPN before must give the same one now (existing admin UPNs stay).
 */
import { adminUpn, asciiUpnPart, tierToken, withNumericSuffix } from './admin-upn';

const DEFAULT_PATTERN = 'adm-{firstName}.{lastName}@{domain}';

describe('admin UPN', () => {
  it('keeps the UPN a plain ASCII name gave before', () => {
    expect(
      adminUpn(DEFAULT_PATTERN, {
        firstName: 'Kalle',
        lastName: 'Van Der Berg-Smith',
        email: 'kalle@contoso.com',
        adminTier: 'TIER_1',
      }),
    ).toBe('adm-kalle.vanderberg-smith@contoso.com');
  });

  it('writes letters with diacritics as their ASCII base letter', () => {
    expect(
      adminUpn(DEFAULT_PATTERN, {
        firstName: 'Jöns',
        lastName: 'Mäkinen-Åström',
        email: 'jons.makinen@corp.fi',
        adminTier: 'TIER_0',
      }),
    ).toBe('adm-jons.makinen-astrom@corp.fi');
    expect(asciiUpnPart('Straße Øster Łukasz')).toBe('strasseosterlukasz');
  });

  it('drops what Entra ID does not allow in a local part', () => {
    expect(asciiUpnPart('Anne (Ann) Smith, Jr.')).toBe('anneannsmithjr.');
    expect(asciiUpnPart('李')).toBe('');
    // A name with nothing left falls back as before
    expect(
      adminUpn(DEFAULT_PATTERN, {
        firstName: '李',
        lastName: '王',
        email: 'li@corp.cn',
        adminTier: 'TIER_2',
      }),
    ).toBe('adm-admin.user@corp.cn');
  });

  it('fills {tier} with t0, t1, t2', () => {
    const pattern = 'adm-{firstName}.{lastName}-{tier}@{domain}';
    const upnOf = (adminTier: string) =>
      adminUpn(pattern, {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@corp.example',
        adminTier,
      });

    expect(upnOf('TIER_0')).toBe('adm-ada.lovelace-t0@corp.example');
    expect(upnOf('TIER_1')).toBe('adm-ada.lovelace-t1@corp.example');
    expect(upnOf('TIER_2')).toBe('adm-ada.lovelace-t2@corp.example');
    expect(tierToken('TIER_1')).toBe('t1');
  });

  it('puts a numeric suffix at the end of the local part', () => {
    expect(withNumericSuffix('adm-ada.lovelace@corp.example', 2)).toBe(
      'adm-ada.lovelace2@corp.example',
    );
    expect(withNumericSuffix('adm-ada', 3)).toBe('adm-ada3');
  });
});
