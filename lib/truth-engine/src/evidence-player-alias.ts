export function normalizeEvidenceIdentity(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function surname(value: string) {
  const parts = normalizeEvidenceIdentity(value).split(" ").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

export function isSurnameOnlyEvidenceIdentity(value: string | null | undefined) {
  const parts = normalizeEvidenceIdentity(value).split(" ").filter(Boolean);
  return parts.length === 1;
}

/**
 * Resolve a surname-only uploaded identity only when the warehouse candidate
 * set proves exactly one full canonical name. This is intentionally strict:
 * no fuzzy matching, initials, prefix matching, or best-effort selection.
 */
export function uniqueCanonicalWarehouseIdentity(
  uploaded: string,
  warehouseCandidates: Array<string | null | undefined>,
): string | null {
  if (!isSurnameOnlyEvidenceIdentity(uploaded)) return uploaded;
  const wantedSurname = normalizeEvidenceIdentity(uploaded);
  if (!wantedSurname) return null;

  const byNormalized = new Map<string, string>();
  for (const candidate of warehouseCandidates) {
    const display = String(candidate ?? "").trim();
    const normalized = normalizeEvidenceIdentity(display);
    const parts = normalized.split(" ").filter(Boolean);
    if (parts.length < 2 || parts[parts.length - 1] !== wantedSurname) continue;
    if (!byNormalized.has(normalized)) byNormalized.set(normalized, display);
  }
  if (byNormalized.size === 1) return [...byNormalized.values()][0];

  // Official feeds commonly carry both a full display name and an
  // initial+surname alias for the same player (for example "Brandon
  // Nakashima" and "B. Nakashima"). Collapse that pair only when there is
  // exactly one full-name candidate and every remaining candidate has the
  // same surname and matching first initial. Multiple full names still fail
  // closed as genuinely ambiguous.
  const candidates = [...byNormalized.entries()].map(([normalized, display]) => ({
    display,
    parts: normalized.split(" ").filter(Boolean),
  }));
  const full = candidates.filter(({ parts }) => parts.length >= 2 && parts[0].length > 1);
  if (full.length !== 1) return null;
  const [canonical] = full;
  const firstInitial = canonical.parts[0][0];
  const canonicalSurname = canonical.parts[canonical.parts.length - 1];
  const aliasesMatch = candidates.every(({ parts }) => {
    if (parts.join(" ") === canonical.parts.join(" ")) return true;
    return parts.length === 2
      && parts[0].length === 1
      && parts[0] === firstInitial
      && parts[1] === canonicalSurname;
  });
  return aliasesMatch ? canonical.display : null;
}

/**
 * Evidence written by older completion sweeps sometimes used only a surname
 * (for example "Gauff") while the audit asks for the canonical display name
 * ("Coco Gauff"). Recover only the exact surname alias implied by an already
 * canonical matchup; no fuzzy/edit-distance matching is permitted here.
 */
export function safeEvidenceAliases(player: string, opponent: string) {
  const aliases = new Set<string>([player]);
  const playerSurname = surname(player);
  const opponentSurname = surname(opponent);
  if (playerSurname && playerSurname !== opponentSurname) aliases.add(playerSurname);
  return [...aliases];
}

export function evidenceNameMatches(stored: string | null | undefined, requested: string, opponent: string) {
  const wanted = new Set(safeEvidenceAliases(requested, opponent).map(normalizeEvidenceIdentity));
  return wanted.has(normalizeEvidenceIdentity(stored));
}

export function evidencePairMatches(
  storedPlayer: string | null | undefined,
  storedOpponent: string | null | undefined,
  player: string,
  opponent: string,
) {
  return evidenceNameMatches(storedPlayer, player, opponent) && evidenceNameMatches(storedOpponent, opponent, player);
}
