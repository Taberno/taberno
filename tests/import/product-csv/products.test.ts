import { describe, it, expect, beforeEach } from 'vitest';
import { query, queryOne, execute } from '../../../src/db/connection';
import { setSetting } from '../../../src/db/queries/admin';
import { createImportJob, findImportJob } from '../../../src/db/queries/import';
import { serializeCsv, parseCsv } from '../../../src/import/product-csv/csv';
import { COLUMNS, buildExportRows, analyze, applyImport } from '../../../src/import/product-csv/products';

const HEADER: string[] = [...COLUMNS];
const col = (name: string) => HEADER.indexOf(name);

/** Builds CSV text from column→value records (missing columns become blank). */
function makeCsv(records: Record<string, string>[]): string {
  return serializeCsv([HEADER, ...records.map((r) => HEADER.map((c) => r[c] ?? ''))]);
}

async function apply(csv: string) {
  const jobId = createImportJob('product_csv');
  await applyImport(csv, 'GBP', jobId);
  return findImportJob(jobId)!;
}

const variantBySku = (sku: string) =>
  queryOne<{ price: number; inventory_quantity: number; title: string; options: string; product_id: string }>(
    'SELECT price, inventory_quantity, title, options, product_id FROM product_variants WHERE sku = ?', [sku]);
const productCount = () => queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM products')!.n;

beforeEach(() => {
  for (const t of ['product_images', 'product_variants', 'products', 'import_jobs']) execute(`DELETE FROM ${t}`);
  setSetting('store_currency', 'GBP');
});

describe('export ⇄ import round-trip', () => {
  it('re-importing an unchanged export reports zero creates and zero updates', async () => {
    await apply(makeCsv([{ handle: 'blue-widget', title: 'Blue Widget', description: 'Nice', vendor: 'Acme', tags: 'sale', published: 'true', variant_title: 'Default', sku: 'BW1', price: '19.99', inventory_quantity: '5' }]));

    const csv = serializeCsv(buildExportRows());
    const { report } = analyze(csv, 'GBP');
    expect(report).toMatchObject({ ok: true, createProducts: 0, updateProducts: 0, problemRows: 0 });
  });

  it('a three-option product round-trips with its options intact', async () => {
    await apply(makeCsv([{ handle: 'tee', title: 'Tee', published: 'true', option_name_1: 'Size', option_value_1: 'L', option_name_2: 'Colour', option_value_2: 'Blue', option_name_3: 'Material', option_value_3: 'Cotton', variant_title: 'L / Blue / Cotton', sku: 'TEE-1', price: '10.00', inventory_quantity: '3' }]));

    expect(JSON.parse(variantBySku('TEE-1')!.options)).toEqual({ Size: 'L', Colour: 'Blue', Material: 'Cotton' });

    const grid = buildExportRows();
    const row = grid.find((r) => r[col('sku')] === 'TEE-1')!;
    expect(row[col('option_name_1')]).toBe('Size');
    expect(row[col('option_value_2')]).toBe('Blue');
    expect(row[col('option_value_3')]).toBe('Cotton');

    // And re-importing it changes nothing.
    expect(analyze(serializeCsv(grid), 'GBP').report).toMatchObject({ createProducts: 0, updateProducts: 0 });
  });
});

describe('dry run', () => {
  it('reports exactly one update when one price changed, and apply changes exactly that', async () => {
    await apply(makeCsv([
      { handle: 'a', title: 'A', sku: 'A1', price: '10.00', inventory_quantity: '1' },
      { handle: 'b', title: 'B', sku: 'B1', price: '20.00', inventory_quantity: '2' },
    ]));

    const grid = buildExportRows();
    const target = grid.find((r) => r[col('sku')] === 'A1')!;
    target[col('price')] = '12.50'; // change one price

    const { report } = analyze(serializeCsv(grid), 'GBP');
    expect(report).toMatchObject({ createProducts: 0, updateProducts: 1, problemRows: 0 });

    await apply(serializeCsv(grid));
    expect(variantBySku('A1')!.price).toBe(1250); // changed
    expect(variantBySku('B1')!.price).toBe(2000); // untouched
  });

  it('flags a malformed price with its row number without blocking other rows', async () => {
    const csv = makeCsv([
      { handle: 'good', title: 'Good', sku: 'G1', price: '9.99' },
      { handle: 'bad', title: 'Bad', sku: 'BAD1', price: 'not-a-price' },
    ]);
    const { report } = analyze(csv, 'GBP');
    expect(report.problemRows).toBe(1);
    expect(report.problems[0]).toMatchObject({ row: 3, column: 'price' }); // header=1, good=2, bad=3
    expect(report.createProducts).toBe(1); // the good row still counts

    await apply(csv);
    expect(variantBySku('G1')).not.toBeNull(); // good row imported
    expect(variantBySku('BAD1')).toBeNull();   // bad row skipped
  });

  it('rejects a formula cell on import', () => {
    // Raw CSV (not built via serializeCsv, which would neutralise it on the way
    // out) with a genuine leading '=' in the title column.
    const row = HEADER.map((c) => c === 'handle' ? 'x' : c === 'title' ? '"=HYPERLINK(""http://evil"")"' : c === 'sku' ? 'X1' : c === 'price' ? '1.00' : '');
    const csv = `${HEADER.join(',')}\r\n${row.join(',')}\r\n`;
    const { report } = analyze(csv, 'GBP');
    expect(report.problems.some((p) => /formula/i.test(p.message) && p.column === 'title')).toBe(true);
  });

  it('refuses a file whose prices use another currency', () => {
    const csv = makeCsv([{ handle: 'x', title: 'X', sku: 'X1', price: '$19.99' }]);
    const { report } = analyze(csv, 'GBP');
    expect(report.ok).toBe(false);
    expect(report.fileError).toMatch(/currency/i);
  });
});

describe('apply semantics', () => {
  it('treats a blank cell as "leave unchanged", never wiping other columns', async () => {
    await apply(makeCsv([{ handle: 'keep', title: 'Original', vendor: 'Acme', sku: 'K1', price: '10.00', inventory_quantity: '7' }]));

    // Re-import touching only the price; everything else blank.
    await apply(makeCsv([{ handle: 'keep', sku: 'K1', price: '11.00' }]));

    const v = variantBySku('K1')!;
    expect(v.price).toBe(1100);            // changed
    expect(v.inventory_quantity).toBe(7);  // untouched
    const p = queryOne<{ title: string; vendor: string }>('SELECT title, vendor FROM products WHERE id = ?', [v.product_id])!;
    expect(p.title).toBe('Original');      // not wiped
    expect(p.vendor).toBe('Acme');         // not wiped
  });

  it('never deletes: a product absent from the file is left alone', async () => {
    await apply(makeCsv([
      { handle: 'stays', title: 'Stays', sku: 'S1', price: '1.00' },
      { handle: 'goes', title: 'Goes', sku: 'G1', price: '2.00' },
    ]));
    expect(productCount()).toBe(2);

    await apply(makeCsv([{ handle: 'stays', sku: 'S1', price: '1.50' }])); // only mentions one
    expect(productCount()).toBe(2); // the other survives
    expect(variantBySku('G1')).not.toBeNull();
  });

  it('imports a large file without issue (background-job path avoids HTTP timeout)', async () => {
    const records = Array.from({ length: 1500 }, (_, i) => ({ handle: `p-${i}`, title: `P ${i}`, sku: `SKU-${i}`, price: '5.00', inventory_quantity: '1' }));
    await apply(makeCsv(records));
    expect(productCount()).toBe(1500);
  });
});
