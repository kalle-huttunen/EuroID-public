import { droppedFields } from './dropped-fields';

describe('droppedFields', () => {
  it('lists the keys the previous record had and the new one lacks or empties', () => {
    expect(
      droppedFields(
        { email: 'a@x.test', endDate: '2026-11-20', departmentName: 'Sales', jobTitle: 'Rep' },
        { email: 'a@x.test', departmentName: '', jobTitle: null },
      ),
    ).toEqual(['endDate', 'departmentName', 'jobTitle']);
  });

  it('compares custom attributes one by one', () => {
    expect(
      droppedFields(
        { customAttributes: { hrStatus: 'Terminated', costCenter: 'CC1' } },
        { customAttributes: { costCenter: 'CC1' } },
      ),
    ).toEqual(['customAttributes.hrStatus']);
    expect(droppedFields({ customAttributes: { hrStatus: 'Left' } }, {})).toEqual([
      'customAttributes.hrStatus',
    ]);
  });

  it('reports nothing for a first record, unchanged keys, empty old values or _id', () => {
    expect(droppedFields(undefined, { email: 'a@x.test' })).toEqual([]);
    expect(
      droppedFields({ email: 'a@x.test', _id: 'x', title: '' }, { email: 'b@x.test' }),
    ).toEqual([]);
  });
});
