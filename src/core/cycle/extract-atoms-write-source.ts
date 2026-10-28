/**
 * extract_atoms read/write split. `runPhaseExtractAtoms` used to read source pages AND write atoms, receipts and
 * generation-ledger rows under ONE source id. `sources.config.extract_atoms_write_source` on the READ source names a
 * different partition to write into (a `wiki` mirror whose atoms belong in `derived`). Unset, the write source is the
 * read source and nothing about the run changes.
 *
 * Resolved inside the phase, never at a call site: the cycle, the CLI/Minion drain, autopilot's auto-drain and the
 * stamp wrapper all reach `runPhaseExtractAtoms`, so none of them can route around the split.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { isMissingSchemaObject } from '../utils.ts';
import { SOURCE_ID_RE } from '../source-id.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';

/** `sources.config` key, set on the source pages are READ from. */
export const EXTRACT_ATOMS_WRITE_SOURCE_KEY = 'extract_atoms_write_source';

export { SOURCE_PAGE_SOURCE_ID_KEY } from '../generations/adapters/atoms.ts';

export type WriteSourceRefusalCode = 'invalid_write_source' | 'write_source_missing' | 'write_source_archived' | 'persistence_brain_enabled';

/** A configured split that cannot run. Loud by design: falling back to the read source would write where the operator redirected away from. */
export class ExtractAtomsWriteSourceError extends Error {
  constructor(readonly code: WriteSourceRefusalCode, message: string, readonly readSourceId: string, readonly writeSourceId: string) {
    super(message);
    this.name = 'ExtractAtomsWriteSourceError';
  }
}

export interface ExtractAtomsSources {
  /** Where pages are discovered and read, and where scan state, failure streaks and watermarks are keyed. */
  readSourceId: string;
  /** Where atoms, their provenance targets, receipts and generation-ledger rows are written. */
  writeSourceId: string;
  split: boolean;
}

/** The configured write source of `readSourceId`, or `readSourceId` itself. No validation: backlog counts use it, and a count never refuses. */
export async function configuredWriteSource(engine: BrainEngine, readSourceId: string): Promise<string> {
  let rows: Array<{ config: unknown }>;
  try {
    rows = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [readSourceId]);
  } catch (err) {
    if (isMissingSchemaObject(err, 'table', 'sources')) return readSourceId;
    throw err; // an unreadable config must not silently turn into "write where we read"
  }
  const raw = rows[0] ? parseSourceConfig(rows[0].config)[EXTRACT_ATOMS_WRITE_SOURCE_KEY] : undefined;
  const configured = typeof raw === 'string' ? raw.trim() : '';
  return configured === '' ? readSourceId : configured;
}

/**
 * Resolve and validate the split for one run. Throws ExtractAtomsWriteSourceError when a split is configured and
 * cannot run: an invalid or unregistered or archived target, or managed persistence on (its session, owner and
 * authority checks assume one source).
 */
export async function resolveExtractAtomsSources(engine: BrainEngine, readSourceId: string): Promise<ExtractAtomsSources> {
  const writeSourceId = await configuredWriteSource(engine, readSourceId);
  if (writeSourceId === readSourceId) return { readSourceId, writeSourceId, split: false };
  const refuse = (code: WriteSourceRefusalCode, message: string) => new ExtractAtomsWriteSourceError(code, message, readSourceId, writeSourceId);
  if (!SOURCE_ID_RE.test(writeSourceId)) {
    throw refuse('invalid_write_source', `sources.config.${EXTRACT_ATOMS_WRITE_SOURCE_KEY} on source ${readSourceId} is "${writeSourceId}", which is not a valid source id. Nothing was extracted.`);
  }
  if (await managedPersistenceEnabled(engine)) {
    throw refuse('persistence_brain_enabled', `Source ${readSourceId} sets ${EXTRACT_ATOMS_WRITE_SOURCE_KEY}=${writeSourceId}, but managed persistence (persistence_brain.enabled) is on and its atom session assumes one source. Nothing was extracted.`);
  }
  const [target] = await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id = $1', [writeSourceId]);
  if (!target) throw refuse('write_source_missing', `Source ${readSourceId} sets ${EXTRACT_ATOMS_WRITE_SOURCE_KEY}=${writeSourceId}, but no source ${writeSourceId} is registered. Nothing was extracted.`);
  if (target.archived) throw refuse('write_source_archived', `Source ${readSourceId} sets ${EXTRACT_ATOMS_WRITE_SOURCE_KEY}=${writeSourceId}, which is archived. Nothing was extracted.`);
  return { readSourceId, writeSourceId, split: true };
}

/**
 * SQL for the write source of the page row aliased `pageAlias`, for brain-wide counts that cannot resolve it in JS:
 * the configured key if set and non-blank, else the page's own source.
 */
export function writeSourceSql(pageAlias: string): string {
  return `COALESCE(NULLIF(btrim((SELECT s.config->>'${EXTRACT_ATOMS_WRITE_SOURCE_KEY}' FROM sources s WHERE s.id = ${pageAlias}.source_id)), ''), ${pageAlias}.source_id)`;
}

/** The phase's result for a refused split: failed, loud, nothing read from a provider and nothing written. */
export function writeSourceRefusalResult(err: ExtractAtomsWriteSourceError, dryRun: boolean): PhaseResult {
  console.error(`[extract_atoms] ${err.message}`);
  return {
    phase: 'extract_atoms', status: 'fail', duration_ms: 0, summary: `extract_atoms: refused: ${err.message}`,
    error: { class: 'ExtractAtomsWriteSource', code: err.code, message: err.message,
      hint: `Unset sources.config.${EXTRACT_ATOMS_WRITE_SOURCE_KEY} on source ${err.readSourceId}, or resolve the cause above.` },
    details: { reason: err.code, source_id: err.readSourceId, write_source_id: err.writeSourceId, atoms_extracted: 0, transcripts_processed: 0,
      pages_processed: 0, duplicates_skipped: 0, failures: [], estimated_spend_usd: 0, dry_run: dryRun },
  };
}
