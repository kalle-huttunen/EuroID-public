/**
 * Unit tests for escapeRegex utility.
 */
import { escapeRegex } from './escape-regex';

describe('escapeRegex', () => {
  it('should escape regex metacharacters', () => {
    expect(escapeRegex('user+test')).toBe('user\\+test');
    expect(escapeRegex('a]b')).toBe('a\\]b');
    expect(escapeRegex('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
  });

  it('should not modify safe strings', () => {
    expect(escapeRegex('admin')).toBe('admin');
    expect(escapeRegex('user@example.com')).toBe('user@example\\.com');
  });
});
