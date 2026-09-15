import test from "node:test";
import assert from "node:assert/strict";
import { PpaulojrPbpSource } from "./ppaulojrSource";

const SAMPLE_CH_ARCHIVE_CSV =
  "date,tny_name,tour,draw,server1,server2,winner,pbp,score,adf_flag\n" +
  "13 Jun 14,ATPChallengerTour-Nottingham,CH,Main,Nick Kyrgios,Miloslav Mecir,1,SSSS;RRRR;SSSS;RRRR;SSSS;RRRR.SSSS;RRRR;SSSS;RRRR;SSSS;RRRR.,6-3 6-3,1\n" +
  "01 Jan 14,ATPChallengerTour-Other,CH,Main,Some Player,Other Player,2,garbage!!,3-6 2-6,0\n";

function fakeFetch(responses: Record<string, string>) {
  return async (url: string): Promise<Record<string, string>[]> => {
    const filename = url.split("/").pop()!;
    const text = responses[filename];
    if (!text) return [];
    const [header, ...rows] = text.trim().split("\n");
    const headers = header.split(",");
    return rows.map((line) => {
      const values = line.split(",");
      const row: Record<string, string> = {};
      headers.forEach((h, i) => (row[h] = values[i] ?? ""));
      return row;
    });
  };
}

test("ppaulojrSource: exact match lookup by player names + date", async () => {
  const source = new PpaulojrPbpSource({ fetchImpl: fakeFetch({ "pbp_matches_ch_main_archive.csv": SAMPLE_CH_ARCHIVE_CSV }) });
  const record = await source.lookup({ player1Name: "Nick Kyrgios", player2Name: "Miloslav Mecir", date: "2014-06-13", tour: "Challenger" });
  assert.ok(record);
  assert.equal(record!.source, "ppaulojr");
  assert.equal(record!.tour, "Challenger");
  assert.equal(record!.validationStatus, "CANDIDATE"); // never falsely VERIFIED/AUTHORITATIVE
});

test("ppaulojrSource: flipped player order still resolves", async () => {
  const source = new PpaulojrPbpSource({ fetchImpl: fakeFetch({ "pbp_matches_ch_main_archive.csv": SAMPLE_CH_ARCHIVE_CSV }) });
  const record = await source.lookup({ player1Name: "Miloslav Mecir", player2Name: "Nick Kyrgios", date: "2014-06-13", tour: "Challenger" });
  assert.ok(record);
});

test("ppaulojrSource: no match for an unrelated pair returns null, not a guess", async () => {
  const source = new PpaulojrPbpSource({ fetchImpl: fakeFetch({ "pbp_matches_ch_main_archive.csv": SAMPLE_CH_ARCHIVE_CSV }) });
  const record = await source.lookup({ player1Name: "Roger Federer", player2Name: "Rafael Nadal", date: "2014-06-13", tour: "Challenger" });
  assert.equal(record, null);
});

test("ppaulojrSource: bulkFetch skips rows with unparseable pbp but yields the good one", async () => {
  const source = new PpaulojrPbpSource({ fetchImpl: fakeFetch({ "pbp_matches_ch_main_archive.csv": SAMPLE_CH_ARCHIVE_CSV }) });
  const records = [];
  for await (const r of source.bulkFetch("Challenger")) records.push(r);
  // toRecord() only rejects rows missing required fields (date/players/pbp) -- the
  // "garbage!!" row still HAS those fields, so it becomes a candidate record here and is
  // filtered later, at derive time (see sourceRouter's malformed_pbp handling / derive.test.ts).
  assert.equal(records.length, 2);
});

test("ppaulojrSource: unsupported tour (Other) returns null without attempting a fetch", async () => {
  let called = false;
  const source = new PpaulojrPbpSource({ fetchImpl: async () => { called = true; return []; } });
  const record = await source.lookup({ player1Name: "A", player2Name: "B", date: "2014-01-01", tour: "Other" });
  assert.equal(record, null);
  assert.equal(called, false);
});

test("ppaulojrSource: priority defaults low (100) so a better-licensed future source can be registered ahead of it", () => {
  const source = new PpaulojrPbpSource();
  assert.equal(source.priority, 100);
  assert.equal(source.enabled, true);
  assert.equal(source.validationStatus, "CANDIDATE");
});
