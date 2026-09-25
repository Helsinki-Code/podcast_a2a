import { PGlite } from '@electric-sql/pglite';

// A stand-in for @neondatabase/serverless's tagged-template client, backed by in-process Postgres,
// so the store's SQL runs against a real database engine in tests.
export function createNeonShim() {
  const db = new PGlite();
  const neon = () => async (strings, ...values) => {
    const text = strings.reduce((query, part, index) => query + part + (index < values.length ? `$${index + 1}` : ''), '');
    const result = await db.query(text, values);
    return result.rows;
  };
  return { db, neon };
}
