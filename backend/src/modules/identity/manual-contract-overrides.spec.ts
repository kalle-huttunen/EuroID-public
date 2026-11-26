import {
  contractValue,
  controlledContractValue,
  overridesAfterEdit,
  type SourceRecord,
} from './manual-contract-overrides';

const hr = (sourceName: string, rawData: Record<string, unknown>, sourceRole = 'primary-hr') =>
  ({ sourceName, sourceRole, rawData }) as SourceRecord;

describe('overridesAfterEdit', () => {
  const sources = [
    hr('csv-hr', { departmentName: 'Engineering', jobTitle: 'Engineer' }),
    hr('json-api-hr', { department: 'Research', title: 'Advisor' }, 'secondary-hr'),
    hr('entra-id', { departmentName: 'Engineering' }, 'target'),
  ];

  it('records the HR value the edit replaced, for the source that held it', () => {
    expect(
      overridesAfterEdit(
        undefined,
        sources,
        { departmentName: 'Engineering', jobTitle: 'Engineer' },
        { departmentName: 'Sales', jobTitle: 'Engineer' },
      ),
    ).toEqual({ departmentName: { 'csv-hr': 'Engineering' } });
  });

  it('keeps an earlier override across a second edit, and drops it when the edit returns to HR', () => {
    const first = { departmentName: { 'csv-hr': 'Engineering' } };

    expect(
      overridesAfterEdit(first, sources, { departmentName: 'Sales' }, { departmentName: 'Legal' }),
    ).toEqual(first);
    expect(
      overridesAfterEdit(
        first,
        sources,
        { departmentName: 'Sales' },
        { departmentName: 'Engineering' },
      ),
    ).toBeUndefined();
  });

  it('leaves the overrides of attributes the edit did not change as they are', () => {
    const first = { departmentName: { 'csv-hr': 'Engineering' } };

    expect(
      overridesAfterEdit(
        first,
        sources,
        { departmentName: 'Sales', jobTitle: 'Engineer' },
        { departmentName: 'Sales', jobTitle: 'Lead' },
      ),
    ).toEqual({ ...first, jobTitle: { 'csv-hr': 'Engineer' } });
  });
});

describe('contractValue', () => {
  const overrides = { departmentName: { 'csv-hr': 'Engineering' } };
  const profile = { departmentName: 'Sales' };

  it("is the profile's value while the source still holds the value the edit replaced", () => {
    const source = hr('csv-hr', { departmentName: 'Engineering' });
    expect(contractValue('departmentName', source, profile, overrides)).toBe('Sales');
  });

  it("is the source's own value once HR sends another, or for a source never overridden", () => {
    expect(
      contractValue(
        'departmentName',
        hr('csv-hr', { departmentName: 'Marketing' }),
        profile,
        overrides,
      ),
    ).toBe('Marketing');
    expect(
      contractValue(
        'departmentName',
        hr('json-api-hr', { department: 'Research' }),
        profile,
        overrides,
      ),
    ).toBe('Research');
    expect(contractValue('jobTitle', hr('csv-hr', { title: 'Engineer' }), profile, overrides)).toBe(
      'Engineer',
    );
  });
});

/**
 * An attribute control (controls.manualDepartment / manualJobTitle) replaces the HR value in the
 * primary contract whatever HR sends meanwhile: the control used to stay in the profile while the
 * contract followed HR's next value (manualOverrides only matched the value it replaced), so the
 * identity matched both departments again.
 */
describe('controlledContractValue', () => {
  const primary = hr('csv-hr', { departmentName: 'Marketing', jobTitle: 'Engineer' });

  it('gives the primary contract the control, also after HR changed its value', () => {
    expect(controlledContractValue('departmentName', primary, primary, 'R&D')).toBe('R&D');
  });

  it('gives it to another contract that reports the same job, not to a second employment', () => {
    const mirror = hr('json-api-hr', { department: 'Marketing' }, 'secondary-hr');
    const secondJob = hr('json-api-hr', { department: 'Academy' }, 'secondary-hr');

    expect(controlledContractValue('departmentName', mirror, primary, 'R&D')).toBe('R&D');
    expect(controlledContractValue('departmentName', secondJob, primary, 'R&D')).toBeUndefined();
  });

  it('gives nothing without a control', () => {
    expect(controlledContractValue('jobTitle', primary, primary, undefined)).toBeUndefined();
  });
});
