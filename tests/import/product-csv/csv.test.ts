import { describe, it, expect } from 'vitest';
import { parseCsv, serializeCsv, csvCell, looksLikeFormula, neutralizeFormula } from '../../../src/import/product-csv/csv';

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });
  it('handles quoted commas, quotes and newlines', () => {
    expect(parseCsv('"a,b",c')).toEqual([['a,b', 'c']]);
    expect(parseCsv('"she said ""hi""",x')).toEqual([['she said "hi"', 'x']]);
    expect(parseCsv('"line1\nline2",x')).toEqual([['line1\nline2', 'x']]);
  });
  it('handles CRLF and strips a BOM, dropping blank lines', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n\r\n3,4\r\n')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
  it('keeps empty trailing fields', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });
});

describe('serializeCsv', () => {
  it('round-trips values needing quoting', () => {
    const grid = [['handle', 'title'], ['h1', 'A, B "C"'], ['h2', 'line1\nline2']];
    const parsed = parseCsv(serializeCsv(grid));
    expect(parsed).toEqual(grid);
  });
  it('prepends a UTF-8 BOM', () => {
    expect(serializeCsv([['a']]).charCodeAt(0)).toBe(0xfeff);
  });
});

describe('CSV-injection defence', () => {
  it('detects formula-leading cells', () => {
    for (const s of ['=1+1', '+A1', '-2', '@x', '\ttab', '\rcr']) expect(looksLikeFormula(s)).toBe(true);
    for (const s of ['19.99', 'Blue Widget', 'a=b']) expect(looksLikeFormula(s)).toBe(false);
  });
  it('neutralises on export with a leading apostrophe', () => {
    expect(neutralizeFormula('=HYPERLINK("http://evil")')).toBe(`'=HYPERLINK("http://evil")`);
    expect(csvCell('=SUM(A1:A9)')).toBe(`'=SUM(A1:A9)`);
  });
});
