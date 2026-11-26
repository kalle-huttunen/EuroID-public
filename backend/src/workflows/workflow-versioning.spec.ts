/**
 * Unit tests for workflow-versioning helpers — validates the patch-id
 * convention and that the SDK primitives are threaded through correctly.
 */
jest.mock('@temporalio/workflow', () => ({
  patched: jest.fn(),
  deprecatePatch: jest.fn(),
}));

import { patched as tsPatched, deprecatePatch as tsDeprecatePatch } from '@temporalio/workflow';
import { patchId, isPatched, deprecatePatch } from './workflow-versioning';

const tsPatchedMock = tsPatched as unknown as jest.Mock;
const tsDeprecateMock = tsDeprecatePatch as unknown as jest.Mock;

describe('workflow-versioning', () => {
  beforeEach(() => {
    tsPatchedMock.mockReset();
    tsDeprecateMock.mockReset();
  });

  describe('patchId', () => {
    it('accepts kebab-case "<workflow>:<change>" identifiers', () => {
      expect(patchId('onboarding:add-mfa-enrollment')).toBe('onboarding:add-mfa-enrollment');
      expect(patchId('access-review:switch-reviewer-resolution')).toBe(
        'access-review:switch-reviewer-resolution',
      );
    });

    it('rejects identifiers without a colon separator', () => {
      expect(() => patchId('onboarding-add-mfa')).toThrow(/Invalid patch ID/);
    });

    it('rejects identifiers with uppercase or underscores', () => {
      expect(() => patchId('Onboarding:AddMfa')).toThrow(/Invalid patch ID/);
      expect(() => patchId('onboarding:add_mfa')).toThrow(/Invalid patch ID/);
    });

    it('rejects empty halves', () => {
      expect(() => patchId(':add-mfa')).toThrow(/Invalid patch ID/);
      expect(() => patchId('onboarding:')).toThrow(/Invalid patch ID/);
    });
  });

  describe('isPatched', () => {
    it('delegates to @temporalio/workflow patched() and returns its result', () => {
      tsPatchedMock.mockReturnValueOnce(true);
      expect(isPatched('onboarding:add-mfa-enrollment')).toBe(true);
      expect(tsPatchedMock).toHaveBeenCalledWith('onboarding:add-mfa-enrollment');

      tsPatchedMock.mockReturnValueOnce(false);
      expect(isPatched('onboarding:add-mfa-enrollment')).toBe(false);
    });

    it('throws for invalid ids before reaching the SDK', () => {
      expect(() => isPatched('bad id')).toThrow(/Invalid patch ID/);
      expect(tsPatchedMock).not.toHaveBeenCalled();
    });
  });

  describe('deprecatePatch', () => {
    it('delegates to @temporalio/workflow deprecatePatch()', () => {
      deprecatePatch('onboarding:add-mfa-enrollment');
      expect(tsDeprecateMock).toHaveBeenCalledWith('onboarding:add-mfa-enrollment');
    });

    it('throws for invalid ids before reaching the SDK', () => {
      expect(() => deprecatePatch('BAD_ID')).toThrow(/Invalid patch ID/);
      expect(tsDeprecateMock).not.toHaveBeenCalled();
    });
  });
});
