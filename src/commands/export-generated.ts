// export-generated: materialize AI-generated concept pages to a target folder
// as markdown, stamped `synthesis_origin: ai`. Mirrors runExport (export.ts) but
// filters to generated pages (frontmatter.synthesized_by set) and adds the stamp.
//
// Adaptation from the plan's raw `executeRaw<Page>('SELECT *')` approach: the
// jsonb `frontmatter` column comes back as a string on some engine/driver paths
// (see rowToPage in src/core/utils.ts, which JSON.parse()s a string frontmatter),
// so a raw SELECT * does NOT reliably yield a clean Page. Instead we SELECT only
// the matching slugs (the `synthesized_by` filter runs server-side in SQL, where
// jsonb `->>` is reliable) and then load each via engine.getPage(), which routes
// through rowToPage and guarantees parsed frontmatter / compiled_truth / timeline.
// This is exactly how runExport gets clean Page objects (via listPages → rowToPage).
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { serializeMarkdown } from '../core/markdown.ts';

export async function runExportGenerated(engine: BrainEngine, args: string[]) {
  const toIdx = args.indexOf('--to');
  const outDir = toIdx !== -1 ? args[toIdx + 1] : './_staging';

  const skipDirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skip-existing' && args[i + 1]) skipDirs.push(args[i + 1]);
  }
  skipDirs.push(outDir);

  // Filter server-side: generated concept pages carry a `synthesized_by`
  // frontmatter key. jsonb `->>` is reliable in SQL regardless of how the
  // driver marshals the column back to JS.
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages
       WHERE type = 'concept'
         AND deleted_at IS NULL
         AND (frontmatter->>'synthesized_by') IS NOT NULL
       ORDER BY slug`,
  );

  let written = 0;
  for (const { slug } of rows) {
    const rel = slug + '.md';
    if (skipDirs.some(d => existsSync(join(d, rel)))) continue;

    const page = await engine.getPage(slug);
    if (!page) continue; // race: page deleted between the SELECT and the read

    const tags = await engine.getTags(slug);
    const frontmatter = { ...page.frontmatter, synthesis_origin: 'ai' };
    const md = serializeMarkdown(frontmatter, page.compiled_truth, page.timeline, {
      type: page.type,
      title: page.title,
      tags,
    });

    const filePath = join(outDir, rel);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, md);
    written++;
  }

  console.log(`export-generated: wrote ${written} proposal(s) to ${outDir}`);
  return written;
}
