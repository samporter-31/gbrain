/**
 * #124 (PorterBrain "Trust the Brain" T1) — MCP page reads are default-scoped.
 *
 * `get_page` and `list_pages` exposed no per-call source parameter and resolved
 * their scope with `sourceScopeOpts(ctx)` alone. Every MCP transport pins
 * `ctx.sourceId` to `process.env.GBRAIN_SOURCE || 'default'`
 * (src/mcp/server.ts:49), so an agent asking the brain for a page living in a
 * NON-default partition got `page_not_found` while `get_stats` — which is
 * brain-wide — reported the page's partition as healthy and populated. Reads
 * and stats disagreed about what the brain contained, and that disagreement
 * produced two wrong diagnoses in the consuming repo.
 *
 * The federation itself was never missing: `GetPageOpts.sourceIds` and
 * `PageFilters.sourceIds` (src/core/types.ts) already apply
 * `WHERE source_id = ANY($N::text[])` in both engines, and
 * `resolveRequestedScope` (src/core/operations.ts) is already the single
 * trust+grant resolver for per-call `source_id` / `all_sources` — its own
 * docblock listed `get_page` as a caller while the handler used
 * `sourceScopeOpts`. This closes that drift rather than adding a second
 * federation mechanism.
 *
 * Covered here:
 *   - per-call `source_id` reaches a non-default partition on both ops
 *   - `__all__` / `all_sources` spans the brain for TRUSTED LOCAL callers only
 *   - a remote caller cannot use either lever to escape its federated grant
 *   - `list_pages` rows carry `source_id`, so a read can be reconciled against
 *     `get_stats` per partition instead of silently answering from one
 *   - the no-parameter path keeps its pre-#124 scoping (regression guard)
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const get_page = operations.find(o => o.name === 'get_page')!;
const list_pages = operations.find(o => o.name === 'list_pages')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    // Mirrors the stdio MCP transport: remote, pinned to 'default'.
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

/** Federated remote client: no scalar sourceId, grant carried by allowedSources. */
function remoteCtx(allowedSources: string[]): OperationContext {
  return ctxOf({
    remote: true,
    sourceId: undefined,
    auth: { token: 't', clientId: 'c', scopes: [], allowedSources } as any,
  });
}

/** Trusted local CLI caller (`gbrain call` / --source), pinned to 'default'. */
function localCtx(sourceId: string | undefined = 'default'): OperationContext {
  return ctxOf({ remote: false, sourceId });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', '/tmp/wiki') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('other', 'other', '/tmp/other') ON CONFLICT (id) DO NOTHING`);

  // The shape that produced the real defect: a page that exists ONLY in a
  // non-default partition, unreachable from a 'default'-pinned transport.
  await engine.putPage('meta/telos', {
    type: 'note', title: 'Telos (wiki)', compiled_truth: 'wiki-only content', frontmatter: {},
  }, { sourceId: 'wiki' });
  await engine.putPage('concepts/only-wiki', {
    type: 'note', title: 'Wiki concept', compiled_truth: 'wiki concept', frontmatter: {},
  }, { sourceId: 'wiki' });
  await engine.putPage('atoms/default-resident', {
    type: 'note', title: 'Default resident', compiled_truth: 'default content', frontmatter: {},
  }, { sourceId: 'default' });
  await engine.putPage('other/page', {
    type: 'note', title: 'Other page', compiled_truth: 'other content', frontmatter: {},
  }, { sourceId: 'other' });

  // The duplicate-slug condition. This is the COMMON case on the brain that
  // motivated #124 (586 slugs live in both the vault mirror and the DB-native
  // partition), and one of those partitions is a stale fossil. A cross-partition
  // read that silently picks one is the exact failure mode #124 exists to end.
  await engine.putPage('shared/dup', {
    type: 'note', title: 'Dup in wiki', compiled_truth: 'fresh wiki copy', frontmatter: {},
  }, { sourceId: 'wiki' });
  await engine.putPage('shared/dup', {
    type: 'note', title: 'Dup in default', compiled_truth: 'stale fossil copy', frontmatter: {},
  }, { sourceId: 'default' });
});

// ---------------------------------------------------------------------------
// get_page — per-call source scope
// ---------------------------------------------------------------------------

describe('#124 get_page accepts a per-call source_id', () => {
  test('THE DEFECT: a default-pinned transport cannot read a wiki-only slug without the param', async () => {
    await expect(get_page.handler(ctxOf(), { slug: 'meta/telos' }))
      .rejects.toBeInstanceOf(OperationError);
  });

  test('source_id reaches the non-default partition', async () => {
    const page: any = await get_page.handler(ctxOf(), { slug: 'meta/telos', source_id: 'wiki' });
    expect(page.title).toBe('Telos (wiki)');
    expect(page.source_id).toBe('wiki');
  });

  test("source_id: '__all__' spans every partition for a trusted local caller", async () => {
    const page: any = await get_page.handler(localCtx(), { slug: 'meta/telos', source_id: '__all__' });
    expect(page.title).toBe('Telos (wiki)');
  });

  test('all_sources: true is equivalent to __all__ for a trusted local caller', async () => {
    const page: any = await get_page.handler(localCtx(), { slug: 'meta/telos', all_sources: true });
    expect(page.title).toBe('Telos (wiki)');
  });

  test('no param → pre-#124 scoping is unchanged (regression guard)', async () => {
    const page: any = await get_page.handler(ctxOf(), { slug: 'atoms/default-resident' });
    expect(page.title).toBe('Default resident');
  });
});

describe('#124 a cross-partition read never silently picks one of two copies', () => {
  test('all_sources on a duplicated slug reports ambiguity instead of an arbitrary copy', async () => {
    // engine.getPage is `WHERE slug=$1 AND source_id = ANY(...) LIMIT 1` with no
    // ORDER BY, so without this guard the answer is whichever row Postgres hands
    // back first — stale fossil or fresh mirror, nondeterministically.
    const res: any = await get_page.handler(localCtx(), { slug: 'shared/dup', all_sources: true });
    expect(res.error).toBe('ambiguous_source');
    expect(res.candidates.map((c: any) => c.source_id).sort()).toEqual(['default', 'wiki']);
  });

  test('the ambiguity report names the disambiguating parameter', async () => {
    const res: any = await get_page.handler(localCtx(), { slug: 'shared/dup', source_id: '__all__' });
    expect(res.error).toBe('ambiguous_source');
    expect(String(res.suggestion)).toContain('source_id');
  });

  test('naming the partition resolves it to that exact copy', async () => {
    const wiki: any = await get_page.handler(ctxOf(), { slug: 'shared/dup', source_id: 'wiki' });
    expect(wiki.title).toBe('Dup in wiki');
    const dflt: any = await get_page.handler(ctxOf(), { slug: 'shared/dup', source_id: 'default' });
    expect(dflt.title).toBe('Dup in default');
  });

  test('a federated grant spanning only ONE holder of the slug is not ambiguous', async () => {
    const page: any = await get_page.handler(remoteCtx(['wiki', 'other']), { slug: 'shared/dup', all_sources: true });
    expect(page.title).toBe('Dup in wiki');
  });

  test('an unambiguous slug still resolves normally under all_sources', async () => {
    const page: any = await get_page.handler(localCtx(), { slug: 'meta/telos', all_sources: true });
    expect(page.title).toBe('Telos (wiki)');
  });

  test('the single-source path is untouched — no ambiguity check, no extra behaviour', async () => {
    const page: any = await get_page.handler(ctxOf(), { slug: 'atoms/default-resident' });
    expect(page.title).toBe('Default resident');
  });
});

describe('#124 get_page source_id cannot escape a federated grant', () => {
  test('remote client granted [other] is DENIED an explicit out-of-grant source_id', async () => {
    await expect(get_page.handler(remoteCtx(['other']), { slug: 'meta/telos', source_id: 'wiki' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
  });

  test("remote client's '__all__' collapses to its grant, not the whole brain", async () => {
    // Granted [other] only: __all__ must NOT surface the wiki page.
    await expect(get_page.handler(remoteCtx(['other']), { slug: 'meta/telos', source_id: '__all__' }))
      .rejects.toBeInstanceOf(OperationError);
  });

  test('remote client granted [wiki, other] CAN read the wiki page via __all__', async () => {
    const page: any = await get_page.handler(remoteCtx(['wiki', 'other']), { slug: 'meta/telos', source_id: '__all__' });
    expect(page.title).toBe('Telos (wiki)');
  });

  test('remote client granted [wiki] CAN name its own granted source explicitly', async () => {
    const page: any = await get_page.handler(remoteCtx(['wiki']), { slug: 'meta/telos', source_id: 'wiki' });
    expect(page.title).toBe('Telos (wiki)');
  });

  test('INHERITED: a caller with NO federated grant array is not restricted by source_id', async () => {
    // Documented here because it is a real property of the resolver, not an
    // oversight, and #124 widens the surface it applies to (page bodies +
    // enumeration, where before it was search results and code intel).
    //
    // resolveRequestedScope only enforces when `auth.allowedSources` is a
    // NON-EMPTY array. parseLegacyTokenScope maps a STRING `permissions.
    // source_id` grant to `{sourceId}` with no array, so a scalar-granted
    // legacy bearer token can name another partition. Upstream calls this the
    // "scalar-floor model" and pins it in test/source-scope-resolver.test.ts:79.
    //
    // It is deliberately NOT changed here: the resolver is shared with query /
    // search_by_image / code_*, so altering it is an upstream security-semantics
    // decision, not a #124 bug fix. Locking it per-handler instead would
    // reintroduce exactly the per-site drift the resolver exists to prevent.
    // If this posture is wrong, fix it once in resolveRequestedScope so every
    // op moves together.
    const scalarGranted = ctxOf({
      remote: true,
      sourceId: 'other',
      auth: { token: 't', clientId: 'c', scopes: [] } as any, // no allowedSources
    });
    const page: any = await get_page.handler(scalarGranted, { slug: 'meta/telos', source_id: 'wiki' });
    expect(page.title).toBe('Telos (wiki)');
  });
});

// ---------------------------------------------------------------------------
// list_pages — per-call source scope + per-row attribution
// ---------------------------------------------------------------------------

function slugsOf(rows: unknown): string[] {
  return (rows as Array<{ slug: string }>).map(r => r.slug).sort();
}

describe('#124 list_pages accepts a per-call source scope', () => {
  test('THE DEFECT: a default-pinned transport enumerates only the default partition', async () => {
    const rows = await list_pages.handler(ctxOf(), {});
    expect(slugsOf(rows)).toEqual(['atoms/default-resident', 'shared/dup']);
  });

  test('source_id enumerates a named non-default partition', async () => {
    const rows = await list_pages.handler(ctxOf(), { source_id: 'wiki' });
    expect(slugsOf(rows)).toEqual(['concepts/only-wiki', 'meta/telos', 'shared/dup']);
  });

  test("source_id: '__all__' enumerates across partitions for a trusted local caller", async () => {
    const rows = await list_pages.handler(localCtx(), { source_id: '__all__' });
    expect(slugsOf(rows)).toEqual([
      'atoms/default-resident', 'concepts/only-wiki', 'meta/telos',
      'other/page', 'shared/dup', 'shared/dup',
    ]);
  });

  test('all_sources: true is equivalent to __all__ for a trusted local caller', async () => {
    const rows = await list_pages.handler(localCtx(), { all_sources: true });
    expect(slugsOf(rows)).toHaveLength(6);
  });

  test('no param → pre-#124 scoping is unchanged (regression guard)', async () => {
    const rows = await list_pages.handler(ctxOf(), {});
    expect(slugsOf(rows)).toEqual(['atoms/default-resident', 'shared/dup']);
  });

  test('a duplicated slug appears once PER PARTITION, distinguishable by source_id', async () => {
    // list_pages is the disambiguation path get_page points callers at, so the
    // two copies must be separable here even though they share a slug.
    const rows = (await list_pages.handler(localCtx(), { all_sources: true })) as Array<{ slug: string; source_id: string }>;
    const dups = rows.filter(r => r.slug === 'shared/dup');
    expect(dups.map(r => r.source_id).sort()).toEqual(['default', 'wiki']);
  });
});

describe('#124 list_pages source scope cannot escape a federated grant', () => {
  test('remote client granted [other] is DENIED an explicit out-of-grant source_id', async () => {
    await expect(list_pages.handler(remoteCtx(['other']), { source_id: 'wiki' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
  });

  test("remote client's all_sources collapses to its grant, not the whole brain", async () => {
    const rows = await list_pages.handler(remoteCtx(['other']), { all_sources: true });
    expect(slugsOf(rows)).toEqual(['other/page']);
  });

  test('remote client granted [wiki, other] sees exactly its two partitions under all_sources', async () => {
    const rows = await list_pages.handler(remoteCtx(['wiki', 'other']), { all_sources: true });
    expect(slugsOf(rows)).toEqual(['concepts/only-wiki', 'meta/telos', 'other/page', 'shared/dup']);
    // the default-partition copy of the duplicated slug stays out of the grant
    const dups = (rows as Array<{ slug: string; source_id: string }>).filter(r => r.slug === 'shared/dup');
    expect(dups.map(r => r.source_id)).toEqual(['wiki']);
  });
});

describe('#124 list_pages rows carry source_id so a read reconciles against get_stats', () => {
  test('each row names the partition it came from', async () => {
    const rows = (await list_pages.handler(localCtx(), { all_sources: true })) as Array<{ slug: string; source_id: string }>;
    const bySlug = Object.fromEntries(rows.map(r => [r.slug, r.source_id]));
    expect(bySlug['meta/telos']).toBe('wiki');
    expect(bySlug['concepts/only-wiki']).toBe('wiki');
    expect(bySlug['atoms/default-resident']).toBe('default');
    expect(bySlug['other/page']).toBe('other');
  });

  test('per-partition counts from a cross-partition read match a per-partition read', async () => {
    // This is the reconciliation the defect made impossible: the brain-wide
    // enumeration and the scoped enumeration must agree per partition.
    const all = (await list_pages.handler(localCtx(), { all_sources: true })) as Array<{ source_id: string }>;
    const wikiFromAll = all.filter(r => r.source_id === 'wiki').length;
    const wikiScoped = (await list_pages.handler(ctxOf(), { source_id: 'wiki' })) as unknown[];
    expect(wikiFromAll).toBe(wikiScoped.length);
    expect(wikiFromAll).toBe(3);
  });
});
