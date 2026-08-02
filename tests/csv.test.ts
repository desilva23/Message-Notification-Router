/**
 * CSV parser and serialiser tests.
 *
 * The dataset contains quoted fields with embedded newlines, so the quoting
 * rules are not academic here — getting them wrong shears real rows apart and
 * every downstream number becomes garbage.
 */

import { describe, expect, it } from 'vitest';
import { escapeCsvCell, parseCsv, parseCsvRows, toCsv, toInt, toNullableInt } from '../src/lib/data/csv';

describe('parseCsvRows', () => {
  it('parses simple rows', () => {
    expect(parseCsvRows('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps newlines inside quoted fields', () => {
    const input = 'id,text\n1,"line one\nline two"\n2,plain';
    expect(parseCsvRows(input)).toEqual([
      ['id', 'text'],
      ['1', 'line one\nline two'],
      ['2', 'plain'],
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsvRows('a\n"He said ""hi"""')).toEqual([['a'], ['He said "hi"']]);
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsvRows('a,b\n"x,y",z')).toEqual([
      ['a', 'b'],
      ['x,y', 'z'],
    ]);
  });

  it('handles CRLF and lone CR line endings', () => {
    expect(parseCsvRows('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsvRows('a\r1')).toEqual([['a'], ['1']]);
  });

  it('strips a UTF-8 BOM from the first header', () => {
    const rows = parseCsvRows('﻿id,name\n1,x');
    expect(rows[0]?.[0]).toBe('id');
  });

  it('preserves empty trailing fields', () => {
    expect(parseCsvRows('a,b,c\n1,,')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
    ]);
  });
});

describe('parseCsv', () => {
  it('keys rows by header', () => {
    expect(parseCsv('id,name\n1,Ada')).toEqual([{ id: '1', name: 'Ada' }]);
  });

  it('skips blank trailing lines', () => {
    expect(parseCsv('id\n1\n\n')).toEqual([{ id: '1' }]);
  });

  it('fills missing trailing columns with empty strings', () => {
    expect(parseCsv('a,b,c\n1,2')).toEqual([{ a: '1', b: '2', c: '' }]);
  });

  it('returns nothing for an empty document', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('serialisation', () => {
  it('quotes only cells that need it', () => {
    expect(escapeCsvCell('plain')).toBe('plain');
    expect(escapeCsvCell('has,comma')).toBe('"has,comma"');
    expect(escapeCsvCell('has"quote')).toBe('"has""quote"');
    expect(escapeCsvCell('has\nnewline')).toBe('"has\nnewline"');
  });

  it('writes columns in the given order, not object key order', () => {
    const csv = toCsv([{ b: '2', a: '1' }], ['a', 'b']);
    expect(csv).toBe('a,b\n1,2\n');
  });

  it('round-trips through the parser', () => {
    const records = [{ id: '1', text: 'a "quoted", multi\nline value' }];
    const parsed = parseCsv(toCsv(records, ['id', 'text']));
    expect(parsed).toEqual(records);
  });

  it('ends with a newline', () => {
    expect(toCsv([{ a: '1' }], ['a']).endsWith('\n')).toBe(true);
  });
});

describe('numeric coercion', () => {
  it('treats blanks and garbage as zero', () => {
    expect(toInt('')).toBe(0);
    expect(toInt(undefined)).toBe(0);
    expect(toInt('abc')).toBe(0);
    expect(toInt('42')).toBe(42);
  });

  it('distinguishes a blank from a zero when nullable', () => {
    expect(toNullableInt('')).toBeNull();
    expect(toNullableInt('0')).toBe(0);
  });
});
