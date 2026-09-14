export type EvidenceTourFamily = "ATP_MAIN" | "WTA_MAIN" | "ATP_CHALLENGER" | "WTA_CHALLENGER";

export type EvidenceMatchIdentityInput = {
  player1StableId?: string | null;
  player2StableId?: string | null;
  player1Name: string;
  player2Name: string;
  tournament?: string | null;
  date?: string | null;
  round?: string | null;
  tour?: string | null;
  eventLevel?: string | null;
};

export type CanonicalEvidenceMatchIdentity = {
  playerPair: string;
  tournament: string | null;
  date: string | null;
  round: string | null;
  tourFamily: EvidenceTourFamily | null;
  competitionLevel: string | null;
  key: string;
};

function ascii(value: unknown) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeEvidenceText(value: unknown) {
  const normalized = ascii(value).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  return normalized || null;
}

export function normalizeEvidenceTournament(value: unknown) {
  let normalized = normalizeEvidenceText(value);
  if (!normalized) return null;
  normalized = normalized
    .replace(/\b(?:presented by|powered by)\b.*$/g, " ")
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/\b(?:atp|wta)\s*(?:tour)?\b/g, " ")
    .replace(/\b(?:wta\s*)?125\b|\b125k\b/g, " ")
    .replace(/\bchallenger(?:\s+\d{2,3})?\b/g, " ")
    .replace(/\b(?:250|500|1000)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

export function normalizeEvidenceRound(value: unknown) {
  const normalized = normalizeEvidenceText(value);
  if (!normalized) return null;
  const aliases: Record<string, string> = {
    f: "final", final: "final", finals: "final",
    sf: "semifinal", semifinal: "semifinal", semifinals: "semifinal",
    qf: "quarterfinal", quarterfinal: "quarterfinal", quarterfinals: "quarterfinal",
    r128: "round 128", r64: "round 64", r32: "round 32", r16: "round 16",
    q1: "qualifying 1", q2: "qualifying 2", q3: "qualifying 3",
  };
  return aliases[normalized] ?? normalized.replace(/^round of (\d+)$/, "round $1");
}

export function normalizeEvidenceDate(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const direct = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

export function evidenceDateCompatible(a: unknown, b: unknown, toleranceDays = 1) {
  const left = normalizeEvidenceDate(a), right = normalizeEvidenceDate(b);
  if (!left || !right) return true;
  const delta = Math.abs(new Date(`${left}T00:00:00Z`).getTime() - new Date(`${right}T00:00:00Z`).getTime());
  return delta <= toleranceDays * 86_400_000;
}

export function normalizeEvidenceCompetitionLevel(value: unknown) {
  const normalized = normalizeEvidenceText(value);
  if (!normalized) return null;
  if (/\bwta\s*125\b|\bwta125\b|\b125k\b/.test(normalized)) return "WTA_125";
  if (/\bchallenger\b/.test(normalized)) return "CHALLENGER";
  if (/\bgrand slam\b|\bslam\b/.test(normalized)) return "GRAND_SLAM";
  if (/\bmasters\b|\b1000\b/.test(normalized)) return "1000";
  if (/\b500\b/.test(normalized)) return "500";
  if (/\b250\b/.test(normalized)) return "250";
  return normalized.toUpperCase().replace(/ /g, "_");
}

export function classifyEvidenceTourFamily(...values: unknown[]): EvidenceTourFamily | null {
  const text = values.map((value) => normalizeEvidenceText(value) ?? "").join(" ");
  if (!text.trim()) return null;
  if (/\bwta\s*125\b|\bwta125\b|\b125k\b|\bwta\s+challenger\b|\bwomen(?:s)?\s+challenger\b/.test(text)) return "WTA_CHALLENGER";
  if (/\batp\s+challenger\b/.test(text) || (/\bchallenger\b/.test(text) && !/\bwta\b|\bwomen/.test(text))) return "ATP_CHALLENGER";
  if (/\bwta\b|\bwomen/.test(text)) return /\bchallenger\b/.test(text) ? "WTA_CHALLENGER" : "WTA_MAIN";
  if (/\batp\b|\bmasters\b|\bgrand slam\b|\bslam\b|\b250\b|\b500\b|\b1000\b/.test(text)) return /\bchallenger\b/.test(text) ? "ATP_CHALLENGER" : "ATP_MAIN";
  return null;
}

export function evidenceTourCompatible(expected: EvidenceTourFamily | null | undefined, candidate: EvidenceTourFamily | null | undefined) {
  if (!expected || !candidate) return false;
  return expected === candidate;
}

function playerIdentity(stableId: unknown, name: unknown) {
  const id = normalizeEvidenceText(stableId);
  if (id) return `id:${id}`;
  return `name:${normalizeEvidenceText(name) ?? "unknown"}`;
}

export function buildCanonicalEvidenceMatchIdentity(input: EvidenceMatchIdentityInput): CanonicalEvidenceMatchIdentity {
  const players = [playerIdentity(input.player1StableId, input.player1Name), playerIdentity(input.player2StableId, input.player2Name)].sort();
  const tournament = normalizeEvidenceTournament(input.tournament);
  const date = normalizeEvidenceDate(input.date);
  const round = normalizeEvidenceRound(input.round);
  const tourFamily = classifyEvidenceTourFamily(input.tour, input.eventLevel, input.tournament);
  const competitionLevel = normalizeEvidenceCompetitionLevel(input.eventLevel);
  const key = [players.join("~"), tourFamily ?? "UNRESOLVED_TOUR", competitionLevel ?? "UNRESOLVED_LEVEL", tournament ?? "UNRESOLVED_EVENT", date ?? "UNRESOLVED_DATE", round ?? "UNRESOLVED_ROUND"].join("|");
  return { playerPair: players.join("~"), tournament, date, round, tourFamily, competitionLevel, key };
}

export function evidenceMatchIdentityCompatible(expected: CanonicalEvidenceMatchIdentity, candidate: CanonicalEvidenceMatchIdentity) {
  if (expected.playerPair !== candidate.playerPair) return false;
  if (!evidenceTourCompatible(expected.tourFamily, candidate.tourFamily)) return false;
  if (expected.competitionLevel && candidate.competitionLevel && expected.competitionLevel !== candidate.competitionLevel) return false;
  if (expected.tournament && candidate.tournament && expected.tournament !== candidate.tournament) return false;
  if (!evidenceDateCompatible(expected.date, candidate.date)) return false;
  if (expected.round && candidate.round && expected.round !== candidate.round) return false;
  return true;
}

export function uniqueEvidenceMatch<T>(rows: T[], identityOf: (row: T) => CanonicalEvidenceMatchIdentity, expected: CanonicalEvidenceMatchIdentity) {
  const matches = rows.filter((row) => evidenceMatchIdentityCompatible(expected, identityOf(row)));
  return matches.length === 1 ? matches[0] : null;
}
