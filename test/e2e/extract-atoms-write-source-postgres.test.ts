/**
 * Real-Postgres parity for the core of the extract_atoms read/write split (the PGLite twin is
 * test/extract-atoms-write-source.test.ts). What PGLite alone cannot prove: the extra bind parameter in the discovery
 * query ($5, or $6 beside an affectedSlugs filter), the correlated per-row write-source subquery in the brain-wide
 * backlog count, and the sources.config JSONB read, all over the postgres.js wire path.
 * Skips gracefully when DATABASE_URL is unset.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { countExtractAtomsBacklog, discoverExtractablePages, runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { configuredWriteSource, EXTRACT_ATOMS_WRITE_SOURCE_KEY } from '../../src/core/cycle/extract-atoms-write-source.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;
beforeEach(async () => { if (!skip) engine = (await setupDB()) as PostgresEngine; });
afterAll(async () => { if (!skip) await teardownDB(); });

const slug = 'meetings/example';
const body = 'Evidence about a synthetic example and its repeatable outcomes. '.repeat(20);
const atoms = JSON.stringify(['First synthetic atom', 'Second synthetic atom'].map(title => ({ title, atom_type: 'insight', body: `${title} evidence.` })));
const response = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
const ledger = () => engine.executeRaw<{ source_id: string; owner_key: string }>(
  "SELECT source_id, owner_key FROM derived_generations WHERE kind='atom' ORDER BY source_id, owner_key");
const count = async (sql: string) => Number((await engine.executeRaw<{ n: string | number }>(sql))[0]!.n);
async function setup(split: boolean) {
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('wiki','wiki'),('derived','derived') ON CONFLICT DO NOTHING");
  if (split) await engine.updateSourceConfig('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
  await engine.putPage(slug, { type: 'meeting', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} }, { sourceId: 'wiki' });
}
async function run(text = atoms) {
  let calls = 0;
  const result = await runPhaseExtractAtoms(engine, { sourceId: 'wiki', _transcripts: [], _chat: async () => { calls++; return response(text); } });
  return { result, calls };
}

describeIfDB('extract_atoms read/write split on real Postgres', () => {
  test('unset config: atoms, ledger key and counts are exactly as before', async () => {
    await setup(false);
    expect(await configuredWriteSource(engine, 'wiki')).toBe('wiki');
    expect(await countExtractAtomsBacklog(engine, 'wiki')).toBe(1);
    expect(await countExtractAtomsBacklog(engine)).toBe(1);
    const { result } = await run();
    expect(result.status).toBe('ok');
    expect(await count("SELECT count(*) AS n FROM pages WHERE type='atom' AND source_id='wiki' AND deleted_at IS NULL")).toBe(2);
    expect(await count("SELECT count(*) AS n FROM pages WHERE type='atom' AND source_id='derived'")).toBe(0);
    expect(await ledger()).toEqual([{ source_id: 'wiki', owner_key: `source_slug:${slug}` }]);
    expect(await countExtractAtomsBacklog(engine, 'wiki')).toBe(0);
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
  }, 120000);

  test('split config: discovery (with and without a slug filter), counts, second run and receipt', async () => {
    await setup(true);
    expect(await configuredWriteSource(engine, 'wiki')).toBe('derived');

    // Before any atom exists in derived: scoped and brain-wide counts both see the page; both discovery forms bind the write source.
    expect(await countExtractAtomsBacklog(engine, 'wiki')).toBe(1);
    expect(await countExtractAtomsBacklog(engine)).toBe(1);
    expect((await discoverExtractablePages(engine, 'wiki', undefined, 50, 'derived')).map(page => page.slug)).toEqual([slug]);
    expect((await discoverExtractablePages(engine, 'wiki', [slug], 50, 'derived')).map(page => page.slug)).toEqual([slug]);

    const first = await run();
    expect(first.result.status).toBe('ok');
    expect(first.calls).toBe(1);
    expect(await count("SELECT count(*) AS n FROM pages WHERE type='atom' AND source_id='derived' AND deleted_at IS NULL AND frontmatter->>'source_page_source_id' = 'wiki'")).toBe(2);
    expect(await count("SELECT count(*) AS n FROM pages WHERE type='atom' AND source_id='wiki'")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM pages WHERE type='extract_receipt' AND source_id='derived' AND frontmatter->>'written_to_source_id' = 'derived'")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM pages WHERE type='extract_receipt' AND source_id='wiki'")).toBe(0);
    expect(await ledger()).toEqual([{ source_id: 'derived', owner_key: `source_slug@wiki:${slug}` }]);

    // After: nothing left to do, in both count forms and both discovery forms; a second run makes no model call.
    expect(await countExtractAtomsBacklog(engine, 'wiki')).toBe(0);
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
    expect(await discoverExtractablePages(engine, 'wiki', undefined, 50, 'derived')).toEqual([]);
    expect(await discoverExtractablePages(engine, 'wiki', [slug], 50, 'derived')).toEqual([]);
    expect((await run()).calls).toBe(0);
    expect((await ledger()).length).toBe(1);
  }, 120000);

  test('a write source that is not registered is refused: no model call, nothing written', async () => {
    await setup(true);
    await engine.executeRaw("DELETE FROM sources WHERE id = 'derived'");
    const { result, calls } = await run();
    expect(result.status).toBe('fail');
    expect(result.error).toMatchObject({ class: 'ExtractAtomsWriteSource', code: 'write_source_missing' });
    expect(calls).toBe(0);
    expect(await count("SELECT count(*) AS n FROM pages WHERE type IN ('atom','extract_receipt')")).toBe(0);
    expect(await ledger()).toEqual([]);
  }, 120000);
});
