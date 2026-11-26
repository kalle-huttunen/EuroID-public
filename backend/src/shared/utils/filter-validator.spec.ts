import { BadRequestException } from '@nestjs/common';
import {
  rejectOperators,
  validateFilterKeys,
  IDENTITY_ALLOWED_FILTER_KEYS,
} from './filter-validator';

describe('filter-validator', () => {
  describe('rejectOperators', () => {
    it('should throw when $ operator is inside array', () => {
      expect(() => rejectOperators([{ $where: '1' }])).toThrow(BadRequestException);
      expect(() => rejectOperators([{ $where: '1' }])).toThrow('Query operators not allowed');
    });

    it('should throw on $ operator in object', () => {
      expect(() => rejectOperators({ $gt: 5 })).toThrow(BadRequestException);
    });

    it('should allow valid nested objects', () => {
      expect(() => rejectOperators({ email: 'a@b.com' })).not.toThrow();
    });

    it('should throw when nesting exceeds max depth', () => {
      let deep: unknown = 'leaf';
      for (let i = 0; i < 10; i++) {
        deep = [deep];
      }
      expect(() => rejectOperators(deep)).toThrow('Filter nesting too deep');
    });
  });

  describe('validateFilterKeys', () => {
    it('should reject filter with $ operator in array value', () => {
      expect(() =>
        validateFilterKeys({ email: [{ $where: '1' }] }, IDENTITY_ALLOWED_FILTER_KEYS),
      ).toThrow(BadRequestException);
    });

    it('should reject object values for string fields', () => {
      expect(() =>
        validateFilterKeys({ email: { $regex: '.*' } }, IDENTITY_ALLOWED_FILTER_KEYS),
      ).toThrow('must be a primitive');
    });

    it('should reject arrays containing objects', () => {
      expect(() =>
        validateFilterKeys({ status: [{ nested: true }] }, IDENTITY_ALLOWED_FILTER_KEYS),
      ).toThrow('must be a primitive');
    });

    it('should allow primitive string values', () => {
      expect(() =>
        validateFilterKeys({ email: 'test@example.com' }, IDENTITY_ALLOWED_FILTER_KEYS),
      ).not.toThrow();
    });

    it('should allow arrays of primitives', () => {
      expect(() =>
        validateFilterKeys({ status: ['ACTIVE', 'INACTIVE'] }, IDENTITY_ALLOWED_FILTER_KEYS),
      ).not.toThrow();
    });

    it('should allow null values', () => {
      expect(() => validateFilterKeys({ email: null }, IDENTITY_ALLOWED_FILTER_KEYS)).not.toThrow();
    });
  });
});
