import { bucketFor, winRate } from "./audit-engine";

export type CalibrationBucket = {
  id?: string;
  bucket_code: string;
  wp_min: number;
  wp_max: number;
  wins: number;
  graded: number;
};

export function buildCalibrationSnapshot(args: {
  versionId: string | null;
  matrixWp: number | null;
  buckets: CalibrationBucket[];
  independentLow: number | null;
  independentHigh: number | null;
}) {
  const bucket = bucketFor(args.matrixWp, args.buckets);
  const verifiedWinRate = bucket ? winRate(bucket.wins, bucket.graded) : null;
  const hasIndependentRange = args.independentLow !== null && args.independentHigh !== null;
  const centre = verifiedWinRate ?? (hasIndependentRange ? (args.independentLow! + args.independentHigh!) / 2 : null);

  return {
    calibrationVersionId: args.versionId,
    bucketCode: bucket?.bucket_code ?? null,
    bucketWins: bucket?.wins ?? null,
    bucketGraded: bucket?.graded ?? null,
    verifiedWinRate,
    calibratedLow: centre === null ? null : Math.max(0, Math.round(centre - 5)),
    calibratedHigh: centre === null ? null : Math.min(100, Math.round(centre + 5)),
  };
}