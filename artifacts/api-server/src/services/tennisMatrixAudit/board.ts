// ----------------------------------------------------------------------------
// TENNIS MATRIX AUDIT — the master ranked board.
//
// One combined ranking of every match that reached a final decision. The sort is fixed and
// is the point of the page: FINAL AUDIT COLOUR first, then the calibration bucket's verified
// win rate. Never the Matrix's own stated win probability -- that figure is shown beside
// each row as a claim to be judged, not as the thing doing the ranking.
//
// Assembled server-side rather than in the browser so the board reuses the SAME definitions
// of "current run" and "on the slate" as every other operational view (currentAuditRows and
// activeSlateMatchIds, straight from the engine). A cleared match or an invalidated run must
// disappear from the board immediately; re-deriving that here by hand is how a board starts
// quietly ranking rows that no longer exist.
// ----------------------------------------------------------------------------
import { pool } from "@workspace/db";
import { activeSlateMatchIds, currentAuditRows } from "@workspace/truth-engine";

/** Sort order for the audit colours. Rows outside it (INCOMPLETE) rank last. */
export const COLOR_ORDER = ["DOUBLE GREEN", "GREEN", "YELLOW", "RED / PASS", "INSUFFICIENT EVIDENCE", "INCOMPLETE"];

export interface BoardRow {
  matchId: string;
  matchLabel: string;
  /** The persisted decision's own selection. Never parsed back out of the action string. */
  selection: string | null;
  tournament: string | null;
  surface: string | null;
  matrixPick: string | null;
  matrixWp: string | null;
  bucket: string | null;
  verifiedWinRate: number | null;
  independentWinner: string | null;
  independentRange: string | null;
  calibratedRange: string | null;
  evidence: number;
  color: string;
  action: string | null;
  completion: number;
}

type Row = Record<string, unknown>;

const str = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);

const range = (low: unknown, high: unknown): string | null =>
  low === null || low === undefined || high === null || high === undefined ? null : `${low}–${high}%`;

export async function readBoard(): Promise<BoardRow[]> {
  const [decisions, runs, matches, fields, versions] = await Promise.all([
    pool.query(`select audit_run_id, final_selection, final_audit_color, action, audit_complete,
                       completion_percent, calibration_bucket, verified_win_rate, gate_report
                  from final_decisions`),
    pool.query(`select id, match_id, run_number, status, independent_winner, independent_low, independent_high,
                       calibrated_low, calibrated_high, effective_evidence_count,
                       independent_decision_committed_at, heartbeat_at
                  from audit_runs`),
    pool.query(`select id, player1_name, player2_name, tournament_name, surface from matches`),
    pool.query(`select summary_version_id, field_key, normalized_value from parsed_summary_fields`),
    pool.query(`select id, match_id, is_active from summary_versions`),
  ]);

  const onSlate = activeSlateMatchIds(versions.rows as never);
  const activeMatches = (matches.rows as Row[]).filter((match) => onSlate.has(String(match["id"])));

  const activeVersionByMatch = new Map(
    (versions.rows as Row[]).filter((v) => v["is_active"] === true).map((v) => [String(v["match_id"]), String(v["id"])]),
  );
  const matrixField = (matchId: string, key: string): string | null => {
    const versionId = activeVersionByMatch.get(matchId);
    if (!versionId) return null;
    const field = (fields.rows as Row[]).find(
      (f) => String(f["summary_version_id"]) === versionId && f["field_key"] === key,
    );
    return str(field?.["normalized_value"]);
  };

  return currentAuditRows(activeMatches as never, runs.rows as never, decisions.rows as never)
    .filter((entry) => entry.decision)
    .map(({ match, run, decision }) => {
      const m = match as unknown as Row;
      const r = (run ?? {}) as unknown as Row;
      const d = decision as unknown as Row;
      const matchId = String(m["id"]);

      // The range frozen into the decision at the time it was made, if one was stored.
      // Preferred over the run's live columns so a row cannot silently re-baseline when a
      // later grading changes the bucket it was calibrated against.
      const snapshot = (d["gate_report"] as { calibration_snapshot?: Record<string, unknown> } | null)
        ?.calibration_snapshot;
      const frozen = range(snapshot?.["calibratedLow"], snapshot?.["calibratedHigh"]);

      return {
        matchId,
        matchLabel: `${m["player1_name"]} vs ${m["player2_name"]}`,
        selection:
          str(d["final_selection"]) ??
          (d["gate_report"] as { deterministic_decision?: { selected_player?: string | null } } | null)
            ?.deterministic_decision?.selected_player ??
          null,
        tournament: str(m["tournament_name"]),
        surface: str(m["surface"]),
        matrixPick: matrixField(matchId, "matrix_predicted_winner"),
        matrixWp: matrixField(matchId, "matrix_wp"),
        bucket: str(d["calibration_bucket"]),
        verifiedWinRate: d["verified_win_rate"] === null || d["verified_win_rate"] === undefined
          ? null : Number(d["verified_win_rate"]),
        independentWinner: str(r["independent_winner"]),
        independentRange: range(r["independent_low"], r["independent_high"]),
        calibratedRange: frozen ?? range(r["calibrated_low"], r["calibrated_high"]),
        evidence: Number(r["effective_evidence_count"] ?? 0),
        // A decision that has not completed ranks as INCOMPLETE regardless of the colour it
        // has reached so far: an unfinished audit must never rank beside a finished one.
        color: d["audit_complete"] ? String(d["final_audit_color"]) : "INCOMPLETE",
        action: str(d["action"]),
        completion: Number(d["completion_percent"] ?? 0),
      };
    })
    .sort((a, b) => {
      // An unrecognised colour ranks LAST, not first. indexOf returns -1 for one, and a raw
      // -1 would promote a colour nobody defined to the top of the board.
      const rank = (color: string) => {
        const index = COLOR_ORDER.indexOf(color);
        return index === -1 ? COLOR_ORDER.length : index;
      };
      const byColor = rank(a.color) - rank(b.color);
      if (byColor !== 0) return byColor;
      return (b.verifiedWinRate ?? -1) - (a.verifiedWinRate ?? -1);
    });
}
