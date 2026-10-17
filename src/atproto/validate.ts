import fs from 'fs';
import path from 'path';
import { lexiconLib } from './lib';

// Checks records against the vendored shop.lgtm.commerce lexicons before
// they leave the store, so a mapping bug shows up in the sync log rather than
// as a record directories silently refuse to index.

const DIR = path.join(__dirname, 'lexicons');
let lexicons: { assertValidRecord(nsid: string, value: unknown): unknown } | null = null;

function load() {
  if (lexicons) return lexicons;
  const { Lexicons } = lexiconLib();
  const lex = new Lexicons();
  for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    lex.add(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
  }
  lexicons = lex;
  return lex;
}

/** Returns null when valid, else the validation error. */
export function validateRecord(collection: string, record: Record<string, unknown>): string | null {
  try {
    load().assertValidRecord(collection, lexiconLib().jsonToLex(record));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
