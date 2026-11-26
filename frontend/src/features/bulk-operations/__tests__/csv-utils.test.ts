import { describe, it, expect } from 'vitest';
import { decodeCsvBytes, parseCsv } from '../csv-utils';

// Hunt 2026-11-25 r2-08 N7: Excel in European locales (Finnish included) writes `;`-separated,
// often Windows-1252 CSV; every row became one column and accented letters broke
describe('parseCsv', () => {
  it('reads a semicolon-separated file into columns, commas in a value kept', () => {
    expect(parseCsv('etunimi;sukunimi;osasto\nÄijä;Virtanen;Myynti, Helsinki\n')).toEqual([
      ['etunimi', 'sukunimi', 'osasto'],
      ['Äijä', 'Virtanen', 'Myynti, Helsinki'],
    ]);
  });

  it('keeps a comma inside an unquoted value of a tab-separated file', () => {
    expect(parseCsv('name\ttitle\nAda\tLead, Platform\n')).toEqual([
      ['name', 'title'],
      ['Ada', 'Lead, Platform'],
    ]);
  });

  it('still reads a comma-separated file with quoted commas', () => {
    expect(parseCsv('name,title\n"Lovelace, Ada",Lead\n')).toEqual([
      ['name', 'title'],
      ['Lovelace, Ada', 'Lead'],
    ]);
  });
});

describe('decodeCsvBytes', () => {
  it('decodes UTF-8, and Windows-1252 when the bytes are no UTF-8', () => {
    const utf8 = new TextEncoder().encode('nimi\nÄijä\n');
    // "nimi\nÄijä\n" in Windows-1252: Ä = 0xC4, ä = 0xE4
    const cp1252 = new Uint8Array([0x6e, 0x69, 0x6d, 0x69, 0x0a, 0xc4, 0x69, 0x6a, 0xe4, 0x0a]);

    expect(decodeCsvBytes(utf8.buffer)).toBe('nimi\nÄijä\n');
    expect(decodeCsvBytes(cp1252.buffer)).toBe('nimi\nÄijä\n');
  });
});
