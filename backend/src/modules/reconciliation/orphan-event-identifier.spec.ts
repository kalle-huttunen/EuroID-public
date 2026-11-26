import { orphanEventIdentifier } from './orphan-event-identifier';

describe('orphanEventIdentifier (orphan.detected accountIdentifier)', () => {
  it.each([
    ['an Entra ID object id', '7c1f6e2a-0b8d-4a51-9d3e-2f4b6c8a1e90'],
    ['a SCIM id', '2819c223-7f76-453a-919d-413861904646'],
  ])('is the account id itself when it is opaque: %s', (_label, id) => {
    expect(orphanEventIdentifier(id, 'ada.lovelace@corp.example')).toBe(id);
  });

  it("masks an AD account, whose id is a DN with the person's name, by its UPN", () => {
    const dn = 'CN=Ada Lovelace,OU=Users,DC=corp,DC=example';

    expect(orphanEventIdentifier(dn, 'ada.lovelace@corp.example')).toBe('a•••@corp.example');
    expect(orphanEventIdentifier(dn)).toBe('CN=•••,OU=Users,DC=corp,DC=example');
  });

  it('never returns an address in clear, also when the id is one', () => {
    expect(orphanEventIdentifier('ada.lovelace@corp.example', 'ada.lovelace@corp.example')).toBe(
      'a•••@corp.example',
    );
    expect(orphanEventIdentifier('ada.lovelace@corp.example')).toBe('a•••@corp.example');
  });
});
