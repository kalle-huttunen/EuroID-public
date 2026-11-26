import { CredentialGenerationService, CredentialPolicy } from './credential-generation.service';

describe('CredentialGenerationService', () => {
  let service: CredentialGenerationService;

  beforeEach(() => {
    service = new CredentialGenerationService();
  });

  describe('generatePassword — default policy', () => {
    it('generates a 20-character password by default', () => {
      const pw = service.generatePassword();
      expect(pw).toHaveLength(20);
    });

    it('produces different passwords on consecutive calls', () => {
      const passwords = new Set(Array.from({ length: 20 }, () => service.generatePassword()));
      // With 20 calls at 20-char length, collisions are essentially impossible
      expect(passwords.size).toBe(20);
    });
  });

  describe('generatePassword — custom policy', () => {
    it('respects custom length', () => {
      const pw = service.generatePassword({ length: 32 });
      expect(pw).toHaveLength(32);
    });

    it('enforces minimum length of 4', () => {
      const pw = service.generatePassword({ length: 2 });
      expect(pw.length).toBeGreaterThanOrEqual(4);
    });

    it('respects custom character pools', () => {
      const policy: CredentialPolicy = {
        length: 10,
        upperChars: 'AB',
        lowerChars: 'cd',
        digitChars: '12',
        specialChars: '!@',
      };
      const pw = service.generatePassword(policy);
      expect(pw).toHaveLength(10);
      // Every character must be from the allowed set
      for (const ch of pw) {
        expect('ABcd12!@').toContain(ch);
      }
    });

    it('uses AD-specific policy with excluded ambiguous characters', () => {
      const adPolicy: CredentialPolicy = {
        length: 16,
        upperChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ', // no I, O
        lowerChars: 'abcdefghjkmnpqrstuvwxyz', // no l
        digitChars: '23456789', // no 0, 1
        specialChars: '!@#$%',
      };
      const pw = service.generatePassword(adPolicy);
      expect(pw).toHaveLength(16);
      expect(pw).not.toMatch(/[IOl01]/);
    });

    it('throws when all character pools are empty', () => {
      const policy: CredentialPolicy = {
        upperChars: '',
        lowerChars: '',
        digitChars: '',
        specialChars: '',
      };
      expect(() => service.generatePassword(policy)).toThrow(
        'CredentialPolicy must define at least one character in a pool',
      );
    });

    it('handles a single non-empty character pool', () => {
      const policy: CredentialPolicy = {
        length: 8,
        upperChars: 'ABC',
        lowerChars: '',
        digitChars: '',
        specialChars: '',
      };
      const pw = service.generatePassword(policy);
      expect(pw).toHaveLength(8);
      for (const ch of pw) {
        expect('ABC').toContain(ch);
      }
    });
  });

  describe('character class guarantees under stress', () => {
    it('always includes all four classes over 100 generations', () => {
      for (let i = 0; i < 100; i++) {
        const pw = service.generatePassword();
        expect(pw).toMatch(/[A-Z]/);
        expect(pw).toMatch(/[a-z]/);
        expect(pw).toMatch(/[0-9]/);
        expect(pw).toMatch(/[!@#$%^&*()\-_=+]/);
      }
    });
  });
});
