/**
 * extract_atoms read/write split: `sources.config.extract_atoms_write_source` on the READ source redirects atoms,
 * receipts and generation-ledger rows to another partition while pages are still read from the first.
 * Driven end to end through runPhaseExtractAtoms on PGLite with a stubbed model.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { countExtractAtomsBacklog, discoverExtractablePages, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { runPhaseExtractAtomsStamped } from '../src/core/cycle/extract-atoms-stamp.ts';
import { runExtractAtomsDrainForSource, structuralAtomRefusal } from '../src/core/cycle/extract-atoms-drain.ts';
import { configuredWriteSource, EXTRACT_ATOMS_WRITE_SOURCE_KEY, ExtractAtomsWriteSourceError, resolveExtractAtomsSources } from '../src/core/cycle/extract-atoms-write-source.ts';
import { atomOwnerKey } from '../src/core/generations/adapters/atoms.ts';
import { staleAtomsRepair } from '../src/core/repair/stale-atoms.ts';
import { planVisibilityRepair } from '../src/core/repair/visibility.ts';
import { derivedVisibilityCheck } from '../src/commands/doctor/checks/derived-visibility.ts';
import { computeAtomProvenanceDriftCheck } from '../src/commands/doctor/checks/extraction-sync.ts';
import { privatePagesFilterFragment } from '../src/core/search/private-visibility.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const body = 'Evidence about a synthetic example and its repeatable outcomes. '.repeat(20);
const slug = 'meetings/example';
const response = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
const atomsFor = (...titles: string[]) => JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `${title} evidence.` })));
const FIRST = atomsFor('First synthetic atom', 'Second synthetic atom');

async function addSource(id: string, config: Record<string, unknown> = {}) {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [id]);
  if (Object.keys(config).length) await engine.updateSourceConfig(id, config);
}
async function seed(sourceId: string, pageSlug = slug, text = body) {
  await engine.putPage(pageSlug, { type: 'meeting', title: 'Example', compiled_truth: text, timeline: '', frontmatter: {} }, { sourceId });
}
async function run(sourceId: string, text: string, extra: Record<string, unknown> = {}) {
  let calls = 0;
  const result = await runPhaseExtractAtoms(engine, { sourceId, _transcripts: [], _chat: async () => { calls++; return response(text); }, ...extra });
  return { result, calls };
}
const liveAtoms = (sourceId: string) => engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown> }>(
  "SELECT slug, frontmatter FROM pages WHERE type='atom' AND source_id=$1 AND deleted_at IS NULL ORDER BY slug", [sourceId]);
const receipts = (sourceId: string) => engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown> }>(
  "SELECT slug, frontmatter FROM pages WHERE type='extract_receipt' AND source_id=$1 ORDER BY slug", [sourceId]);
const ledger = () => engine.executeRaw<{ source_id: string; owner_key: string; state: string }>(
  "SELECT source_id, owner_key, state FROM derived_generations WHERE kind='atom' ORDER BY source_id, owner_key");

describe('unset config: behaviour unchanged', () => {
  test('atoms, receipt and ledger stay in the source that was read, with the unqualified owner key', async () => {
    await addSource('wiki');
    await addSource('derived');
    await seed('wiki');
    const { result, calls } = await run('wiki', FIRST);
    expect(result.status).toBe('ok');
    expect(calls).toBe(1);
    expect((await liveAtoms('wiki')).length).toBe(2);
    expect(await liveAtoms('derived')).toEqual([]);
    expect((await receipts('wiki')).length).toBe(1);
    expect(await receipts('derived')).toEqual([]);
    expect(await ledger()).toEqual([{ source_id: 'wiki', owner_key: `source_slug:${slug}`, state: 'live' }]);
    for (const atom of await liveAtoms('wiki')) expect(atom.frontmatter).not.toHaveProperty('source_page_source_id');
    expect(result.details).not.toHaveProperty('write_source_id');
    expect((await receipts('wiki'))[0]!.frontmatter).not.toHaveProperty('written_to_source_id');
  });

  test('a blank or self-referencing value is no split', async () => {
    await addSource('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: '  ' });
    expect(await configuredWriteSource(engine, 'wiki')).toBe('wiki');
    await engine.updateSourceConfig('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'wiki' });
    expect(await resolveExtractAtomsSources(engine, 'wiki')).toEqual({ readSourceId: 'wiki', writeSourceId: 'wiki', split: false });
  });

  test('the discovery query for an unsplit source is the same text it always was (write source is $1)', async () => {
    await seed('default');
    const seen: string[] = [];
    const spy = new Proxy(engine, { get: (target, prop, receiver) => prop === 'executeRaw'
      ? (sql: string, params?: unknown[], opts?: unknown) => { seen.push(sql); return target.executeRaw(sql, params, opts as never); }
      : Reflect.get(target, prop, receiver) });
    await discoverExtractablePages(spy as PGLiteEngine, 'default');
    const discovery = seen.find(sql => sql.includes('SELECT p.id, p.knowledge_revision'))!;
    expect(discovery).toContain('AND atom.source_id = $1');
  });
});

describe('split config: wiki is read, derived is written', () => {
  beforeEach(async () => {
    await addSource('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
    await addSource('derived');
    await seed('wiki');
  });

  test('atoms, receipts and the ledger land in the write source; the read source is untouched', async () => {
    const before = (await engine.readPageSnapshot(slug, { sourceId: 'wiki' }))!;
    const { result, calls } = await run('wiki', FIRST);
    expect(result.status).toBe('ok');
    expect(calls).toBe(1);

    const atoms = await liveAtoms('derived');
    expect(atoms.length).toBe(2);
    expect(await liveAtoms('wiki')).toEqual([]);
    for (const atom of atoms) {
      expect(atom.frontmatter.source_slug).toBe(slug);
      expect(atom.frontmatter.source_page_source_id).toBe('wiki');
      expect(String(atom.frontmatter.source_hash)).not.toMatch(/^pending:/); // the completion flip ran
    }

    const written = await receipts('derived');
    expect(written.length).toBe(1);
    expect(await receipts('wiki')).toEqual([]);
    expect(written[0]!.frontmatter).toMatchObject({ source_id: 'wiki', written_to_source_id: 'derived', kind: 'atoms' });
    expect(written[0]!.slug).toContain('/atoms/wiki/'); // the label is still the source that was read

    expect(await ledger()).toEqual([{ source_id: 'derived', owner_key: `source_slug@wiki:${slug}`, state: 'live' }]);

    // Provenance edges run from the read-source page to the write-source atoms.
    const edges = await engine.executeRaw<{ from_source: string; to_source: string }>(
      `SELECT f.source_id AS from_source, t.source_id AS to_source FROM links l
         JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id WHERE l.link_source = 'atom-provenance'`);
    expect(edges.length).toBe(2);
    expect(edges.every(edge => edge.from_source === 'wiki' && edge.to_source === 'derived')).toBe(true);

    // Reads are unaffected: same page row, same hash, scan state keyed to the read-source page.
    const after = (await engine.readPageSnapshot(slug, { sourceId: 'wiki' }))!;
    expect(after.page.content_hash).toBe(before.page.content_hash);
    expect(after.page.frontmatter).toEqual(before.page.frontmatter);
    expect(result.details).toMatchObject({ source_id: 'wiki', write_source_id: 'derived', pages_processed: 1 });
  });

  test('a second run extracts nothing: discovery and the backlog count both look in the write source', async () => {
    expect(await countExtractAtomsBacklog(engine, 'wiki')).toBe(1);
    expect(await countExtractAtomsBacklog(engine)).toBe(1);
    await run('wiki', FIRST);
    expect(await countExtractAtomsBacklog(engine, 'wiki')).toBe(0);
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
    expect(await discoverExtractablePages(engine, 'wiki', undefined, 50, 'derived')).toEqual([]);
    const again = await run('wiki', FIRST);
    expect(again.calls).toBe(0);
    expect((await liveAtoms('derived')).length).toBe(2);
    expect((await ledger()).length).toBe(1);
  });

  test('an edited page is re-extracted into the write source and retires only its own atoms there', async () => {
    await run('wiki', FIRST);
    await engine.putPage(slug, { type: 'meeting', title: 'Example', compiled_truth: body + 'Edited.', timeline: '', frontmatter: {} }, { sourceId: 'wiki' });
    expect(await countExtractAtomsBacklog(engine, 'wiki')).toBe(1);
    const second = await run('wiki', atomsFor('First synthetic atom', 'Third synthetic atom'));
    expect(second.calls).toBe(1);
    const titles = (await engine.executeRaw<{ title: string }>("SELECT title FROM pages WHERE type='atom' AND source_id='derived' AND deleted_at IS NULL ORDER BY title")).map(row => row.title);
    expect(titles).toEqual(['First synthetic atom', 'Third synthetic atom']);
    expect(await liveAtoms('wiki')).toEqual([]);
  });

  test('atoms already sitting in the READ source do not satisfy the guard (they are not in the write source)', async () => {
    // A legacy atom in wiki carrying the page's current hash, as the 0.60 auto-drain left them.
    const page = (await engine.readPageSnapshot(slug, { sourceId: 'wiki' }))!.page;
    await engine.executeRaw(
      `INSERT INTO pages(source_id, slug, type, title, compiled_truth, frontmatter, content_hash)
       VALUES ('wiki','atoms/legacy','atom','Legacy',$2,$1::jsonb,'x')`,
      [JSON.stringify({ source_slug: slug, source_hash: String(page.content_hash).slice(0, 16) }), 'legacy body']);
    expect(await countExtractAtomsBacklog(engine, 'wiki')).toBe(1);
    expect((await discoverExtractablePages(engine, 'wiki', undefined, 50, 'derived')).map(found => found.slug)).toEqual([slug]);
  });

  test('the stamp wrapper records the READ source as the one that ran', async () => {
    const result = await runPhaseExtractAtomsStamped(engine, { sourceId: 'wiki', _transcripts: [], _chat: async () => response(FIRST) });
    expect(result.status).toBe('ok');
    const [wiki] = await engine.executeRaw<{ config: Record<string, unknown> }>("SELECT config FROM sources WHERE id='wiki'");
    const [derived] = await engine.executeRaw<{ config: Record<string, unknown> }>("SELECT config FROM sources WHERE id='derived'");
    expect(wiki!.config).toHaveProperty('last_extract_atoms_at');
    expect(derived!.config).not.toHaveProperty('last_extract_atoms_at');
  });

  test('a dry run reports the write source and writes nothing', async () => {
    const { result } = await run('wiki', FIRST, { dryRun: true });
    expect(result.details).toMatchObject({ write_source_id: 'derived', dry_run: true });
    expect(await liveAtoms('derived')).toEqual([]);
    expect(await ledger()).toEqual([]);
  });
});

describe('ledger owner-key separation', () => {
  test('the same page slug read from two sources into one target gets two keys, and neither retires the other', async () => {
    await addSource('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
    await addSource('other', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
    await addSource('derived');
    await seed('wiki');
    await seed('other', slug, body + 'A different page that happens to share the slug.');
    await run('wiki', atomsFor('Wiki-only atom'));
    await run('other', atomsFor('Other-only atom'));
    expect(await ledger()).toEqual([
      { source_id: 'derived', owner_key: `source_slug@other:${slug}`, state: 'live' },
      { source_id: 'derived', owner_key: `source_slug@wiki:${slug}`, state: 'live' },
    ]);
    const titles = (await engine.executeRaw<{ title: string }>("SELECT title FROM pages WHERE type='atom' AND source_id='derived' AND deleted_at IS NULL ORDER BY title")).map(row => row.title);
    expect(titles).toEqual(['Other-only atom', 'Wiki-only atom']);
  });

  test('two read sources producing the same atom slug fail closed instead of merging', async () => {
    await addSource('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
    await addSource('other', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
    await addSource('derived');
    await seed('wiki');
    await seed('other', slug, body + 'A different page that happens to share the slug.');
    await run('wiki', atomsFor('Shared title'));
    const { result } = await run('other', atomsFor('Shared title'));
    expect(result.status).toBe('warn');
    expect(JSON.stringify(result.details.failures)).toContain('atom identity conflict');
    const [atom] = await liveAtoms('derived');
    expect(atom!.frontmatter.source_page_source_id).toBe('wiki');
  });

  test('byte-identical pages in two read sources are extracted once: the hash guard is per write source', async () => {
    await addSource('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
    await addSource('other', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
    await addSource('derived');
    await seed('wiki');
    await seed('other');
    await run('wiki', FIRST);
    const second = await run('other', FIRST);
    expect(second.calls).toBe(0);
    expect((await liveAtoms('derived')).length).toBe(2);
  });

  test('owner keys: unsplit is unchanged, split names its read source', () => {
    expect(atomOwnerKey({ kind: 'page', slug: 'a/b' })).toBe('source_slug:a/b');
    expect(atomOwnerKey({ kind: 'page', slug: 'a/b', readSourceId: 'wiki' })).toBe('source_slug@wiki:a/b');
    expect(atomOwnerKey({ kind: 'page', slug: 'a:b', readSourceId: 'wiki' })).toBe('source_slug@wiki:a:b'); // a slug may hold ':'; a source id cannot
  });
});

describe('refusals are loud, spend nothing and write nothing', () => {
  async function expectRefusal(code: string) {
    let calls = 0;
    const result = await runPhaseExtractAtoms(engine, { sourceId: 'wiki', _transcripts: [], _chat: async () => { calls++; return response(FIRST); } });
    expect(result.status).toBe('fail');
    expect(result.error).toMatchObject({ class: 'ExtractAtomsWriteSource', code });
    expect(result.details).toMatchObject({ reason: code, atoms_extracted: 0, estimated_spend_usd: 0 });
    expect(calls).toBe(0);
    expect(await liveAtoms('wiki')).toEqual([]);
    expect(await liveAtoms('derived')).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(await receipts('wiki')).toEqual([]);
    expect(await receipts('derived')).toEqual([]);
    return result;
  }

  test('persistence_brain.enabled refuses the split', async () => {
    await addSource('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
    await addSource('derived');
    await seed('wiki');
    await engine.executeRaw('UPDATE persistence_brain SET enabled = true');
    try { await expectRefusal('persistence_brain_enabled'); }
    finally { await engine.executeRaw('UPDATE persistence_brain SET enabled = false'); }
  });

  test('a write source that is not registered refuses the split', async () => {
    await addSource('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
    await seed('wiki');
    const result = await expectRefusal('write_source_missing');
    expect(result.summary).toContain('derived');
  });

  test('an archived write source refuses the split', async () => {
    await addSource('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
    await addSource('derived');
    await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'derived'");
    await seed('wiki');
    await expectRefusal('write_source_archived');
  });

  test('a value that is not a source id refuses the split', async () => {
    await addSource('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'Not A Source/../x' });
    await seed('wiki');
    await expectRefusal('invalid_write_source');
  });

  test('resolveExtractAtomsSources throws the typed error', async () => {
    await addSource('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
    await expect(resolveExtractAtomsSources(engine, 'wiki')).rejects.toBeInstanceOf(ExtractAtomsWriteSourceError);
  });

  test('the drain stops with a structural refusal; it does not report a quiet zero-progress batch', async () => {
    await addSource('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' }); // derived never registered
    await seed('wiki');
    let error: unknown;
    try { await runExtractAtomsDrainForSource(engine, { sourceId: 'wiki', windowSeconds: 5, maxBatches: 2 }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ExtractAtomsWriteSourceError);
    expect(structuralAtomRefusal(error)).toMatch(/^structural_refusal: write_source_missing: /);
    expect(await liveAtoms('wiki')).toEqual([]);
  });
});

describe('the other places that assume an atom\'s origin page is in the atom\'s own source', () => {
  beforeEach(async () => {
    await addSource('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
    await addSource('derived');
    await seed('wiki');
    await run('wiki', FIRST);
  });
  const stalePreview = async () => (await staleAtomsRepair.plan(engine, { source_ids: ['derived'] } as never, null, { apply: false })).listing ?? [];

  test('stale-atoms repair finds the origin page in the read source: no derived atom is "origin_gone"', async () => {
    expect(await stalePreview()).toEqual([]);
  });

  test('...and it still flags them when the read-source page really is gone (the join is not blind)', async () => {
    await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE source_id = 'wiki' AND slug = $1", [slug]);
    const listing = await stalePreview();
    expect(listing.length).toBe(2);
    expect(listing.every(entry => entry.class === 'origin_gone')).toBe(true);
  });

  test('a later private flip of the read-source page still hides the derived atoms', async () => {
    await engine.executeRaw("UPDATE pages SET frontmatter = frontmatter || '{\"visibility\":\"world\"}'::jsonb WHERE source_id = 'derived' AND type = 'atom'");
    const visible = () => engine.executeRaw<{ slug: string }>(`SELECT p.slug FROM pages p WHERE p.source_id = 'derived' AND p.type = 'atom' AND ${privatePagesFilterFragment('p')}`);
    expect((await visible()).length).toBe(2);
    await engine.executeRaw("UPDATE pages SET frontmatter = frontmatter || '{\"visibility\":\"private\"}'::jsonb WHERE source_id = 'wiki' AND slug = $1", [slug]);
    expect(await visible()).toEqual([]);
  });

  // Codex review 2026-10-31 (findings 1-3): maintenance paths that looked for the origin page in the atom's own source.
  const setVisibility = async (sourceId: string, where: string, visibility: string, params: unknown[] = []) =>
    engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('visibility', '${visibility}'::text) WHERE source_id = '${sourceId}' AND ${where}`, params);
  const worldOriginWorldAtoms = async () => {
    await setVisibility('wiki', 'slug = $1', 'world', [slug]);
    await setVisibility('derived', "type = 'atom'", 'world');
  };

  test('visibility repair does not tighten a world derived atom whose world origin is in the read source (finding 2)', async () => {
    await worldOriginWorldAtoms();
    expect((await planVisibilityRepair(engine, ['derived'])).changes).toEqual([]);
  });

  test('...and does tighten it once that read-source origin turns private (the join is not blind)', async () => {
    await worldOriginWorldAtoms();
    await setVisibility('wiki', 'slug = $1', 'private', [slug]);
    const { changes } = await planVisibilityRepair(engine, ['derived']);
    expect(changes.length).toBe(2);
    expect(changes.every(change => change.source_id === 'derived' && change.to === 'private')).toBe(true);
  });

  test('derived_visibility doctor counts no looser atoms for a world origin in the read source (finding 2)', async () => {
    await worldOriginWorldAtoms();
    const check = await derivedVisibilityCheck(engine, 'derived');
    expect(check.details).toMatchObject({ looser_atoms: 0, unstamped_atoms: 0 });
  });

  test('atom_provenance_drift does not report a split atom as drifted or source-gone (finding 3)', async () => {
    const check = await computeAtomProvenanceDriftCheck(engine);
    expect(check.details).toMatchObject({ total_atoms: 2, drifted: 0, source_gone: 0 });
  });

  test('...and still reports it source-gone once the read-source page is deleted', async () => {
    await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE source_id = 'wiki' AND slug = $1", [slug]);
    const check = await computeAtomProvenanceDriftCheck(engine);
    expect(check.details).toMatchObject({ total_atoms: 2, drifted: 2, source_gone: 2 });
  });

  test('stale-atoms apply retires a split atom under its qualified owner key and makes no second ledger lineage (finding 1)', async () => {
    await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE source_id = 'wiki' AND slug = $1", [slug]);
    const scope = { source_ids: ['derived'] } as never;
    const preview = await staleAtomsRepair.plan(engine, scope, null, { apply: false });
    expect(preview.items.length).toBe(2);
    const approved = await staleAtomsRepair.plan(engine, scope, null, { apply: true, expect: preview.preview_hash });
    const outcomes = [];
    for (const entry of approved.items) outcomes.push(await staleAtomsRepair.apply({ engine } as never, entry));
    expect(outcomes.map(outcome => (outcome as { outcome: string }).outcome)).toEqual(['retired', 'retired']);
    expect(await liveAtoms('derived')).toEqual([]);
    expect((await ledger()).every(row => row.owner_key === `source_slug@wiki:${slug}`)).toBe(true);
  });

  test('stale-atoms preview carries the origin source, so an apply under it is bound to the read source (finding 1)', async () => {
    await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE source_id = 'wiki' AND slug = $1", [slug]);
    const { items } = await staleAtomsRepair.plan(engine, { source_ids: ['derived'] } as never, null, { apply: false });
    expect(items.every(entry => (entry as unknown as { atom: { origin_source_id: string } }).atom.origin_source_id === 'wiki')).toBe(true);
  });
});
