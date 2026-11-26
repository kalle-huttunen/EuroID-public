/**
 * Attribute controls (owner decision 2026-11-24): the explicit override of an HR-mastered
 * department or job title, with a reason, an optional expiry, and who set it.
 */
import {
  activeAttributeControls,
  attributeControlChanges,
  controlPaths,
  controlValue,
  expiredControlChanges,
  setsAttributeControl,
} from './attribute-controls';

const NOW = new Date('2026-11-24T10:00:00Z');

describe('attributeControlChanges', () => {
  it('sets a control with its reason, expiry, author and time', () => {
    const changes = attributeControlChanges(
      { manualDepartment: 'Sales' },
      {
        manualJobTitle: ' Interim lead ',
        reason: ' Reorg pilot ',
        expiresAt: '2026-12-01T00:00:00Z',
      },
      'op@corp.example',
      NOW,
    );

    expect(changes).toEqual([
      {
        attribute: 'jobTitle',
        action: 'set',
        value: 'Interim lead',
        previous: undefined,
        info: {
          reason: 'Reorg pilot',
          setBy: 'op@corp.example',
          setAt: NOW,
          expiresAt: new Date('2026-12-01T00:00:00Z'),
        },
      },
    ]);
  });

  it('removes a set control on "" or null, and leaves a control the request does not name', () => {
    const current = { manualDepartment: 'R&D', manualJobTitle: 'Lead' };

    expect(attributeControlChanges(current, { manualDepartment: '' }, 'op', NOW)).toEqual([
      { attribute: 'departmentName', action: 'removed', previous: 'R&D' },
    ]);
    expect(attributeControlChanges(current, { manualJobTitle: null }, 'op', NOW)).toEqual([
      { attribute: 'jobTitle', action: 'removed', previous: 'Lead' },
    ]);
    expect(attributeControlChanges(current, { reason: 'x' }, 'op', NOW)).toEqual([]);
  });

  it('keeps the reason of a removal for the audit', () => {
    expect(
      attributeControlChanges(
        { manualDepartment: 'R&D' },
        { manualDepartment: '', reason: ' Pilot over ' },
        'op',
        NOW,
      ),
    ).toEqual([
      {
        attribute: 'departmentName',
        action: 'removed',
        previous: 'R&D',
        info: { reason: 'Pilot over', setAt: NOW, setBy: 'op' },
      },
    ]);
  });

  it('makes no change when removing a control that is not set', () => {
    expect(attributeControlChanges({}, { manualDepartment: '' }, 'op', NOW)).toEqual([]);
  });

  it('records the value a new control replaces', () => {
    const [change] = attributeControlChanges(
      { manualDepartment: 'R&D' },
      { manualDepartment: 'Finance', reason: 'Moved' },
      'op',
      NOW,
    );
    expect(change).toMatchObject({ action: 'set', value: 'Finance', previous: 'R&D' });
  });
});

describe('expiredControlChanges', () => {
  it('ends the controls whose expiry is at or before now, and keeps the others', () => {
    const current = {
      manualDepartment: 'R&D',
      manualDepartmentInfo: { reason: 'a', expiresAt: new Date('2026-11-24T10:00:00Z') },
      manualJobTitle: 'Lead',
      manualJobTitleInfo: { reason: 'b', expiresAt: new Date('2026-11-24T11:00:00Z') },
    };

    expect(expiredControlChanges(current, NOW)).toEqual([
      { attribute: 'departmentName', action: 'expired', previous: 'R&D' },
    ]);
  });

  it('never ends a control without expiry', () => {
    expect(
      expiredControlChanges(
        { manualDepartment: 'R&D', manualDepartmentInfo: { reason: 'a' } },
        NOW,
      ),
    ).toEqual([]);
  });
});

describe('controlPaths', () => {
  it('writes the value and its info for a set, and unsets both when the control ends', () => {
    const info = { reason: 'r', setAt: NOW };
    expect(
      controlPaths({ attribute: 'departmentName', action: 'set', value: 'R&D', info }),
    ).toEqual({ manualDepartment: 'R&D', manualDepartmentInfo: info });
    expect(controlPaths({ attribute: 'jobTitle', action: 'expired', previous: 'Lead' })).toEqual({
      manualJobTitle: undefined,
      manualJobTitleInfo: undefined,
    });
  });
});

describe('controlValue, activeAttributeControls, setsAttributeControl', () => {
  it('reads a set control and ignores an empty one', () => {
    expect(controlValue({ manualDepartment: 'R&D' }, 'departmentName')).toBe('R&D');
    expect(controlValue({ manualDepartment: '' }, 'departmentName')).toBeUndefined();
    expect(controlValue(undefined, 'jobTitle')).toBeUndefined();
  });

  it('lists the active controls with their info', () => {
    expect(
      activeAttributeControls({
        manualDepartment: 'R&D',
        manualDepartmentInfo: { reason: 'Reorg', setBy: 'op' },
        manualJobTitle: '',
      }),
    ).toEqual({ departmentName: { value: 'R&D', reason: 'Reorg', setBy: 'op' } });
  });

  it('says whether a request sets a control (which needs a reason)', () => {
    expect(setsAttributeControl({ manualDepartment: 'R&D' })).toBe(true);
    expect(setsAttributeControl({ manualDepartment: ' ', manualJobTitle: null })).toBe(false);
  });
});
