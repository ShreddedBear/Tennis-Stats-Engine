// Fast local context for the upload-review screen.
// IMPORTANT: this path must never synchronously read/parse the large historical
// ATP/WTA CSV datasets. Exact/current round and date belong to persisted/web
// identity resolution; this module only supplies deterministic tournament facts.

type Fields = Record<string, string | null>;

function norm(v: string | null | undefined) {
  return String(v ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function usable(v: string | null | undefined) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = norm(s);
  if (/^(unavailable|unknown|n a|na|null|none|-)$/.test(n)) return null;
  return s;
}

function cleanTournament(v: string | null | undefined) {
  const good = usable(v);
  if (!good) return null;
  const raw = good.replace(/^\$?[\d,]+\s*(?:vol(?:ume)?)?\s*/i, "").trim();
  const n = norm(raw);
  if (/cincinn/.test(n)) return "Cincinnati Open";
  if (/montreal|canadian open|rogers cup/.test(n)) return "Canadian Open";
  if (/us open/.test(n)) return "US Open";
  return raw || null;
}

function normalizeRound(v: string | null | undefined) {
  const good = usable(v);
  if (!good) return null;
  const s = norm(good);
  if (/quarter/.test(s)) return "Quarterfinals";
  if (/semi/.test(s)) return "Semifinals";
  if (/^final/.test(s)) return "Final";
  if (/round of 16|2nd round|second round/.test(s)) return "Round of 16";
  if (/round of 32|1st round|first round/.test(s)) return "Round of 32";
  if (/round of 64/.test(s)) return "Round of 64";
  return good;
}

function hintTournament(hints: Fields) {
  return cleanTournament(hints.tournament ?? hints.event ?? null);
}

function hintDate(hints: Fields) {
  const v = usable(hints.scheduled_date ?? hints.date ?? null);
  if (!v) return null;
  const iso = v.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const today = new Date().toISOString().slice(0, 10);
  if (/\btoday\b/i.test(v)) return today;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  if (/\btomorrow\b/i.test(v)) return tomorrow;
  return null;
}

function registryContext(tournament: string | null): Fields {
  const n = norm(tournament);
  if (/cincinnati/.test(n)) {
    return {
      tournament: "Cincinnati Open",
      event_level: null,
      round: null,
      scheduled_date: null,
      surface: "Hard",
      best_of: "3",
    };
  }
  return {
    tournament: null,
    event_level: null,
    round: null,
    scheduled_date: null,
    surface: null,
    best_of: null,
  };
}

export function resolveLocalMatchContext(_p1: string, _p2: string, hints: Fields) {
  const tournament = hintTournament(hints);
  const registry = registryContext(tournament);
  const hintedLevel = usable(hints.event_level);
  const hintedSurface = usable(hints.surface);
  const hintedBestOf = usable(hints.best_of);
  const fields: Fields = {
    tournament: registry.tournament ?? tournament,
    event_level: hintedLevel,
    round: normalizeRound(hints.round),
    scheduled_date: hintDate(hints),
    surface: hintedSurface ?? registry.surface,
    best_of: hintedBestOf ?? registry.best_of,
  };
  const sources: string[] = [];
  if (registry.tournament) sources.push("Static tournament context registry");
  return {
    ok: Object.values(fields).some(Boolean),
    fields,
    sources,
    sourceUrl: null,
    unresolvedReason: "Fast local resolver supplies deterministic event facts only; exact current round/date require persisted or bounded web verification.",
  };
}
