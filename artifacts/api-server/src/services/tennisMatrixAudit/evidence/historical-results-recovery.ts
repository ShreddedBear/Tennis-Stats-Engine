import type { Treatment } from "./audit-pipeline";

// Task 20 reconciliation:
// - "024" was retargeted to "008" (see the code==="008" branch below). Real code 024
//   is "Hidden Performance Quality" (metric-certification.ts already has a correctly
//   real-catalog-aligned policy for it -- point/game-level performance, expected vs.
//   actual conversion, shot-quality inputs); a deciding-set win rate has nothing to do
//   with that, but is an exact bullet match for real code 008 ("Set Profile":
//   "Set-3/Deciding-Set Win Rate"), which had no engine of its own.
// - "022" and "025" were removed with no retarget. Real 022 ("Serve/Return Shot-Level
//   Efficiency") and 025 ("Match Deterioration Metrics") both already have correctly
//   real-catalog-aligned metric-certification.ts policies requiring shot-level/serve-
//   decay data this repository does not have; their best plausible real homes (the
//   H2H/tiebreak content computed here) are either non-existent (022) or already
//   claimed and shadowed by higher-priority PBP evidence for the same code (025 ->
//   009, whose "Pressure-Point Performance" bullet already wins via Task 18B). Removing
//   them here lets both correctly fall through to their existing, stricter
//   certification-gated handling instead of being shadowed by this file's mismatched
//   credit, consistent with the code 069 fix.
// - Second reconciliation pass: "006"/"049"/"050"/"056"/"058"/"059" were PROCESS_META
//   codes (Decision 1's excluded set) that this file was nonetheless computing player
//   evidence for -- a direct violation of "prevent recovery engines from writing player
//   evidence into them." Removed outright; audit-pipeline.ts already marks them EXCLUDED
//   and never sends them to research, so this also closes the silent-re-entry gap Decision
//   1 asked to guard against at the source, not just at the pipeline boundary.
// - Old "013" (common-opponent quality win rate) retargeted to real "007" ("Common-Opponent
//   Network" -- exact bullet match: "Direct Common Opponents"/"Who Beat/Lost to the Same
//   Players"). This freed real code "013" ("Availability": injuries, withdrawals,
//   *retirements*, medical timeouts, layoffs) for the old "057" branch's retirement/walkover
//   rate, which is an exact match for 013's "Retirements" bullet and was previously
//   stranded under 057 -- a PROCESS_META code ("Evidence Freshness & Confirmation") that
//   could never legitimately host it.
// - Old "023"/"054"/"055" branches all computed the same underlying stat (6-0/blowout set
//   frequency) under three different mismatched codes. Real 023 ("Matchup-Adjusted
//   Metrics") is serve/return style-compatibility; real 054 ("Additional Shot-Level
//   Efficiency") and 055 ("Trajectory / Rolling Metrics") need shot-tracking and
//   match-to-match trend data this file doesn't have. The one bullet this file's data does
//   satisfy -- real code 017 ("Shot & Rally Metrics") -> "Set-Level Dominance": "how often a
//   player wins sets by lopsided scores (6-0/6-1/6-2) versus needing 7-5 or a tiebreak" --
//   is an exact match, so all three were merged into a single 017 entry (kept PARTIAL: only
//   one of 017's several bullets is satisfied).
// - "045" (Favorite Fragility Under Resistance), "046" (Match-State Elo), "051"
//   (Opponent-Specific Set/Match Probabilities), "052" (Entropy & Lead Durability), old
//   "053" (Pressure & Clean-Game Metrics -- already correctly claimed by
//   pbp-score-state-recovery.ts's retargeted 079), and "080" (Common-Opponent &
//   Opponent-Caliber Metrics) were removed with no retarget: each needs data this file does
//   not have (in-match state-conditioned performance, conditional Elo modeling,
//   opponent-specific probability modeling, scoreline entropy/lead-durability calculus, or
//   divergent-outcome/caliber-gap opponent comparison), and the plain match-record
//   aggregates this file was computing for them (three-set frequency, surface win rate,
//   average sets lost, average games per set, straight-set-win-rate-of-wins, and
//   outcome/margin variance respectively) do not satisfy any of their real bullets.
// - Old "006" branch (plain head-to-head win rate) was also removed: real code 006 is
//   PROCESS_META, and a search of the full 81-heading catalog found no other real code
//   whose bullets describe a general adult-tour head-to-head record (the only H2H bullet
//   anywhere, "Junior/ITF-Era Head-to-Head" under real code 072 "Matchup Nuance", is a
//   narrow pre-tour-level carve-out already owned by metric-certification.ts and is not a
//   match for this file's general H2H computation). This is a genuine, honestly-reported
//   gap, not a bug: plain head-to-head record currently has no legitimate code to attach
//   to and is UNAVAILABLE by omission rather than reclassified into an unrelated metric.
// - "068" added (NO_SOURCE denominator-eligibility audit): real 068 is "Streaks /
//   Milestones". "Current Win/Loss Streak Length" and "Longest Win Streak This Season"
//   (defined here as the calendar year of the match date -- this data model has no other
//   season boundary) are directly derivable from the same chronological completed-match
//   rows every other code here already uses. "Tournament Debut Status" is also derivable,
//   given the current match's own tournament name (a new optional `tournament` arg,
//   threaded through from deterministic-historical-results-metrics.server.ts). "Protected-
//   Ranking Status" is NOT derivable -- this row type carries no ranking-protection flag
//   at all -- so it is honestly left uncovered; treatment stays PARTIAL.
// - "080" re-added, correcting the "removed with no retarget" note above: a closer look
//   found its first bullet, "Common-Opponent Divergent Outcome" (cases where this player
//   beat a shared opponent while the other match player lost to that same opponent, or
//   vice versa), IS derivable using the exact same common-opponent identity intersection
//   already built for code 007 -- it needs only win/loss outcomes against a shared
//   opponent, not opponent quality data. Its second bullet, "Opponent-Caliber Performance
//   Gap" (a ceiling-vs-floor spread relative to the player's OWN level), genuinely is not
//   derivable: it requires each player's own historical rank/Elo at match time, which this
//   row type does not carry (only opponentRank/opponentElo, the opponent's quality, are
//   present) -- so that bullet is honestly left uncovered and treatment stays PARTIAL.
// - "005" added: real 005 is "Recent Form". Task18c-rank-form-workload.ts previously
//   claimed this code was PROCESS_META ("Interpretation rules") and removed it on that
//   basis -- that was based on the same stale catalog reading the phase9 metrics.txt
//   heading-numbering fix later corrected; real 005 is "Recent Form", an ordinary
//   reconstructable player metric (evidence-gap.ts and metric-recoverability-map.ts both
//   already list it RECONSTRUCTABLE), not meta. Last-5/last-10 win rate, trend direction
//   (recent-half vs prior-half win rate), straight-set control rate of recent wins, average
//   sets conceded in recent wins, and average recent opponent rank are all directly
//   derivable from the same chronological completed-match rows every other code here uses.
//   "Current Hard-Court Swing" (a contiguous same-surface tournament run, not just an
//   isolated hard-court result) and "Recent-Performance Acceleration" (a rate-of-change
//   figure finer than a two-window trend comparison) are not honestly derivable from this
//   row type and are left uncovered; treatment stays PARTIAL.
// - Old "020" branch (90-day recent-quality-adjusted win record: win rate over the
//   trailing 90 days, banded by opponent rank/Elo quality) retargeted to real code "006"
//   ("Opponent-Adjusted Strength of Schedule" -- exact bullet match: "recent opponent
//   strength" / "comparable-strength results"). Real code 020 ("Level/Tour Transition":
//   event-level history, opponent Elo gap, previous-tournament trajectory) has nothing to
//   do with a quality-banded recent-win-rate calculation -- no tournament level or event
//   context is read here at all -- so it was a mismatched code, exactly like the old
//   013/023/054/055/057 branches this file already retargeted above. This frees real code
//   020 to be built fresh, against its actual definition, elsewhere. Note this is a
//   different fix from wta-official-match-evidence.server.ts's/hybrid-audit-research.server.ts's
//   own existing "020" handling (same_level_matches/same_level_win_pct, filtered by
//   tournament level) -- that one IS a genuine match for real 020 and was left unchanged.
// 10 codes: ["005","006","007","008","010","011","013","017","068","080"].
export const TASK18A_HISTORICAL_RESULTS_CODES = [
  "005","006","007","008","010","011","013","017","068","080",
] as const;

export type Task18aMetricCode = (typeof TASK18A_HISTORICAL_RESULTS_CODES)[number];
export type SetScore = [number, number];
export type HistoricalResultRow = {
  date: string;
  player: string;
  opponent: string;
  won: boolean | null;
  surface: string | null;
  tournament: string | null;
  setsFor: number | null;
  setsAgainst: number | null;
  setScores: SetScore[];
  bestOf: number | null;
  opponentRank: number | null;
  opponentElo: number | null;
  status: string | null;
};

export type HistoricalDerivation = {
  value: string;
  treatment: Treatment;
  sampleSize: number;
  rawInputs: Record<string, unknown>;
  transformation: string;
};

const pct = (n:number,d:number) => d > 0 ? Number((100*n/d).toFixed(2)) : null;
const avg = (xs:number[]) => xs.length ? Number((xs.reduce((a,b)=>a+b,0)/xs.length).toFixed(3)) : null;
const variance = (xs:number[]) => { if(xs.length<2)return 0;const m=xs.reduce((a,b)=>a+b,0)/xs.length;return Number((xs.reduce((s,x)=>s+(x-m)**2,0)/xs.length).toFixed(4)); };
const surfaceKey=(v:string|null|undefined)=>String(v??"").trim().toLowerCase();
const isCompleted=(r:HistoricalResultRow)=>r.won!==null&&!/(walkover|w\/o|wo\b|cancel)/i.test(r.status??"");
const scored=(r:HistoricalResultRow)=>r.setsFor!==null&&r.setsAgainst!==null;
const setRows=(r:HistoricalResultRow)=>r.setScores.length?r.setScores:(scored(r)?[]:[]);
const totalSets=(r:HistoricalResultRow)=>r.setsFor!==null&&r.setsAgainst!==null?r.setsFor+r.setsAgainst:(r.setScores.length?r.setScores.length:null);
const dayDiff=(a:string,b:string)=>Math.floor((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000);
const quality=(r:HistoricalResultRow)=>r.opponentRank!==null?`rank:${r.opponentRank}`:r.opponentElo!==null?`elo:${r.opponentElo}`:null;
const qualityBand=(r:HistoricalResultRow)=>r.opponentRank!==null?(r.opponentRank<=10?"rank_1_10":r.opponentRank<=50?"rank_11_50":r.opponentRank<=100?"rank_51_100":"rank_101_plus"):r.opponentElo!==null?(r.opponentElo>=2000?"elo_2000_plus":r.opponentElo>=1800?"elo_1800_1999":"elo_below_1800"):null;
const blowoutSet=([a,b]:SetScore)=>Math.abs(a-b)>=4;
const bagelSet=([a,b]:SetScore)=>a===0||b===0;
const tiebreakSet=([a,b]:SetScore)=>(a===7&&b===6)||(a===6&&b===7);

function completed(rows:HistoricalResultRow[]){return rows.filter(isCompleted);}
function withSurface(rows:HistoricalResultRow[], surface?:string|null){const s=surfaceKey(surface);return s?rows.filter(r=>surfaceKey(r.surface)===s):rows;}
function baseRecord(rows:HistoricalResultRow[]){const c=completed(rows);const wins=c.filter(r=>r.won===true).length;return {matches:c.length,wins,losses:c.length-wins,winPct:pct(wins,c.length)};}
function scoreSummary(rows:HistoricalResultRow[]){
  const c=completed(rows).filter(scored);const wins=c.filter(r=>r.won===true);const straightWins=wins.filter(r=>r.setsAgainst===0).length;
  const setsLost=c.map(r=>r.setsAgainst!).filter(Number.isFinite);const setScores=c.flatMap(setRows);const tb=setScores.filter(tiebreakSet);const bagels=setScores.filter(bagelSet);const blowouts=setScores.filter(blowoutSet);
  return {matches:c.length,wins:wins.length,straightWins,straightWinPct:pct(straightWins,wins.length),setsLostPerMatch:avg(setsLost),sets:setScores.length,tiebreakSets:tb.length,bagelSets:bagels.length,blowoutSets:blowouts.length,gamesPerSet:avg(setScores.map(([a,b])=>a+b))};
}
function rankedRecord(rows:HistoricalResultRow[]){
  const usable=completed(rows).filter(r=>qualityBand(r)!==null);const bands:Record<string,{w:number;n:number}>={};
  for(const r of usable){const b=qualityBand(r)!;bands[b]??={w:0,n:0};bands[b].n++;if(r.won)bands[b].w++;}
  return {matches:usable.length,bands:Object.fromEntries(Object.entries(bands).map(([k,v])=>[k,{matches:v.n,wins:v.w,winPct:pct(v.w,v.n)}]))};
}
function recent(rows:HistoricalResultRow[],asOfDate:string,days:number){return rows.filter(r=>{const d=dayDiff(r.date,asOfDate);return d>0&&d<=days;});}
function decidingRows(rows:HistoricalResultRow[]){return completed(rows).filter(r=>{const t=totalSets(r);if(t===null)return false;if(r.bestOf===3)return t===3;if(r.bestOf===5)return t===5;return false;});}
function statusRows(rows:HistoricalResultRow[]){return rows.filter(r=>r.status!==null&&r.status.trim()!=="");}
const tournamentKey=(v:string|null|undefined)=>String(v??"").trim().toLowerCase();
function longestWinStreak(rowsAsc:HistoricalResultRow[]){let run=0,longest=0;for(const r of rowsAsc){if(r.won){run++;longest=Math.max(longest,run);}else run=0;}return longest;}
function currentStreak(rowsDesc:HistoricalResultRow[]){if(!rowsDesc.length)return null;const dir=rowsDesc[0].won;let len=0;for(const r of rowsDesc){if(r.won!==dir)break;len++;}return{won:dir,length:len};}

export function deriveHistoricalResultMetric(args:{code:string;player:string;opponent:string;rows:HistoricalResultRow[];asOfDate:string;surface?:string|null;tournament?:string|null;}):HistoricalDerivation|null {
  const code=String(args.code).padStart(3,"0") as Task18aMetricCode;
  if(!(TASK18A_HISTORICAL_RESULTS_CODES as readonly string[]).includes(code))return null;
  const history=args.rows.filter(r=>r.player===args.player&&r.date<args.asOfDate);
  if(!history.length)return null;
  const complete=completed(history);
  const record=baseRecord(history);
  const scoredRows=complete.filter(scored);
  const score=scoreSummary(history);
  const reconstruction=(value:string,sampleSize:number,rawInputs:Record<string,unknown>,transformation:string,treatment:Treatment="RECONSTRUCTED"):HistoricalDerivation=>({value,treatment,sampleSize,rawInputs,transformation});

  if(code==="005"){
    const desc=[...complete].sort((a,b)=>b.date.localeCompare(a.date));
    if(!desc.length)return null;
    const last5=desc.slice(0,5),last10=desc.slice(0,10);
    const winPct5=pct(last5.filter(r=>r.won).length,last5.length),winPct10=pct(last10.filter(r=>r.won).length,last10.length);
    const scoredWins5=last5.filter(r=>r.won).filter(scored);
    const straightSetWins5=scoredWins5.filter(r=>r.setsAgainst===0).length;
    const straightSetControlPct=pct(straightSetWins5,scoredWins5.length);
    const avgSetsConcededInWins=avg(scoredWins5.map(r=>r.setsAgainst!).filter(Number.isFinite));
    const avgOpponentRankLast5=avg(last5.filter(r=>r.opponentRank!==null).map(r=>r.opponentRank!));
    const half=Math.min(5,Math.floor(desc.length/2));let trend:string|null=null;
    if(half>=2){
      const recentHalf=desc.slice(0,half),priorHalf=desc.slice(half,half*2);
      const recentWinPct=pct(recentHalf.filter(r=>r.won).length,recentHalf.length),priorWinPct=pct(priorHalf.filter(r=>r.won).length,priorHalf.length);
      if(recentWinPct!==null&&priorWinPct!==null)trend=recentWinPct>priorWinPct?"IMPROVING":recentWinPct<priorWinPct?"DECLINING":"STABLE";
    }
    return reconstruction(`last5_matches=${last5.length}; last5_win_pct=${winPct5??"NA"}; last10_matches=${last10.length}; last10_win_pct=${winPct10??"NA"}${trend?`; trend_direction=${trend}`:""}${straightSetControlPct!==null?`; straight_set_control_pct=${straightSetControlPct}`:""}${avgSetsConcededInWins!==null?`; avg_sets_conceded_in_wins=${avgSetsConcededInWins}`:""}${avgOpponentRankLast5!==null?`; avg_opponent_rank_last5=${avgOpponentRankLast5}`:""}`,last5.length,{last5:last5.map(r=>({date:r.date,opponent:r.opponent,won:r.won,surface:r.surface})),last10_count:last10.length,trend_window_size:half},"Sort completed prior results chronologically descending; take the most recent 5 and 10 for win-percentage summaries. Trend direction compares the win rate of the most recent half-window against the immediately preceding half-window of equal size (2-5 matches each, whichever the history supports). Straight-set control rate and average sets conceded are computed only over recent wins with preserved set scores. \"Current Hard-Court Swing\" and \"Recent-Performance Acceleration\" are not covered -- the former requires identifying a contiguous same-surface tournament run this row type cannot reliably distinguish from an isolated hard-court result, and the latter requires a rate-of-change model finer than a two-window trend comparison honestly supports -- so treatment stays PARTIAL.","PARTIAL");
  }
  if(code==="010"){
    if(!score.matches)return null;const same=withSurface(scoredRows,args.surface);const ss=scoreSummary(same);
    return reconstruction(`scored_wins=${score.wins}; straight_set_wins=${score.straightWins}; straight_set_win_pct=${score.straightWinPct??"NA"}; same_surface_straight_set_win_pct=${ss.straightWinPct??"NA"}`,score.matches,{scored_matches:score.matches,surface:args.surface??null},"Classify completed wins with zero sets lost; separately repeat on the target surface when present.");
  }
  if(code==="011"){
    if(!score.matches||!score.sets)return null;const winSeries=complete.map(r=>r.won?1:0);const setMargins=scoredRows.map(r=>r.setsFor!-r.setsAgainst!);
    return reconstruction(`match_win_pct=${record.winPct??"NA"}; result_variance=${variance(winSeries)}; set_margin_variance=${variance(setMargins)}; straight_win_pct=${score.straightWinPct??"NA"}; blowout_set_pct=${pct(score.blowoutSets,score.sets)??"NA"}; tiebreak_set_pct=${pct(score.tiebreakSets,score.sets)??"NA"}`,score.matches,{completed_matches:complete.length,scored_matches:score.matches,set_count:score.sets},"Measure floor/volatility from realized match outcomes and observed game-level set margins, straight-set, blowout and tiebreak distributions. Full reconstruction requires preserved per-set game scores.");
  }
  if(code==="007"){
    const opponentHistory=args.rows.filter(r=>r.player===args.opponent&&r.date<args.asOfDate&&isCompleted(r));const theirs=new Set(opponentHistory.map(r=>r.opponent));const common=complete.filter(r=>r.opponent!==args.opponent&&theirs.has(r.opponent)&&quality(r)!==null);if(!common.length)return null;const w=common.filter(r=>r.won).length;
    return reconstruction(`ranked_common_opponent_matches=${common.length}; wins=${w}; win_pct=${pct(w,common.length)??"NA"}; common_opponents=${new Set(common.map(r=>r.opponent)).size}`,common.length,{common_opponents:[...new Set(common.map(r=>r.opponent))].slice(0,50),quality_labels:common.slice(0,50).map(r=>quality(r))},"Intersect canonical opponent identities across both players, require ranking/Elo quality evidence, then aggregate this player's prior results against those shared opponents. Retargeted from the mismatched code 013 to real code 007 (\"Common-Opponent Network\").");
  }
  if(code==="080"){
    const opponentHistory=args.rows.filter(r=>r.player===args.opponent&&r.date<args.asOfDate&&isCompleted(r));if(!opponentHistory.length)return null;
    const theirResultsByOpponent=new Map<string,boolean[]>();for(const r of opponentHistory){const arr=theirResultsByOpponent.get(r.opponent)??[];arr.push(r.won===true);theirResultsByOpponent.set(r.opponent,arr);}
    const sharedOpponents=[...new Set(complete.filter(r=>r.opponent!==args.opponent&&theirResultsByOpponent.has(r.opponent)).map(r=>r.opponent))];if(!sharedOpponents.length)return null;
    let favorable=0,unfavorable=0;
    for(const opp of sharedOpponents){
      const mine=complete.filter(r=>r.opponent===opp);const theirs=theirResultsByOpponent.get(opp)!;
      const iEverWon=mine.some(r=>r.won===true),iEverLost=mine.some(r=>r.won===false);
      const theyEverWon=theirs.some(w=>w===true),theyEverLost=theirs.some(w=>w===false);
      if(iEverWon&&theyEverLost)favorable++;
      if(iEverLost&&theyEverWon)unfavorable++;
    }
    return reconstruction(`common_opponents=${sharedOpponents.length}; favorable_divergent_outcomes=${favorable}; unfavorable_divergent_outcomes=${unfavorable}`,sharedOpponents.length,{common_opponents:sharedOpponents.slice(0,50)},"Intersect canonical opponent identities across both players (same method as code 007); for each shared opponent, flag a favorable divergence when this player has ever beaten them while the other match player has ever lost to them, and an unfavorable divergence in the reverse case. \"Opponent-Caliber Performance Gap\" is not covered -- it requires each player's own historical rank/Elo at match time to compute a ceiling-vs-floor gap relative to their own level, which this row type does not carry -- so treatment stays PARTIAL.","PARTIAL");
  }
  if(code==="006"){
    const r=recent(history,args.asOfDate,90).filter(x=>isCompleted(x)&&quality(x)!==null);if(!r.length)return null;const q=rankedRecord(r);const w=r.filter(x=>x.won).length;
    return reconstruction(`window_days=90; quality_observed_matches=${r.length}; wins=${w}; win_pct=${pct(w,r.length)??"NA"}; bands=${JSON.stringify(q.bands)}`,r.length,{window_start_days:90,quality_observations:r.map(x=>({date:x.date,opponent:x.opponent,quality:quality(x),surface:x.surface,won:x.won})).slice(0,100)},"Use only prior 90-day realized results with observed opponent rank/Elo; preserve quality bands rather than imputing missing quality. Retargeted from the mismatched code 020 to real code 006 (\"Opponent-Adjusted Strength of Schedule\"): this computation's per-band recent win rate against rank/Elo-quality-classified opponents is an exact match for 006's \"recent opponent strength, comparable-strength results\" bullets, not for real code 020 (\"Level/Tour Transition\": event-level history, opponent Elo gap, previous-tournament trajectory), which this computation says nothing about (no tournament-level/event data is read here at all). This does not conflict with wta-official-match-evidence.server.ts's/hybrid-audit-research.server.ts's own existing '020' handling -- those independently compute a genuine tournament-level-based same-level-matches/win-pct signal, which IS a real match for 020, and are left untouched.");
  }
  if(code==="017"){
    if(!score.sets)return null;return reconstruction(`sets=${score.sets}; bagel_sets=${score.bagelSets}; bagel_set_pct=${pct(score.bagelSets,score.sets)??"NA"}; blowout_sets=${score.blowoutSets}; blowout_set_pct=${pct(score.blowoutSets,score.sets)??"NA"}`,score.matches,{scored_matches:score.matches,set_count:score.sets},"Parse player-oriented set scores; count 6-0 sets and sets with a game margin of at least four. Retargeted/merged from the mismatched codes 023/054/055 to real code 017 (\"Shot & Rally Metrics\"), satisfying only its \"Set-Level Dominance\" bullet; the other 017 bullets (forehand/backhand, net play, hold vulnerability, etc.) require shot-level data this file does not have, so treatment stays PARTIAL.","PARTIAL");
  }
  if(code==="008"){
    const d=decidingRows(history);if(!d.length)return null;const w=d.filter(r=>r.won).length;return reconstruction(`deciding_matches=${d.length}; deciding_wins=${w}; deciding_set_win_pct=${pct(w,d.length)??"NA"}`,d.length,{best_of_observed:d.map(r=>r.bestOf),set_totals:d.map(totalSets)},"Use only matches whose observed best-of format and set total prove that a deciding set was played.");
  }
  if(code==="013"){
    const sr=statusRows(history);if(!sr.length)return null;const rw=sr.filter(r=>/(retir|walkover|w\/o|wo\b)/i.test(r.status??"")).length;return reconstruction(`status_observed_matches=${sr.length}; retirement_or_walkover=${rw}; observed_status_rate_pct=${pct(rw,sr.length)??"NA"}`,sr.length,{status_values:sr.map(r=>r.status).slice(0,100)},"Use only rows with an explicitly preserved status field; because status preservation is incomplete, keep treatment PARTIAL. Retargeted from the mismatched code 057 to real code 013 (\"Availability\"), whose \"Retirements\" bullet is an exact match.","PARTIAL");
  }
  if(code==="068"){
    if(!complete.length)return null;
    const desc=[...complete].sort((a,b)=>b.date.localeCompare(a.date));const asc=[...complete].sort((a,b)=>a.date.localeCompare(b.date));
    const cur=currentStreak(desc);if(!cur)return null;
    const season=args.asOfDate.slice(0,4),seasonRows=asc.filter(r=>r.date.slice(0,4)===season);
    const longest=longestWinStreak(seasonRows);
    const tKey=tournamentKey(args.tournament);const debut=tKey?!history.some(r=>tournamentKey(r.tournament)===tKey):null;
    return reconstruction(`current_streak=${cur.won?"W":"L"}${cur.length}; longest_win_streak_${season}=${longest}; season_matches=${seasonRows.length}${debut===null?"":`; tournament_debut=${debut}`}`,complete.length,{completed_matches:complete.length,season,season_matches:seasonRows.length,tournament:args.tournament??null},"Sort completed prior results chronologically; the current streak is the unbroken run of identical results ending at the most recent prior match, and the longest win streak scans consecutive wins within the calendar year of the target date. Tournament debut status compares the current match's tournament name against every prior tournament played (only reported when a tournament name is supplied). Protected-ranking status is not covered -- this row type carries no ranking-protection flag -- so treatment stays PARTIAL.","PARTIAL");
  }
  return null;
}
