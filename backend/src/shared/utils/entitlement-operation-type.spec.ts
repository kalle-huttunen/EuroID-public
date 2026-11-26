import { toOperationType } from './entitlement-operation-type';

describe('toOperationType', () => {
  it('names a directory role `role` in every spelling', () => {
    expect(toOperationType('DirectoryRole')).toBe('role');
    expect(toOperationType('directoryrole')).toBe('role');
    expect(toOperationType('role')).toBe('role');
  });

  it('lower-cases groups and licenses', () => {
    expect(toOperationType('Group')).toBe('group');
    expect(toOperationType('License')).toBe('license');
  });

  it('treats a missing type as a group', () => {
    expect(toOperationType(undefined)).toBe('group');
    expect(toOperationType(null)).toBe('group');
  });
});
