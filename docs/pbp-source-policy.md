# PBP Source Policy

## Authorization
The project owner explicitly authorized integration of the candidate 2012–2015 PBP corpus previously identified as `ppaulojr`, including its use as an integrated PBP source in the Truth Engine / Stats Engine / Parlay Builder data layer.

## Important provenance rule
Authorization to integrate does **not** convert the source into an independently verified or officially authoritative source. Every imported record must retain:

- source name and source record ID
- original match/date/tournament/player identifiers
- raw PBP payload when available
- ingestion timestamp
- provenance note
- validation status
- conflicts detected against other sources

The source may be marked `CANDIDATE` until corroboration/verification succeeds. It must not be silently promoted to `VERIFIED`.

## Engine rule
All three engines consume the normalized PBP layer. No engine should independently scrape, reinterpret, or bypass the PBP source router.

## Truth Engine rule
Where another source independently corroborates the same match, the Truth Engine may promote the record according to its existing verification policy. Conflicting records remain `CONFLICT` or `REVIEW_REQUIRED` and are excluded from authoritative feature generation until resolved.
