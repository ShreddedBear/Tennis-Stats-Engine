/**
 * TENNIS MATRIX AUDIT — the Audit section, inside the Tennis Matrix AI shell.
 *
 * A separate engine from the AI prediction model, reached from the same navigation. It
 * never shows a probability: it shows a deterministic selection with the evidence chain
 * behind it, or an explicit refusal with the reason. The two percentages it does show are
 * labelled for what they are -- an evidence SHARE and an evidence COVERAGE -- because
 * conflating either with a win probability is the specific misreading this engine exists
 * to avoid.
 */
import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity, AlertTriangle, CheckCircle2, ChevronLeft, FileText, Layers, Loader2,
  RefreshCw, ShieldCheck, Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BoardView, CalibrationView, LogsView, RulesView, SourcesView,
} from "@/components/TennisMatrixAuditViews";
import {
  clearAuditSlate, colorClasses, commitSummaries, extractSummaries, fileToBase64,
  getActiveMetrics, getAuditMatch, getAuditSlate, runAuditSlice,
  REVIEW_FIELDS,
  type AuditRow, type ExtractedPdf, type MatchDetail, type ParsedField, type ParsedMatchup,
  type SlateEntry,
} from "@/lib/tennisMatrixAuditApi";

const text = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

function StageList({ stages }: { stages: MatchDetail["stages"] }) {
  return (
    <ol className="space-y-1">
      {stages.map(({ stage, row }, index) => {
        const status = row ? String(row["status"]) : "PENDING";
        const tone =
          status === "COMPLETE" ? "text-emerald-400"
          : status === "RUNNING" ? "text-amber-400"
          : status === "BLOCKED" || status === "FAILED" ? "text-red-400"
          : "text-muted-foreground";
        return (
          <li key={stage} className="flex items-start justify-between gap-3 rounded-md border border-border px-2 py-1.5 text-xs">
            <span className="flex min-w-0 items-center gap-2">
              <span className="w-5 shrink-0 tabular-nums text-muted-foreground">{index + 1}</span>
              <span className="truncate">{stage}</span>
            </span>
            <span className={`shrink-0 font-medium ${tone}`}>
              {status}
              {row && row["done_count"] !== undefined ? ` · ${text(row["done_count"])}/${text(row["total_count"])}` : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function RowTable({ rows, columns }: { rows: AuditRow[]; columns: Array<[string, string]> }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">No rows for this run.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>{columns.map(([, label]) => <th key={label} className="px-2 py-1.5 font-medium">{label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row["id"] ?? index)} className="border-t border-border align-top">
              {columns.map(([key]) => (
                <td key={key} className="max-w-[22rem] truncate px-2 py-1.5" title={text(row[key])}>{text(row[key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatchWorkspace({ matchId, onBack }: { matchId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["tennis-matrix-audit", "match", matchId],
    queryFn: () => getAuditMatch(matchId),
    // While a run is in flight the pipeline is persisting stage progress; poll so the
    // stage list and coverage reflect what is actually on disk rather than a stale view.
    refetchInterval: running ? 3000 : false,
  });

  // Drives the audit by repeated time-boxed slices until the pipeline reports complete.
  // Each slice resumes the same run; it never restarts one or creates a duplicate.
  const drive = useMutation({
    mutationFn: async () => {
      setRunError(null);
      setRunning(true);
      try {
        for (let slice = 0; slice < 40; slice++) {
          const result = await runAuditSlice(matchId);
          await queryClient.invalidateQueries({ queryKey: ["tennis-matrix-audit", "match", matchId] });
          if (result.complete) return result;
          if (result.failures.length) return result;
        }
        return null;
      } finally {
        setRunning(false);
        await queryClient.invalidateQueries({ queryKey: ["tennis-matrix-audit"] });
      }
    },
    onError: (error: Error) => setRunError(error.message),
  });

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const { match, run, report, readiness, decision } = data;
  const selectedPlayer =
    (decision?.["gate_report"] as { deterministic_decision?: { selected_player?: string | null } } | undefined)
      ?.deterministic_decision?.selected_player ?? null;
  const evidenceShare =
    (decision?.["gate_report"] as { deterministic_decision?: { evidence_support_percent?: number } } | undefined)
      ?.deterministic_decision?.evidence_support_percent ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
          <ChevronLeft className="h-4 w-4" /> Back to slate
        </Button>
        <Button size="sm" onClick={() => drive.mutate()} disabled={running} className="gap-2">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {running ? "Running audit…" : run ? "Resume audit" : "Run audit"}
        </Button>
      </div>

      {runError && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{runError}</span>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {text(match["player1_name"])} <span className="text-muted-foreground">vs</span> {text(match["player2_name"])}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {[match["tournament_name"], match["round"], match["surface"], match["scheduled_date"]]
              .filter(Boolean).map(String).join(" · ") || "No context resolved"}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={colorClasses(report?.color)}>{report?.color ?? "NO RUN"}</Badge>
            {selectedPlayer
              ? <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">Selected: {selectedPlayer}</Badge>
              : <Badge variant="outline" className="text-muted-foreground">No side selected</Badge>}
            {report && <span className="text-xs text-muted-foreground">{report.completionPercent}% of checks passed</span>}
          </div>

          <dl className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border border-border px-2 py-1.5">
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Evidence share</dt>
              {/* NOT a win probability: the share of directional evidence held by the leader. */}
              <dd className="tabular-nums">{evidenceShare === null ? "—" : `${evidenceShare}%`}</dd>
            </div>
            <div className="rounded-md border border-border px-2 py-1.5">
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Evidence coverage</dt>
              <dd className="tabular-nums">{report ? `${report.coverage.usablePercent}%` : "—"}</dd>
            </div>
            <div className="rounded-md border border-border px-2 py-1.5">
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Active metrics usable</dt>
              <dd className="tabular-nums">{readiness ? `${readiness.usable}/${readiness.expected}` : "—"}</dd>
            </div>
            <div className="rounded-md border border-border px-2 py-1.5">
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Eligible denominator</dt>
              <dd className="tabular-nums">{readiness ? readiness.eligible : "—"}</dd>
            </div>
          </dl>

          {report?.greenLockReasons?.length ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
              <p className="mb-1 font-medium">Withheld from GREEN:</p>
              <ul className="list-inside list-disc space-y-0.5">
                {report.greenLockReasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Tabs defaultValue="stages">
        <TabsList className="flex-wrap">
          <TabsTrigger value="stages">Stages</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="verification">Verification</TabsTrigger>
          <TabsTrigger value="disagreement">Disagreement</TabsTrigger>
          <TabsTrigger value="underdog">Underdog</TabsTrigger>
          <TabsTrigger value="stress">Stress</TabsTrigger>
        </TabsList>

        <TabsContent value="stages" className="mt-3">
          <Card><CardContent className="pt-4"><StageList stages={data.stages} /></CardContent></Card>
        </TabsContent>
        <TabsContent value="metrics" className="mt-3">
          <Card><CardContent className="pt-4">
            <RowTable rows={data.metrics} columns={[
              ["metric_code", "Code"], ["metric_name", "Metric"],
              ["p1_value", "P1 value"], ["p2_value", "P2 value"],
              ["p1_treatment", "P1"], ["p2_treatment", "P2"],
              ["unavailable_reason", "Reason"],
            ]} />
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="verification" className="mt-3">
          <Card><CardContent className="pt-4">
            <RowTable rows={data.verification} columns={[["rule_code", "Rule"], ["outcome", "Outcome"], ["severity", "Severity"], ["decision_effect", "Effect"]]} />
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="disagreement" className="mt-3">
          <Card><CardContent className="pt-4">
            <RowTable rows={data.disagreement} columns={[["rule_code", "Rule"], ["contradiction_severity", "Severity"], ["opposing_evidence", "Opposing evidence"], ["final_effect", "Effect"]]} />
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="underdog" className="mt-3">
          <Card><CardContent className="pt-4">
            <RowTable rows={data.underdog} columns={[["pathway_code", "Pathway"], ["player_side", "Side"], ["classification", "Classification"], ["evidence", "Evidence"]]} />
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="stress" className="mt-3">
          <Card><CardContent className="pt-4">
            <RowTable rows={data.stress} columns={[["test_code", "Test"], ["status", "Status"], ["outcome", "Outcome"], ["winner_before", "Before"], ["winner_after", "After"], ["unavailable_detail", "Detail"]]} />
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SlateView({ onOpen }: { onOpen: (matchId: string) => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["tennis-matrix-audit", "slate"], queryFn: getAuditSlate });
  const { data: registry } = useQuery({ queryKey: ["tennis-matrix-audit", "metrics"], queryFn: getActiveMetrics });
  const clear = useMutation({
    mutationFn: clearAuditSlate,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tennis-matrix-audit"] }),
  });

  const summary = useMemo(() => {
    const slate = data?.slate ?? [];
    return {
      total: slate.length,
      withWinner: slate.filter((entry) => entry.selected_player).length,
      refused: slate.filter((entry) => entry.run && !entry.selected_player).length,
      notRun: slate.filter((entry) => !entry.run).length,
    };
  }, [data]);

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{(error as Error).message}</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-5">
        {([["Matches on slate", summary.total], ["Selection made", summary.withWinner],
           ["Insufficient evidence", summary.refused], ["Not yet run", summary.notRun],
           ["Active metrics", registry?.count ?? "—"]] as const).map(([label, value]) => (
          <div key={label} className="rounded-md border border-border px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="tabular-nums text-lg">{value}</p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
          <CardTitle className="text-base">Current slate</CardTitle>
          <Button
            variant="outline" size="sm"
            onClick={() => { if (window.confirm("Clear Slate permanently deletes every operational audit row. Continue?")) clear.mutate(); }}
            disabled={clear.isPending}
          >
            {clear.isPending ? "Clearing…" : "Clear slate"}
          </Button>
        </CardHeader>
        <CardContent>
          {!data?.slate.length ? (
            <p className="text-sm text-muted-foreground">
              No matches on the current slate. Upload a summary to start an audit.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 font-medium">Match</th>
                    <th className="px-2 py-2 font-medium">Context</th>
                    <th className="px-2 py-2 font-medium">Colour</th>
                    <th className="px-2 py-2 font-medium">Selection</th>
                    <th className="px-2 py-2 font-medium">Run</th>
                  </tr>
                </thead>
                <tbody>
                  {data.slate.map((entry: SlateEntry) => {
                    const matchId = String(entry.match["id"]);
                    return (
                      <tr
                        key={matchId}
                        className="cursor-pointer border-t border-border hover:bg-muted/40"
                        onClick={() => onOpen(matchId)}
                      >
                        <td className="px-2 py-2">
                          {text(entry.match["player1_name"])} <span className="text-muted-foreground">vs</span> {text(entry.match["player2_name"])}
                        </td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">
                          {[entry.match["tournament_name"], entry.match["round"], entry.match["surface"]]
                            .filter(Boolean).map(String).join(" · ") || "—"}
                        </td>
                        <td className="px-2 py-2">
                          <Badge variant="outline" className={colorClasses(entry.decision?.["final_audit_color"] as string)}>
                            {text(entry.decision?.["final_audit_color"] ?? "NO RUN")}
                          </Badge>
                        </td>
                        <td className="px-2 py-2 text-xs">{entry.selected_player ?? <span className="text-muted-foreground">No side selected</span>}</td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">{text(entry.run?.["status"] ?? "—")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Summary ingestion. Deliberately two steps with a review in between: extraction reads the
 * PDFs and reports what it found without writing anything, and only the matchups the
 * operator confirms are committed. A misparsed name or a missing tournament is what decides
 * whether an upload lands on the right match row, so it has to be visible before it counts.
 */
function UploadView() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [extracted, setExtracted] = useState<ExtractedPdf[] | null>(null);
  const [readFailures, setReadFailures] = useState<Array<{ filename: string; message: string }>>([]);
  // Keyed by "<file index>:<matchup index>" -- the identity of a parse before it has a match row.
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const detected = useMemo(
    () => (extracted ?? []).reduce((total, file) => total + file.matchups.length, 0),
    [extracted],
  );
  const selectedCount = detected - skipped.size;

  const extract = useMutation({
    mutationFn: async (files: File[]) => {
      setError(null);
      const payload = await Promise.all(
        files.map(async (file) => ({ filename: file.name, base64: await fileToBase64(file) })),
      );
      return extractSummaries(payload);
    },
    onSuccess: (result) => {
      setExtracted(result.files);
      setReadFailures(result.failures);
      setSkipped(new Set());
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const commit = useMutation({
    mutationFn: async () => {
      setError(null);
      // Only the confirmed matchups are sent; an unchecked parse is never persisted.
      const files = (extracted ?? [])
        .map((file, fileIndex) => ({
          ...file,
          matchups: file.matchups.filter((_, index) => !skipped.has(`${fileIndex}:${index}`)),
        }))
        .filter((file) => file.matchups.length > 0);
      return commitSummaries(files);
    },
    onSuccess: async () => {
      setExtracted(null);
      setSkipped(new Set());
      if (inputRef.current) inputRef.current.value = "";
      await queryClient.invalidateQueries({ queryKey: ["tennis-matrix-audit"] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  /** Apply an edit to one staged matchup, leaving every other parse untouched. */
  const editMatchup = (
    fileIndex: number,
    matchupIndex: number,
    change: (matchup: ParsedMatchup) => ParsedMatchup,
  ) =>
    setExtracted((current) =>
      (current ?? []).map((file, fi) =>
        fi !== fileIndex
          ? file
          : { ...file, matchups: file.matchups.map((m, mi) => (mi === matchupIndex ? change(m) : m)) },
      ),
    );

  const editName = (fileIndex: number, matchupIndex: number, side: "player1_name" | "player2_name", value: string) =>
    editMatchup(fileIndex, matchupIndex, (matchup) => ({ ...matchup, [side]: value }));

  const editField = (fileIndex: number, matchupIndex: number, fieldKey: string, value: string) =>
    editMatchup(fileIndex, matchupIndex, (matchup) => {
      const existing = matchup.fields.find((field) => field.field_key === fieldKey);
      // A corrected value is recorded as DIRECT: it came from a person reading the source,
      // which is a stronger provenance than anything the parser can claim for itself.
      const edited: ParsedField = existing
        ? { ...existing, normalized_value: value, extraction_status: "DIRECT" }
        : {
            field_key: fieldKey, raw_value: null, normalized_value: value,
            extraction_status: "DIRECT", confidence: 1, page_number: matchup.page_number,
          };
      return {
        ...matchup,
        fields: existing
          ? matchup.fields.map((field) => (field.field_key === fieldKey ? edited : field))
          : [...matchup.fields, edited],
      };
    });

  const toggle = (key: string) =>
    setSkipped((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Upload match summaries</CardTitle>
          <p className="text-xs text-muted-foreground">
            PDF summaries are parsed into matchups. Nothing is written until you commit, and a
            re-upload of the same match updates that match rather than creating a duplicate.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length) extract.mutate(files);
              }}
            />
            <Button
              size="sm"
              className="gap-2"
              onClick={() => inputRef.current?.click()}
              disabled={extract.isPending || commit.isPending}
            >
              {extract.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {extract.isPending ? "Reading PDFs…" : "Choose PDFs"}
            </Button>
            {extracted && (
              <span className="text-xs text-muted-foreground">
                {selectedCount} of {detected} detected matchup{detected === 1 ? "" : "s"} selected
              </span>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{error}</span>
            </div>
          )}

          {readFailures.map((failure) => (
            <div key={failure.filename} className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span><span className="font-medium">{failure.filename}</span> could not be read: {failure.message}</span>
            </div>
          ))}

          {commit.data && (
            <div className="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
              <p className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                {commit.data.created} new match{commit.data.created === 1 ? "" : "es"}, {commit.data.reused} updated,
                {" "}{commit.data.versions} summary version{commit.data.versions === 1 ? "" : "s"} recorded.
              </p>
              {commit.data.errors.length > 0 && (
                <ul className="list-inside list-disc space-y-0.5 text-amber-200">
                  {commit.data.errors.map((failure) => (
                    <li key={failure.match}>{failure.match}: {failure.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {extracted?.map((file, fileIndex) => (
        <Card key={`${file.filename}-${fileIndex}`}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{file.filename}</span>
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {file.pages.length} page{file.pages.length === 1 ? "" : "s"} · {file.matchups.length} matchup
              {file.matchups.length === 1 ? "" : "s"} detected
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {!file.matchups.length ? (
              <p className="text-xs text-muted-foreground">
                No matchups were recognised in this file. Nothing from it will be committed.
              </p>
            ) : (
              file.matchups.map((matchup, index) => {
                const key = `${fileIndex}:${index}`;
                const include = !skipped.has(key);
                return (
                  <div
                    key={key}
                    className={`rounded-md border px-3 py-2 ${include ? "border-border" : "border-dashed border-border opacity-50"}`}
                  >
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={include}
                        onCheckedChange={() => toggle(key)}
                        aria-label={`Include ${matchup.player1_name} vs ${matchup.player2_name}`}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            className="h-8 w-full font-medium sm:w-44"
                            value={matchup.player1_name}
                            aria-label="Player 1 name"
                            onChange={(event) => editName(fileIndex, index, "player1_name", event.target.value)}
                          />
                          <span className="text-xs text-muted-foreground">vs</span>
                          <Input
                            className="h-8 w-full font-medium sm:w-44"
                            value={matchup.player2_name}
                            aria-label="Player 2 name"
                            onChange={(event) => editName(fileIndex, index, "player2_name", event.target.value)}
                          />
                        </div>
                        {/* Names come straight out of the PDF and nothing downstream re-derives
                            them. They are also what resolves this parse to a match row, so an
                            OCR slip or a truncated spelling is corrected here, before commit. */}
                        <p className="text-[11px] text-muted-foreground">
                          Page {matchup.page_number} · {matchup.fields.length} field
                          {matchup.fields.length === 1 ? "" : "s"} parsed. Names and context come from the
                          PDF — correct anything wrong here; nothing downstream re-derives them.
                        </p>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {REVIEW_FIELDS.map((name) => (
                            <label key={name} className="text-[11px]">
                              <span className="text-muted-foreground">{name.replace(/_/g, " ")}</span>
                              <Input
                                className="mt-0.5 h-8"
                                placeholder="UNAVAILABLE"
                                value={matchup.fields.find((f) => f.field_key === name)?.normalized_value ?? ""}
                                onChange={(event) => editField(fileIndex, index, name, event.target.value)}
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      ))}

      {extracted && detected > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => commit.mutate()} disabled={commit.isPending || selectedCount === 0} className="gap-2">
            {commit.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {commit.isPending ? "Committing…" : `Commit ${selectedCount} matchup${selectedCount === 1 ? "" : "s"}`}
          </Button>
          <Button
            variant="ghost" size="sm"
            onClick={() => { setExtracted(null); setSkipped(new Set()); setReadFailures([]); if (inputRef.current) inputRef.current.value = ""; }}
            disabled={commit.isPending}
          >
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}

export default function TennisMatrixAudit() {
  const [openMatchId, setOpenMatchId] = useState<string | null>(null);

  return (
    <div className="app-container space-y-5 py-5">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Tennis Matrix Audit</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The Truth Engine: 25 active metrics compared independently for each player, consolidated
          into evidence families, and resolved into a deterministic selection — or an explicit
          refusal when the evidence cannot distinguish the two players. Separate from the AI
          prediction engine, and never a probability.
        </p>
      </header>

      {openMatchId ? (
        <MatchWorkspace matchId={openMatchId} onBack={() => setOpenMatchId(null)} />
      ) : (
        <Tabs defaultValue="slate">
          <TabsList className="flex-wrap">
            <TabsTrigger value="slate">Slate</TabsTrigger>
            <TabsTrigger value="upload">Upload</TabsTrigger>
            <TabsTrigger value="board">Board</TabsTrigger>
            <TabsTrigger value="calibration">Calibration</TabsTrigger>
            <TabsTrigger value="sources">Sources</TabsTrigger>
            <TabsTrigger value="rules">Rules</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>
          <TabsContent value="slate" className="mt-4"><SlateView onOpen={setOpenMatchId} /></TabsContent>
          <TabsContent value="upload" className="mt-4"><UploadView /></TabsContent>
          <TabsContent value="board" className="mt-4"><BoardView /></TabsContent>
          <TabsContent value="calibration" className="mt-4"><CalibrationView /></TabsContent>
          <TabsContent value="sources" className="mt-4"><SourcesView /></TabsContent>
          <TabsContent value="rules" className="mt-4"><RulesView /></TabsContent>
          <TabsContent value="logs" className="mt-4"><LogsView /></TabsContent>
        </Tabs>
      )}

      <footer className="flex items-center gap-2 pt-2 text-[11px] text-muted-foreground">
        <Activity className="h-3.5 w-3.5" />
        <span>Evidence share and coverage are diagnostics, not win probabilities.</span>
        <Layers className="ml-auto h-3.5 w-3.5" />
      </footer>
    </div>
  );
}
