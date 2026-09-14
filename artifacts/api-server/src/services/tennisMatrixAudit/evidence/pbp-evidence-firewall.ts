import { buildCanonicalEvidenceMatchIdentity, classifyEvidenceTourFamily, evidenceTourCompatible, type CanonicalEvidenceMatchIdentity, type EvidenceTourFamily } from "./evidence-match-identity";

export type ApprovedPbpTour = "ATP_MAIN" | "WTA_MAIN" | "ATP_CHALLENGER" | "WTA_CHALLENGER";

export function canonicalApprovedPbpIdentity(args: {
  tour: ApprovedPbpTour;
  player1: string;
  player2: string;
  tournament?: string | null;
  date?: string | null;
  round?: string | null;
  eventLevel?: string | null;
}) {
  const identity = buildCanonicalEvidenceMatchIdentity({
    player1Name: args.player1,
    player2Name: args.player2,
    tournament: args.tournament,
    date: args.date,
    round: args.round,
    tour: args.tour,
    eventLevel: args.eventLevel,
  });
  if (!evidenceTourCompatible(args.tour as EvidenceTourFamily, identity.tourFamily)) return null;
  // Bug fix: the check above is structurally circular and can never actually catch
  // contamination. buildCanonicalEvidenceMatchIdentity classifies tourFamily from
  // (tour, eventLevel, tournament) joined together, so args.tour's own text (e.g.
  // "WTA_CHALLENGER" normalizes to "wta challenger") always self-confirms the
  // classification regardless of what eventLevel/tournament independently say -- a
  // claimed WTA_CHALLENGER tour with an "ATP Challenger" tournament name was never
  // rejected. Independently classify from eventLevel/tournament alone (excluding the
  // claimed tour) and require it to agree with the claim when it resolves to anything at
  // all; free text alone often can't disambiguate (a generic tournament name), which is
  // not evidence of contamination, so only a resolved, disagreeing signal rejects.
  const freeTextTourFamily = classifyEvidenceTourFamily(args.eventLevel, args.tournament);
  if (freeTextTourFamily && !evidenceTourCompatible(args.tour as EvidenceTourFamily, freeTextTourFamily)) return null;
  return identity;
}

export function claimUniqueApprovedPbp(args: {
  matchId: string | number | null | undefined;
  identity: CanonicalEvidenceMatchIdentity | null;
  seenMatchIds: Set<string>;
  seenCanonicalKeys: Set<string>;
}) {
  const matchId = String(args.matchId ?? "").trim();
  if (!matchId || !args.identity) return false;
  if (args.seenMatchIds.has(matchId) || args.seenCanonicalKeys.has(args.identity.key)) return false;
  args.seenMatchIds.add(matchId);
  args.seenCanonicalKeys.add(args.identity.key);
  return true;
}

export function isApprovedWtaChallengerPbpRow(row: { tour?: unknown; status?: unknown }) {
  return row.tour === "WTA_CHALLENGER" && row.status === "APPROVED_WTA_CHALLENGER_PBP";
}
