/**
 * Real-Postgres parity for the maintenance paths around the extract_atoms read/write split (Codex review 2026-10-31,
 * findings 1-3). The PGLite twin lives in test/extract-atoms-write-source.test.ts; these queries use JSONB, COALESCE/NULLIF
 * and a text[] binding, which PGLite parses but the postgres.js wire path binds differently, so PGLite alone is not proof.
 *
 * One scripted scenario: split-extract wiki -> derived, then
 *   - visibility repair and the derived_visibility doctor find the world origin in wiki (finding 2);
 *   - the atom-provenance doctor finds it too (finding 3);
 *   - after the wiki page is deleted, stale-atoms retires the atoms under the qualified key with no second ledger (finding 1).
 * Skips gracefully when DATABASE_URL is unset.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { EXTRACT_ATOMS_WRITE_SOURCE_KEY } from '../../src/core/cycle/extract-atoms-write-source.ts';
import { staleAtomsRepair } from '../../src/core/repair/stale-atoms.ts';
import { planVisibilityRepair } from '../../src/core/repair/visibility.ts';
import { derivedVisibilityCheck } from '../../src/commands/doctor/checks/derived-visibility.ts';
import { computeAtomProvenanceDriftCheck } from '../../src/commands/doctor/checks/extraction-sync.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;
beforeAll(async () => { if (!skip) engine = (await setupDB()) as PostgresEngine; });
afterAll(async () => { if (!skip) await teardownDB(); });

const slug = 'meetings/example';
const body = 'Evidence about a synthetic example and its repeatable outcomes. '.repeat(20);
const atoms = JSON.stringify(['First synthetic atom', 'Second synthetic atom'].map(title => ({ title, atom_type: 'insight', body: `${title} evidence.` })));
const response = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
const ledger = () => engine.executeRaw<{ source_id: string; owner_key: string; state: string }>(
  "SELECT source_id, owner_key, state FROM derived_generations WHERE kind='atom' ORDER BY source_id, owner_key");
const liveAtoms = () => engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE type='atom' AND source_id='derived' AND deleted_at IS NULL");
const setVisibility = (sourceId: string, where: string, visibility: string, params: unknown[] = []) => engine.executeRaw(
  `UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('visibility', '${visibility}'::text) WHERE source_id = '${sourceId}' AND ${where}`, params);

describeIfDB('split maintenance paths on real Postgres', () => {
  test('visibility, provenance drift and stale-atoms all resolve the read-source origin', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('wiki','wiki'),('derived','derived') ON CONFLICT DO NOTHING");
    await engine.updateSourceConfig('wiki', { [EXTRACT_ATOMS_WRITE_SOURCE_KEY]: 'derived' });
    await engine.putPage(slug, { type: 'meeting', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} }, { sourceId: 'wiki' });
    const run = await runPhaseExtractAtoms(engine, { sourceId: 'wiki', _transcripts: [], _chat: async () => response(atoms) });
    expect(run.status).toBe('ok');
    expect((await liveAtoms()).length).toBe(2);
    expect(await ledger()).toEqual([{ source_id: 'derived', owner_key: `source_slug@wiki:${slug}`, state: 'live' }]);

    // Finding 3: a healthy split atom is not drifted or source-gone.
    expect((await computeAtomProvenanceDriftCheck(engine)).details).toMatchObject({ total_atoms: 2, drifted: 0, source_gone: 0 });

    // Finding 2: a world origin in wiki, world atoms in derived: nothing to tighten, nothing looser.
    await setVisibility('wiki', 'slug = $1', 'world', [slug]);
    await setVisibility('derived', "type = 'atom'", 'world');
    expect((await planVisibilityRepair(engine, ['derived'])).changes).toEqual([]);
    expect((await derivedVisibilityCheck(engine, 'derived')).details).toMatchObject({ looser_atoms: 0, unstamped_atoms: 0 });
    await setVisibility('wiki', 'slug = $1', 'private', [slug]);
    expect((await planVisibilityRepair(engine, ['derived'])).changes.length).toBe(2); // the join is not blind

    // Finding 1: the origin goes away; stale-atoms retires under the qualified key and makes no second lineage.
    await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE source_id = 'wiki' AND slug = $1", [slug]);
    expect((await computeAtomProvenanceDriftCheck(engine)).details).toMatchObject({ total_atoms: 2, drifted: 2, source_gone: 2 });
    const scope = { source_ids: ['derived'] } as never;
    const preview = await staleAtomsRepair.plan(engine, scope, null, { apply: false });
    expect(preview.items.length).toBe(2);
    const approved = await staleAtomsRepair.plan(engine, scope, null, { apply: true, expect: preview.preview_hash });
    const outcomes = [];
    for (const entry of approved.items) outcomes.push(await staleAtomsRepair.apply({ engine } as never, entry));
    expect(outcomes.map(outcome => (outcome as { outcome: string }).outcome)).toEqual(['retired', 'retired']);
    expect(await liveAtoms()).toEqual([]);
    expect((await ledger()).every(row => row.owner_key === `source_slug@wiki:${slug}`)).toBe(true);
  }, 120000);
});
