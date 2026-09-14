import { describe, expect, it } from "vitest";
import { buildCalibrationSnapshot } from "./calibration-snapshot";

const buckets = [
  { id: "b1", bucket_code: "60-69", wp_min: 60, wp_max: 69.99, wins: 41, graded: 60 },
];

describe("buildCalibrationSnapshot", () => {
  it("freezes the version, bucket sample, and verified win rate used by the gate", () => {
    expect(buildCalibrationSnapshot({
      versionId: "cal-v1",
      matrixWp: 62,
      buckets,
      independentLow: 58,
      independentHigh: 66,
    })).toEqual({
      calibrationVersionId: "cal-v1",
      bucketCode: "60-69",
      bucketWins: 41,
      bucketGraded: 60,
      verifiedWinRate: 68.3,
      calibratedLow: 63,
      calibratedHigh: 73,
    });
  });

  it("preserves unavailable calibration as null instead of fabricating a 0-5 range", () => {
    expect(buildCalibrationSnapshot({
      versionId: null,
      matrixWp: null,
      buckets: [],
      independentLow: null,
      independentHigh: null,
    })).toMatchObject({
      bucketCode: null,
      verifiedWinRate: null,
      calibratedLow: null,
      calibratedHigh: null,
    });
  });

  it("uses the independent range only when both bounds exist", () => {
    expect(buildCalibrationSnapshot({
      versionId: "cal-v1",
      matrixWp: 55,
      buckets,
      independentLow: 58,
      independentHigh: null,
    }).calibratedLow).toBeNull();
  });
});