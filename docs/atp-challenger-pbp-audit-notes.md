# ATP Challenger point-by-point audit — findings for this repo

This note records the outcome of an ATP Challenger historical point-by-point (PBP)
completion audit that also covered the sibling `tennis-truth-engine` repository, which
independently owns Challenger PBP evidence. It is reference-only; no runtime code changed
in this repository as a result.

## Finding: this repo has no ATP Challenger PBP, and no PBP of any kind

Confirmed by full-repo search:

- No file combines real Challenger match data with point-by-point content. The only
  "point-by-point" code here is the synthetic Monte Carlo match simulator
  (`artifacts/api-server/src/services/predictionEngine/simulator.ts`), which generates
  simulated points from aggregate serve/return probabilities — it does not consume or
  store any real recorded point sequence, Challenger or otherwise.
- Sackmann ingestion (`artifacts/api-server/src/services/historicalData/sackmannBackfill.ts`)
  does fetch ATP Challenger/qualifying files (`atp_matches_qual_chall_<year>.csv`), but
  those files carry match results/scores/rankings only — Sackmann's Challenger CSVs have
  never contained point sequences, and this repo does not reference Sackmann's separate
  point-by-point projects (Match Charting Project, `tennis_slam_pointbypoint`).
- "BSD" here refers to the same Bzzoiro API (`sports.bzzoiro.com`) used for PBP in the
  Truth Engine repo, but this repo only calls BSD's `/matches/` (result) and `/rankings/`
  endpoints as a tier-3 fallback (`artifacts/api-server/src/services/tennisData/bsdTennisProvider.ts`).
  It never calls BSD's `/matches/{id}/point-by-point/` endpoint, which is the one the
  Truth Engine repo uses for real PBP.
- `historical_matches` (`lib/db/src/schema/historicalMatches.ts`) has no point-level
  column (no server-sequence, point-winner, or tiebreak-sequence field) — only a `score`
  text field and a per-set `game_margins_player1` jsonb column.
- TennisMyLife is not referenced anywhere in this repository.

## Persistence (confirmed, for the record)

Plain PostgreSQL via `pg` + Drizzle ORM (`lib/db/src/index.ts`, `DATABASE_URL`). Zero
references to Supabase anywhere in this repository (grepped whole tree). This is unrelated
to and independent from the Truth Engine repo's Supabase-backed persistence.

## Metric codes 002, 003, 009, 016, 018, 032, 034, 053

Not applicable to this repo: there is no numbered/coded metric catalog here (metrics are
identified by descriptive names like `eloOverall`, `winPctLast10`, or by arbitrary
specialist-model IDs). That coded-metric convention, and the PBP-dependency flags on it,
exist only in the Truth Engine repo.

## Why nothing was changed here

Per the audit's multi-agent-safety and minimal-change guidance, no new PBP ingestion,
schema, or cross-repo evidence-sharing integration was added to this repository. There is
no existing bridge between this repo's plain-Postgres store and the Truth Engine's
Supabase store, and building one was outside the scope of a gap-fill/activation audit — it
would be new architecture, not activation of something already present, and risks creating
a duplicate/parallel persistence or ingestion path. If this repo is meant to consume the
Truth Engine's certified Challenger PBP evidence in the future, that needs a deliberate,
human-approved integration decision (e.g., an API contract), not an inferred one.

See `tennis-truth-engine`'s
`docs/atp-challenger-pbp-2012-2026-completion-audit.md` for the full cross-repo audit.
