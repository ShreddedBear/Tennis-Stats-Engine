// Shared "keep driving until actually done" logic for the Upload page's
// commit-time drive loop and the Active Slate page's Resume Audit / auto-
// resume loop. Both loops call the runAuditPipeline server function
// repeatedly (each call executes one time-boxed slice of the pipeline) until
// the run reports complete. Without this module, a run whose *current*
// stage keeps failing in an unrecoverable way (e.g. no active rule document
// version, an invalid API key, exhausted provider credits) looks
// indistinguishable from a run that's still legitimately making forward
// progress -- both come back as "not complete yet, retry" -- so the caller
// blindly re-invokes it for the full retry budget, then reports something
// like "still processing" even though nothing was ever going to change.
//
// The fix is not to guess whether an error is retryable from its text --
// that's exactly the kind of fragile heuristic that quietly breaks. Instead:
// a stage that fails with the *exact same* stage+message on two consecutive
// slices has demonstrably not made progress between those two attempts.
// That is real signal a text-based retryable/permanent classifier can't
// give you, and it's enough to stop burning the retry budget and surface
// the actual blocking reason instead.

export interface DriveOutcome {
  complete: boolean;
  nextStage: string | null;
  failures: Array<{ stage: string; message: string }>;
}

// null means "no failure to report" -- either the run completed, or this
// slice made it further than a prior failure without hitting a new one
// (ordinary in-progress work, e.g. a PARTIAL metric-execution stage that
// just needs another slice).
export function failureSignature(outcome: DriveOutcome): string | null {
  if (outcome.complete) return null;
  const first = outcome.failures[0];
  if (!first) return null;
  return `${outcome.nextStage ?? first.stage}|${first.message}`;
}

// True exactly when the same failure signature was seen on the immediately
// preceding slice for this same run -- i.e., two consecutive attempts ended
// up in the identical failed state with no forward movement in between.
export function isStuck(previousSignature: string | null | undefined, currentSignature: string | null): boolean {
  return currentSignature !== null && previousSignature === currentSignature;
}

// Turns a failure signature back into a human-readable reason, for the
// toast/error banner shown once a run is declared stuck rather than merely
// slow.
export function describeFailure(outcome: DriveOutcome): string {
  const first = outcome.failures[0];
  if (!first) return "Audit run stopped making progress for an unknown reason.";
  return `${first.stage}: ${first.message}`;
}
