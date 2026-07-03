import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExportGenerated } from '../src/commands/export-generated.ts';

let engine: PGLiteEngine;
let tmp: string;
let outDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-exportgen-'));
  outDir = join(tmp, 'staging');
  const tables = ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages', 'sources'];
  for (const t of tables) {
    await (engine as unknown as { db: { exec(sql: string): Promise<unknown> } }).db.exec(`DELETE FROM ${t}`);
  }
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('default', 'Default') ON CONFLICT DO NOTHING`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('export-generated', () => {
  test('writes a generated concept to --to, stamped synthesis_origin: ai', async () => {
    await engine.putPage('concepts/desirable-difficulty', {
      title: 'desirable difficulty',
      type: 'concept',
      compiled_truth: 'Struggle aids retention.',
      frontmatter: { type: 'concept', synthesized_by: 'synthesize_concepts-v0.41' },
      timeline: '',
    });

    await runExportGenerated(engine, ['--to', outDir]);

    const file = join(outDir, 'concepts/desirable-difficulty.md');
    expect(existsSync(file)).toBe(true);
    const parsed = matter(readFileSync(file, 'utf8'));
    expect(parsed.data.synthesis_origin).toBe('ai');
    expect(parsed.content).toContain('Struggle aids retention.');
  });

  test('does NOT export a human concept (no synthesized_by)', async () => {
    await engine.putPage('concepts/hand-authored', {
      title: 'hand authored',
      type: 'concept',
      compiled_truth: 'Sam wrote this.',
      frontmatter: { type: 'concept' },
      timeline: '',
    });

    await runExportGenerated(engine, ['--to', outDir]);

    expect(existsSync(join(outDir, 'concepts/hand-authored.md'))).toBe(false);
  });

  test('skips a generated concept that already exists in a --skip-existing dir', async () => {
    await engine.putPage('concepts/already-live', {
      title: 'already live',
      type: 'concept',
      compiled_truth: 'Approved earlier.',
      frontmatter: { type: 'concept', synthesized_by: 'synthesize_concepts-v0.41' },
      timeline: '',
    });
    const liveDir = join(tmp, 'wiki-concepts');
    mkdirSync(join(liveDir, 'concepts'), { recursive: true });
    writeFileSync(join(liveDir, 'concepts/already-live.md'), '---\ntype: concept\n---\nlive\n');

    await runExportGenerated(engine, ['--to', outDir, '--skip-existing', liveDir]);

    expect(existsSync(join(outDir, 'concepts/already-live.md'))).toBe(false);
  });

  test('preserves an inline ## Takes fence in the exported markdown', async () => {
    const withFence = [
      'Struggle aids retention.',
      '',
      '## Takes',
      '',
      '<!--- gbrain:takes:begin -->',
      '| # | claim | kind | who | weight | since | source |',
      '|---|-------|------|-----|--------|-------|--------|',
      '| 1 | Struggle aids retention | take | sam | 0.8 | 2026-07 | |',
      '<!--- gbrain:takes:end -->',
    ].join('\n');
    await engine.putPage('concepts/with-takes', {
      title: 'with takes',
      type: 'concept',
      compiled_truth: withFence,
      frontmatter: { type: 'concept', synthesized_by: 'synthesize_concepts-v0.41' },
      timeline: '',
    });

    await runExportGenerated(engine, ['--to', outDir]);

    const md = readFileSync(join(outDir, 'concepts/with-takes.md'), 'utf8');
    expect(md).toContain('gbrain:takes:begin');
    expect(md).toContain('| 1 | Struggle aids retention |');
  });
});
