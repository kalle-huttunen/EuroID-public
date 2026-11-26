import { generateUpnCandidates, UpnUserInput } from './upn-generator';

describe('UPN Generator', () => {
  const domain = 'example.com';

  describe('generateUpnCandidates', () => {
    it('should generate firstname.lastname as first candidate', () => {
      const user: UpnUserInput = { firstName: 'John', lastName: 'Doe' };
      const candidates = generateUpnCandidates(user, domain);
      expect(candidates[0]).toBe('john.doe@example.com');
    });

    it('should include middle initial pattern when middleName provided', () => {
      const user: UpnUserInput = { firstName: 'John', lastName: 'Doe', middleName: 'Michael' };
      const candidates = generateUpnCandidates(user, domain);
      expect(candidates).toContain('john.m.doe@example.com');
    });

    it('should return empty array when firstName is missing', () => {
      const user: UpnUserInput = { firstName: '', lastName: 'Doe' };
      expect(generateUpnCandidates(user, domain)).toEqual([]);
    });

    it('should return empty array when lastName is missing', () => {
      const user: UpnUserInput = { firstName: 'John', lastName: '' };
      expect(generateUpnCandidates(user, domain)).toEqual([]);
    });

    it('should sanitize special characters', () => {
      const user: UpnUserInput = { firstName: 'José María', lastName: "O'Brien" };
      const candidates = generateUpnCandidates(user, domain);
      // Special chars removed, spaces removed, lowercase
      expect(candidates[0]).toMatch(/^[a-z0-9._-]+@example\.com$/);
    });

    it('should prepend preferredUpn when it matches domain', () => {
      const user: UpnUserInput = { firstName: 'John', lastName: 'Doe' };
      const candidates = generateUpnCandidates(user, domain, undefined, 10, 'custom.upn@example.com');
      expect(candidates[0]).toBe('custom.upn@example.com');
    });

    it('should ignore preferredUpn when it does not match domain', () => {
      const user: UpnUserInput = { firstName: 'John', lastName: 'Doe' };
      const candidates = generateUpnCandidates(user, domain, undefined, 10, 'john@otherdomain.com');
      expect(candidates[0]).not.toBe('john@otherdomain.com');
    });

    it('should generate numeric suffix candidates', () => {
      const user: UpnUserInput = { firstName: 'John', lastName: 'Doe' };
      const candidates = generateUpnCandidates(user, domain);
      expect(candidates).toContain('john.doe1@example.com');
      expect(candidates).toContain('john.doe10@example.com');
    });

    it('should de-duplicate candidates', () => {
      const user: UpnUserInput = { firstName: 'John', lastName: 'Doe' };
      const candidates = generateUpnCandidates(user, domain);
      const unique = new Set(candidates);
      expect(candidates.length).toBe(unique.size);
    });

    it('should handle domain with leading @', () => {
      const user: UpnUserInput = { firstName: 'John', lastName: 'Doe' };
      const candidates = generateUpnCandidates(user, '@example.com');
      expect(candidates[0]).toBe('john.doe@example.com');
      // Should NOT produce john.doe@@example.com
      expect(candidates.every(c => !c.includes('@@'))).toBe(true);
    });

    it('should respect custom pattern order', () => {
      const user: UpnUserInput = { firstName: 'John', lastName: 'Doe' };
      const candidates = generateUpnCandidates(user, domain, ['flastname', 'firstname.lastname']);
      expect(candidates[0]).toBe('jdoe@example.com');
      expect(candidates[1]).toBe('john.doe@example.com');
    });
  });
});
