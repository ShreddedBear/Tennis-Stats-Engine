/**
 * TENNIS MATRIX AUDIT — the reference and ledger views.
 *
 * The board, calibration ledger, source record, rule knowledge base and execution log. All
 * read-only except where a person is the authority: grading a real result, and resolving a
 * source conflict. Nothing here is a probability produced by this application -- the one
 * percentage that looks like one, the Matrix WP column, is the uploaded summary's own claim,
 * shown so it can be judged against what actually happened.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  colorClasses, getAuditBoard, getAuditLogs, getAuditRules, getAuditSources, getCalibration,
  getCalibrationHistory, getCalibrationPrefill, gradeCalibrationResult, resolveSourceConflict,
  RESULT_TYPES, type AuditRow, type BoardRow, type CalibrationBucket,
} from "@/lib/tennisMatrixAuditApi";

const text = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const when = (value: unknown): string => {
  const parsed = value ? new Date(String(value)) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleString() : "—";
};

function ErrorNote({ error }: { error: unknown }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

/** A horizontally scrollable table. Wide audit tables must never scroll the page sideways. */
function Scroller({ children, min = "48rem" }: { children: React.ReactNode; min?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs" style={{ minWidth: min }}>{children}</table>
    </div>
  );
}

function Head({ columns }: { columns: string[] }) {
  return (
    <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
      <tr>{columns.map((column) => <th key={column} className="whitespace-nowrap px-2 py-2 font-medium">{column}</th>)}</tr>
    </thead>
  );
}

// --- MASTER RANKED BOARD -----------------------------------------------------------

export function BoardView() {
  const { data, isLoading, error } = useQuery({ queryKey: ["tennis-matrix-audit", "board"], queryFn: getAuditBoard });
  const rows = data?.rows ?? [];

  /**
   * Exports exactly what is on screen, in the same order. CSV rather than a generated PDF:
   * the sandboxed browser view blocks script-initiated downloads of generated binaries, and
   * a file that silently fails to save is worse than a plain one that works everywhere.
   */
  const exportCsv = () => {
    const columns: Array<[string, (row: BoardRow) => unknown]> = [
      ["Rank", (_row) => rows.indexOf(_row) + 1],
      ["Final selection", (row) => row.selection],
      ["Match", (row) => row.matchLabel],
      ["Tournament", (row) => row.tournament],
      ["Surface", (row) => row.surface],
      ["Matrix pick", (row) => row.matrixPick],
      ["Matrix WP", (row) => row.matrixWp],
      ["Bucket", (row) => row.bucket],
      ["Verified win rate", (row) => row.verifiedWinRate],
      ["Independent winner", (row) => row.independentWinner],
      ["Independent range", (row) => row.independentRange],
      ["Calibrated range", (row) => row.calibratedRange],
      ["Evidence", (row) => row.evidence],
      ["Audit colour", (row) => row.color],
      ["Action", (row) => row.action],
      ["Completion %", (row) => row.completion],
    ];
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = [
      columns.map(([label]) => escape(label)).join(","),
      ...rows.map((row) => columns.map(([, read]) => escape(read(row))).join(",")),
    ].join("\n");

    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `tennis-matrix-audit-board-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) return <ErrorNote error={error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-2xl text-xs text-muted-foreground">
          Primary sort: final audit colour. Secondary sort: the calibration bucket's verified win
          rate. Never the Matrix's own stated probability — that column is the claim being judged.
          An audit that has not completed ranks as INCOMPLETE rather than beside a finished one.
        </p>
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={!rows.length}>Export CSV</Button>
      </div>

      <Card>
        <CardContent className="pt-4">
          {!rows.length ? (
            <Empty>No final decisions yet. Run a match through the audit to rank it here.</Empty>
          ) : (
            <Scroller min="72rem">
              <Head columns={[
                "#", "Final selection", "Match", "Tournament", "Surface", "Matrix pick", "Matrix WP",
                "Bucket", "Verified WR", "Independent", "Ind. range", "Calibrated", "Evidence",
                "Colour", "Action", "Completion",
              ]} />
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.matchId} className="border-t border-border align-top">
                    <td className="px-2 py-2 tabular-nums text-muted-foreground">{index + 1}</td>
                    <td className="px-2 py-2 font-medium">{text(row.selection)}</td>
                    <td className="px-2 py-2">{row.matchLabel}</td>
                    <td className="px-2 py-2">{text(row.tournament)}</td>
                    <td className="px-2 py-2">{text(row.surface)}</td>
                    <td className="px-2 py-2">{text(row.matrixPick)}</td>
                    <td className="px-2 py-2 tabular-nums">{text(row.matrixWp)}</td>
                    <td className="px-2 py-2">{text(row.bucket)}</td>
                    <td className="px-2 py-2 tabular-nums">{row.verifiedWinRate === null ? "—" : `${row.verifiedWinRate}%`}</td>
                    <td className="px-2 py-2">{text(row.independentWinner)}</td>
                    <td className="px-2 py-2 tabular-nums">{text(row.independentRange)}</td>
                    <td className="px-2 py-2 tabular-nums">{text(row.calibratedRange)}</td>
                    <td className="px-2 py-2 tabular-nums">{row.evidence}</td>
                    <td className="px-2 py-2">
                      <Badge variant="outline" className={colorClasses(row.color)}>{row.color}</Badge>
                    </td>
                    <td className="max-w-[18rem] truncate px-2 py-2" title={text(row.action)}>{text(row.action)}</td>
                    <td className="px-2 py-2 tabular-nums">{row.completion}%</td>
                  </tr>
                ))}
              </tbody>
            </Scroller>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// --- CALIBRATION -------------------------------------------------------------------

function BucketCard({ bucket }: { bucket: CalibrationBucket }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{bucket.bucket_code}</span>
        <span className="tabular-nums text-[10px] text-muted-foreground">{bucket.wp_min}–{bucket.wp_max}%</span>
      </div>
      <p className="mt-1 text-xl tabular-nums">{bucket.win_rate === null ? "—" : `${bucket.win_rate}%`}</p>
      <p className="tabular-nums text-[11px] text-muted-foreground">
        {bucket.wins}/{bucket.graded} graded{bucket.small_sample ? " · SMALL SAMPLE" : ""}
      </p>
    </div>
  );
}

const EMPTY_FORM = {
  matchId: "", matchLabel: "", tournament: "", surface: "", matchDate: "",
  matrixPredictedWinner: "", matrixWp: "", actualWinner: "", resultType: "WIN", note: "",
};

export function CalibrationView() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_FORM);
  const [showHistory, setShowHistory] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["tennis-matrix-audit", "calibration"],
    queryFn: getCalibration,
  });
  const history = useQuery({
    queryKey: ["tennis-matrix-audit", "calibration", "history"],
    queryFn: getCalibrationHistory,
    enabled: showHistory,
  });

  const set = (key: keyof typeof EMPTY_FORM, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const prefill = useMutation({
    mutationFn: () => getCalibrationPrefill(form.matchId.trim()),
    onSuccess: (result) =>
      setForm((current) => ({
        ...current,
        matchLabel: result.matchLabel || current.matchLabel,
        tournament: result.tournament ?? current.tournament,
        surface: result.surface ?? current.surface,
        matchDate: result.matchDate ?? current.matchDate,
        matrixPredictedWinner: result.matrixPredictedWinner ?? current.matrixPredictedWinner,
        matrixWp: result.matrixWp === null ? current.matrixWp : String(result.matrixWp),
      })),
    onError: (cause: Error) => setFailure(cause.message),
  });

  const grade = useMutation({
    mutationFn: () => {
      setFailure(null);
      return gradeCalibrationResult({
        matchId: form.matchId.trim() || null,
        matchLabel: form.matchLabel.trim(),
        tournament: form.tournament || null,
        surface: form.surface || null,
        matchDate: form.matchDate || null,
        matrixPredictedWinner: form.matrixPredictedWinner || null,
        matrixWp: form.matrixWp || null,
        resultType: form.resultType,
        actualWinner: form.actualWinner || null,
        note: form.note || null,
      });
    },
    onSuccess: async (result) => {
      setNotice(
        `${text(result.version["label"])} is now active.` +
          (result.counted
            ? ` Counted in bucket ${result.bucketCode}.`
            : " Recorded but not counted in any bucket — a walkover, a void, or no stated probability to bucket it by."),
      );
      setForm({ ...EMPTY_FORM, tournament: form.tournament, surface: form.surface });
      await queryClient.invalidateQueries({ queryKey: ["tennis-matrix-audit"] });
    },
    onError: (cause: Error) => setFailure(cause.message),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) return <ErrorNote error={error} />;

  const version = data?.version;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{text(version?.["label"] ?? "Calibration not initialised")}</p>
          <p className="tabular-nums text-xs text-muted-foreground">
            Master sequence {text(version?.["master_sequence_count"] ?? 0)} · graded sample{" "}
            {text(version?.["graded_sample_count"] ?? 0)}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowHistory((current) => !current)}>
          {showHistory ? "Hide version history" : "Version history"}
        </Button>
      </div>

      <p className="max-w-3xl text-xs text-muted-foreground">
        A verified win rate is a record of how the uploaded summary's stated probability has
        actually performed — not an output of either engine in this application. Every graded
        result creates a new immutable version rather than editing the current one, so a figure
        printed beside a past decision can still be traced to the bucket record that produced it.
      </p>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {(data?.buckets ?? []).map((bucket) => <BucketCard key={bucket.id} bucket={bucket} />)}
      </div>

      {showHistory && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Version history</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {history.isLoading && <Skeleton className="h-24 w-full" />}
            {history.error && <ErrorNote error={history.error} />}
            {(history.data?.versions ?? []).map((entry) => (
              <div key={String(entry["id"])} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {text(entry["label"])}
                    {entry["is_active"] ? <span className="ml-2 text-[11px] text-emerald-400">ACTIVE</span> : null}
                  </p>
                  <p className="tabular-nums text-[11px] text-muted-foreground">
                    seq {text(entry["master_sequence_count"])} · graded {text(entry["graded_sample_count"])} ·{" "}
                    {when(entry["created_at"])}
                  </p>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(history.data?.buckets ?? [])
                    .filter((bucket) => bucket.calibration_version_id === String(entry["id"]))
                    .map((bucket) => (
                      <span key={bucket.id} className="rounded-md border border-border px-2 py-1 text-[11px]">
                        {bucket.bucket_code}{" "}
                        <span className="tabular-nums text-muted-foreground">
                          {bucket.win_rate === null ? "—" : `${bucket.win_rate}%`} ({bucket.wins}/{bucket.graded})
                        </span>
                      </span>
                    ))}
                </div>
              </div>
            ))}
            {history.data && !history.data.versions.length && <Empty>No calibration versions recorded.</Empty>}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Grade a result</CardTitle>
          <p className="text-xs text-muted-foreground">
            In-match retirements are graded as real results. Walkovers and voids are recorded but
            never counted in a bucket.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-9 max-w-xs" placeholder="Match ID (optional)"
              value={form.matchId} onChange={(event) => set("matchId", event.target.value)}
            />
            <Button
              type="button" size="sm" variant="outline"
              onClick={() => prefill.mutate()} disabled={!form.matchId.trim() || prefill.isPending}
            >
              {prefill.isPending ? "Loading…" : "Prefill from summary"}
            </Button>
            {/* Prefill deliberately fills the prediction half only. The actual winner and
                result type are the thing being graded; inferring them would make the ledger
                self-confirming. */}
            <span className="text-[11px] text-muted-foreground">
              Fills the prediction fields only — the actual result is always entered by hand.
            </span>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {([
              ["matchLabel", "Match label"], ["tournament", "Tournament"], ["surface", "Surface"],
              ["matchDate", "Match date (YYYY-MM-DD)"], ["matrixPredictedWinner", "Matrix predicted winner"],
              ["matrixWp", "Matrix WP %"], ["actualWinner", "Actual winner"], ["note", "Note"],
            ] as const).map(([key, label]) => (
              <Input
                key={key} className="h-9" placeholder={label}
                value={form[key]} onChange={(event) => set(key, event.target.value)}
              />
            ))}
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={form.resultType}
              aria-label="Result type"
              onChange={(event) => set("resultType", event.target.value)}
            >
              {RESULT_TYPES.map((type) => <option key={type}>{type}</option>)}
            </select>
          </div>

          {failure && <ErrorNote error={failure} />}
          {notice && (
            <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-200">{notice}</p>
          )}

          <Button size="sm" onClick={() => grade.mutate()} disabled={!form.matchLabel.trim() || grade.isPending} className="gap-2">
            {grade.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Grade result & recalculate
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Ledger</CardTitle></CardHeader>
        <CardContent>
          {!data?.ledger.length ? (
            <Empty>Ledger empty — graded results will appear here.</Empty>
          ) : (
            <Scroller min="60rem">
              <Head columns={["Seq", "Match", "Tournament", "Surface", "Matrix pick", "WP", "Actual", "Result", "Grading", "Bucket", "Counted"]} />
              <tbody>
                {data.ledger.map((row) => (
                  <tr key={String(row["id"])} className="border-t border-border align-top">
                    <td className="px-2 py-1.5 tabular-nums">{text(row["master_sequence"])}</td>
                    <td className="px-2 py-1.5">{text(row["match_label"])}</td>
                    <td className="px-2 py-1.5">{text(row["tournament"])}</td>
                    <td className="px-2 py-1.5">{text(row["surface"])}</td>
                    <td className="px-2 py-1.5">{text(row["matrix_predicted_winner"])}</td>
                    <td className="px-2 py-1.5 tabular-nums">{text(row["matrix_wp"])}</td>
                    <td className="px-2 py-1.5">{text(row["actual_winner"])}</td>
                    <td className="px-2 py-1.5">{text(row["result_type"])}</td>
                    <td className="px-2 py-1.5">{text(row["result_grading_status"])}</td>
                    <td className="px-2 py-1.5">{text(row["bucket_code"])}</td>
                    <td className="px-2 py-1.5">{row["counted_in_bucket"] ? "YES" : "NO"}</td>
                  </tr>
                ))}
              </tbody>
            </Scroller>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// --- SOURCES & CONFLICTS -----------------------------------------------------------

export function SourcesView() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["tennis-matrix-audit", "sources"], queryFn: getAuditSources });
  const resolve = useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: "RESOLVED" | "UNRESOLVABLE" }) =>
      resolveSourceConflict(id, resolution),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tennis-matrix-audit", "sources"] }),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) return <ErrorNote error={error} />;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Source conflicts</CardTitle>
          <p className="text-xs text-muted-foreground">
            Conflicting values are never silently averaged — both are kept and the disagreement is
            recorded. An unresolved CRITICAL conflict blocks completion for that match alone.
          </p>
        </CardHeader>
        <CardContent>
          {resolve.error && <ErrorNote error={resolve.error} />}
          {!data?.conflicts.length ? (
            <Empty>No conflicts recorded.</Empty>
          ) : (
            <Scroller min="52rem">
              <Head columns={["Field", "Values", "Selected", "Severity", "Status", ""]} />
              <tbody>
                {data.conflicts.map((row: AuditRow) => {
                  const id = String(row["id"]);
                  return (
                    <tr key={id} className="border-t border-border align-top">
                      <td className="px-2 py-1.5">{text(row["data_key"])}</td>
                      <td className="max-w-[20rem] truncate px-2 py-1.5" title={text(row["values"])}>{text(row["values"])}</td>
                      <td className="px-2 py-1.5">{text(row["selected_value"])}</td>
                      <td className="px-2 py-1.5">{row["critical"] ? "CRITICAL" : "STANDARD"}</td>
                      <td className="px-2 py-1.5">{text(row["resolution_status"])}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="secondary" disabled={resolve.isPending}
                            onClick={() => resolve.mutate({ id, resolution: "RESOLVED" })}>Resolve</Button>
                          <Button size="sm" variant="ghost" disabled={resolve.isPending}
                            onClick={() => resolve.mutate({ id, resolution: "UNRESOLVABLE" })}>Unresolvable</Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Scroller>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Source snapshots</CardTitle></CardHeader>
        <CardContent>
          {!data?.snapshots.length ? (
            <Empty>No snapshots captured yet.</Empty>
          ) : (
            <Scroller min="52rem">
              <Head columns={["Captured", "Source", "Key", "Value", "Reliability"]} />
              <tbody>
                {data.snapshots.map((row: AuditRow) => (
                  <tr key={String(row["id"])} className="border-t border-border align-top">
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{when(row["retrieved_at"])}</td>
                    <td className="px-2 py-1.5">{text(row["source_name"])}</td>
                    <td className="px-2 py-1.5">{text(row["data_key"])}</td>
                    <td className="max-w-[24rem] truncate px-2 py-1.5 text-muted-foreground"
                        title={text(row["normalized_value"] ?? row["raw_value"])}>
                      {text(row["normalized_value"] ?? row["raw_value"])}
                    </td>
                    <td className="px-2 py-1.5">{text(row["reliability"])}</td>
                  </tr>
                ))}
              </tbody>
            </Scroller>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// --- RULE KNOWLEDGE BASE -----------------------------------------------------------

export function RulesView() {
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ["tennis-matrix-audit", "rules"], queryFn: getAuditRules });

  const activeVersionFor = (documentId: string) =>
    (data?.versions ?? []).find((row) => String(row["document_id"]) === documentId && row["is_active"] === true);

  const currentDocument = selected ?? (data?.documents.length ? String(data.documents[0]!["id"]) : null);
  const version = currentDocument ? activeVersionFor(currentDocument) : undefined;
  const rules = useMemo(
    () => (data?.rules ?? []).filter((rule) => version && String(rule["version_id"]) === String(version["id"])),
    [data, version],
  );

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) return <ErrorNote error={error} />;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-xs text-muted-foreground">
        Rules are parsed deterministically from the uploaded documents, and every audit run clones
        the ACTIVE rule set — so a past run stays reproducible against the rules it actually ran
        under. A version whose parse is incomplete cannot be activated, which is what stops a run
        silently skipping a rule.
      </p>

      {!data?.documents.length ? (
        <Card><CardContent className="pt-4"><Empty>No rule documents loaded.</Empty></CardContent></Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {data.documents.map((document) => {
              const id = String(document["id"]);
              const documentVersion = activeVersionFor(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSelected(id)}
                  className={`rounded-md border px-3 py-2 text-left text-xs ${
                    currentDocument === id ? "border-primary bg-muted" : "border-border"
                  }`}
                >
                  <p className="font-medium">{text(document["title"])}</p>
                  <p className="tabular-nums text-[11px] text-muted-foreground">
                    {text(document["doc_type"])} · v{text(documentVersion?.["version_number"] ?? "—")} ·{" "}
                    {text(documentVersion?.["parsed_rules"] ?? 0)} rules
                  </p>
                </button>
              );
            })}
          </div>

          {version && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs">
              <span className="font-medium">Version {text(version["version_number"])}</span>
              <span className="tabular-nums text-muted-foreground">
                {text(version["activation_status"])} · declared {text(version["expected_rules"])} · parsed{" "}
                {text(version["parsed_rules"])}
              </span>
            </div>
          )}

          <Card>
            <CardContent className="pt-4">
              {!rules.length ? (
                <Empty>No parsed rules for this document version.</Empty>
              ) : (
                <Scroller min="56rem">
                  <Head columns={["#", "Rule", "Category", "Severity", "Blocking", "Text"]} />
                  <tbody>
                    {rules.map((rule) => (
                      <tr key={String(rule["id"])} className="border-t border-border align-top">
                        <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{text(rule["rule_code"])}</td>
                        <td className="px-2 py-1.5 font-medium">{text(rule["rule_name"])}</td>
                        <td className="px-2 py-1.5">{text(rule["category"])}</td>
                        <td className="px-2 py-1.5">{text(rule["severity"])}</td>
                        <td className="px-2 py-1.5">{rule["blocking"] ? "BLOCKING" : "STANDARD"}</td>
                        <td className="px-2 py-1.5 text-muted-foreground">{text(rule["body"])}</td>
                      </tr>
                    ))}
                  </tbody>
                </Scroller>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// --- EXECUTION LOGS ----------------------------------------------------------------

export function LogsView() {
  const [scope, setScope] = useState<"active" | "all">("active");
  const { data, isLoading, error } = useQuery({
    queryKey: ["tennis-matrix-audit", "logs", scope],
    queryFn: () => getAuditLogs(scope),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) return <ErrorNote error={error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-2xl text-xs text-muted-foreground">
          {scope === "active"
            ? "Scoped to current runs: cleared matches and invalidated runs disappear immediately. Each row is proof a stage ran, and the Matrix-visible flag makes a firewall violation detectable after the fact."
            : "Full history: every execution ever logged, including cleared matches and invalidated runs. These rows are never deleted — they are just not current operational output."}
        </p>
        <Button size="sm" variant="secondary" onClick={() => setScope(scope === "active" ? "all" : "active")}>
          {scope === "active" ? "Show full history" : "Show current runs only"}
        </Button>
      </div>

      <Card>
        <CardContent className="pt-4">
          {!data?.logs.length ? (
            <Empty>
              {scope === "active"
                ? "No current executions logged. Try the full history for past runs."
                : "No executions logged yet."}
            </Empty>
          ) : (
            <Scroller min="56rem">
              <Head columns={["Time", "Stage", "Status", "Matrix visible", "Output"]} />
              <tbody>
                {data.logs.map((row: AuditRow) => (
                  <tr key={String(row["id"])} className="border-t border-border align-top">
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{when(row["created_at"])}</td>
                    <td className="px-2 py-1.5">{text(row["stage"])}</td>
                    <td className="px-2 py-1.5">{text(row["status"])}</td>
                    <td className={`px-2 py-1.5 ${row["matrix_visible"] ? "text-amber-400" : "text-muted-foreground"}`}>
                      {row["matrix_visible"] ? "VISIBLE" : "HIDDEN"}
                    </td>
                    <td className="max-w-[28rem] truncate px-2 py-1.5 text-muted-foreground" title={text(row["output"])}>
                      {text(row["output"])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Scroller>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
