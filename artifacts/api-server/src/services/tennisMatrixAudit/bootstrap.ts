// ----------------------------------------------------------------------------
// TENNIS MATRIX AUDIT — definition bootstrap.
//
// The Audit cannot run one match without this. Its DEFINITION INSTANTIATION stage requires
// an ACTIVE rule-document version for each of METRICS, VERIFICATION and DISAGREEMENT, and
// refuses to proceed without them -- correctly, because a run with no rule set would be
// grading against nothing. So the three definition documents ship with the application and
// are parsed into rules here.
//
// WHAT THIS SEEDS, and why each is a DEFINITION rather than data:
//
//   Rule documents   The three frozen definition texts, parsed deterministically into
//                    rules. Every run clones the active version, which is what keeps a past
//                    run reproducible against the rules it actually ran under.
//   Source registry  Which sources the Audit may draw on, their precedence and reliability.
//                    Precedence is what decides which value wins when two sources disagree,
//                    so it is part of the evidence rules.
//   Calibration      The frozen baseline record (CALIBRATION_BUCKETS / MASTER_RECORD_START
//                    in the engine's constants) -- the eight WP bands and the historical
//                    record the Audit was defined with. This is a constant of the frozen
//                    engine, not a track record this installation accumulated, and grading
//                    a result advances from it rather than replacing it.
//
// Every step is guarded by "does this table already have rows", so running it again is a
// no-op. It never edits, replaces or renumbers anything already present: re-running after
// results have been graded must not roll calibration back to the baseline.
// ----------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";
import {
  activationStatus, parseRuleDocument, CALIBRATION_BUCKETS, DEFAULT_SOURCES,
  LOCAL_WORKSPACE_ID, MASTER_RECORD_START, SMALL_SAMPLE_THRESHOLD, INVALIDATED_RUN_STATUS,
} from "@workspace/truth-engine";

const USER = LOCAL_WORKSPACE_ID;

const SEED_DOCUMENTS = [
  { docType: "VERIFICATION", title: "Tennis Matrix — Full Verification Audit", file: "verification.txt" },
  { docType: "DISAGREEMENT", title: "Tennis Matrix — Disagreement / Trap Audit", file: "disagreement.txt" },
  { docType: "METRICS", title: "Tennis Matrix — Verification Metrics", file: "metrics.txt" },
];

/** Which audit_runs column records the version a run was built on, per document type. */
const RUN_VERSION_COLUMN: Record<string, string> = {
  VERIFICATION: "verification_version_id",
  DISAGREEMENT: "disagreement_version_id",
  METRICS: "metrics_version_id",
};

/**
 * The seed texts are read from disk at runtime rather than bundled, so the definition
 * documents stay diffable as documents. `seed/` sits beside this module in source and is
 * copied next to the bundle by build.mjs, so the same relative path resolves in both.
 */
function seedText(filename: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return readFileSync(join(here, "seed", filename), "utf8");
  } catch (error) {
    // Worth an explicit message: without these the Audit cannot activate a rule set, and
    // every match fails at DEFINITION INSTANTIATION rather than anywhere informative.
    throw new Error(
      `Definition document ${filename} is missing from the deployment (looked in ${join(here, "seed")}): ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export interface BootstrapReport {
  calibration: "seeded" | "already present";
  sources: "seeded" | "already present";
  documents: Array<{ docType: string; status: string; expected: number; parsed: number; activated: boolean }>;
}

async function hasRows(table: string): Promise<boolean> {
  const { rows } = await pool.query(`select 1 from ${table} limit 1`);
  return rows.length > 0;
}

async function seedCalibration(): Promise<BootstrapReport["calibration"]> {
  if (await hasRows("calibration_versions")) return "already present";

  const graded = CALIBRATION_BUCKETS.reduce((total, bucket) => total + bucket.graded, 0);
  const version = await pool.query(
    `insert into calibration_versions (user_id, version_number, label, master_sequence_count, graded_sample_count, is_active)
     values ($1, 1, $2, $3, $4, true) returning id`,
    [USER, `${MASTER_RECORD_START} Final Record — baseline`, MASTER_RECORD_START, graded],
  );
  const versionId = (version.rows[0] as { id: string }).id;

  for (const bucket of CALIBRATION_BUCKETS) {
    await pool.query(
      `insert into calibration_buckets
         (user_id, calibration_version_id, bucket_code, bucket_label, wp_min, wp_max, wins, graded, small_sample)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [USER, versionId, bucket.code, bucket.label, bucket.min, bucket.max, bucket.wins, bucket.graded,
       bucket.graded < SMALL_SAMPLE_THRESHOLD],
    );
  }
  return "seeded";
}

async function seedSources(): Promise<BootstrapReport["sources"]> {
  if (await hasRows("source_definitions")) return "already present";
  for (const source of DEFAULT_SOURCES) {
    await pool.query(
      `insert into source_definitions (user_id, source_name, domain, category, priority, reliability, supported_data)
       values ($1,$2,$3,$4,$5,$6,'{}')`,
      [USER, source.source_name, source.domain, source.category, source.priority, source.reliability],
    );
  }
  return "seeded";
}

/**
 * Parse one definition document into a new version and its rules.
 *
 * A version is activated ONLY if its parse is complete -- every rule the document declares
 * was actually mapped. A partially parsed version stays BLOCKED and inactive, which is what
 * stops a run silently grading against a rule set that is missing rules.
 */
export async function createDocumentVersion(options: {
  docType: string;
  title: string;
  filename: string;
  text: string;
  autoActivate?: boolean;
  documentId?: string;
}) {
  const report = parseRuleDocument(options.text);
  const status = activationStatus(report);

  let documentId = options.documentId;
  if (!documentId) {
    const document = await pool.query(
      `insert into rule_documents (user_id, doc_type, title) values ($1,$2,$3) returning id`,
      [USER, options.docType, options.title],
    );
    documentId = (document.rows[0] as { id: string }).id;
  }

  const prior = await pool.query(
    `select version_number from rule_document_versions where document_id = $1 order by version_number desc limit 1`,
    [documentId],
  );
  const versionNumber = Number((prior.rows[0] as { version_number?: number } | undefined)?.version_number ?? 0) + 1;

  const version = await pool.query(
    `insert into rule_document_versions
       (user_id, document_id, version_number, source_filename, raw_text, pages_detected, headings_detected,
        expected_rules, parsed_rules, unmapped_rules, parser_confidence, activation_status, is_active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false) returning id`,
    [
      USER, documentId, versionNumber, options.filename, options.text, report.pages_detected,
      report.headings_detected, report.expected_rules, report.parsed_rules, report.unmapped_rules,
      report.parser_confidence, status,
    ],
  );
  const versionId = (version.rows[0] as { id: string }).id;

  for (const rule of report.rules) {
    await pool.query(
      `insert into rules (user_id, version_id, rule_code, rule_name, body, severity, blocking, mapping_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [USER, versionId, rule.rule_code, rule.rule_name, rule.body, rule.severity, rule.blocking, rule.mapping_status],
    );
  }

  const activated = Boolean(options.autoActivate) && status === "READY";
  if (activated) await activateVersion(documentId, versionId, options.docType);

  return { documentId, versionId, report, status, activated };
}

/**
 * Make one version the active rule set, and invalidate any run built on a different one.
 *
 * The invalidation is the important half: a run graded under an older rule set is no longer
 * a current result, and leaving it on the slate would present it as one. It is marked stale,
 * never deleted -- it remains real history of what was decided under the rules of the day.
 */
export async function activateVersion(documentId: string, versionId: string, docType?: string) {
  await pool.query(`update rule_document_versions set is_active = false where document_id = $1`, [documentId]);
  await pool.query(`update rule_document_versions set is_active = true where id = $1`, [versionId]);
  await pool.query(`update rule_documents set active_version_id = $1 where id = $2`, [versionId, documentId]);

  const resolvedType =
    docType ??
    String(
      (await pool.query(`select doc_type from rule_documents where id = $1`, [documentId]))
        .rows[0]?.["doc_type"] ?? "",
    );
  const column = RUN_VERSION_COLUMN[resolvedType];
  if (!column) return;

  await pool.query(
    `update audit_runs set status = $1, stale_reason = $2
      where status in ('RUNNING', 'COMPLETE')
        and (${`"${column}"`} is distinct from $3)`,
    [INVALIDATED_RUN_STATUS, `${resolvedType} rule version changed`, versionId],
  );
}

/**
 * Bring a fresh database up to the point where the Audit can actually run.
 * Idempotent: every step is skipped when its table already has rows.
 */
export async function bootstrapAuditDefinitions(): Promise<BootstrapReport> {
  const calibration = await seedCalibration();
  const sources = await seedSources();

  const documents: BootstrapReport["documents"] = [];
  if (await hasRows("rule_documents")) {
    const { rows } = await pool.query(
      `select d.doc_type, v.activation_status, v.expected_rules, v.parsed_rules, v.is_active
         from rule_documents d
         left join rule_document_versions v on v.id = d.active_version_id`,
    );
    for (const row of rows as Array<Record<string, unknown>>) {
      documents.push({
        docType: String(row["doc_type"]),
        status: String(row["activation_status"] ?? "NO ACTIVE VERSION"),
        expected: Number(row["expected_rules"] ?? 0),
        parsed: Number(row["parsed_rules"] ?? 0),
        activated: row["is_active"] === true,
      });
    }
    return { calibration, sources, documents };
  }

  for (const seed of SEED_DOCUMENTS) {
    const result = await createDocumentVersion({
      docType: seed.docType,
      title: seed.title,
      filename: seed.file,
      text: seedText(seed.file),
      autoActivate: true,
    });
    documents.push({
      docType: seed.docType,
      status: result.status,
      expected: result.report.expected_rules,
      parsed: result.report.parsed_rules,
      activated: result.activated,
    });
  }

  return { calibration, sources, documents };
}
