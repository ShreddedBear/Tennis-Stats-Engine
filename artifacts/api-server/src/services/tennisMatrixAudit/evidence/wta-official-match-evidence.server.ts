import type { MetricFinding, SourceRef } from "./audit-pipeline";
import { buildTrustedInternalFinding } from "./trusted-internal-evidence";

const BASE = "https://api.wtatennis.com/tennis";
const RANKED = `${BASE}/players/ranked?type=rankSingles&metric=singles&page=0&pageSize=500`;
const SUPPORTED = new Set(["005", "006", "007", "008", "009", "010", "011", "012", "013", "020", "028", "030", "068", "080"]);

type PlayerRef = { id?: string | number; fullName?: string };
type RankingRow = { player?: PlayerRef };
type MatchRow = {
  StartDate?: string;
  Surface?: string;
  TournamentLevel?: string;
  TournamentName?: string;
  TournamentType?: string;
  opponent?: { id?: string | number; fullName?: string } | null;
  player_1?: string;
  player_2?: string;
  rank_1?: number | null;
  rank_2?: number | null;
  reason_code?: string;
  round_name?: string;
  s_d_flag?: string;
  scores?: string;
  tourn_year?: string;
  winner?: number | string;
  tournament?: {
    tournamentGroup?: { id?: string | number; name?: string; level?: string } | null;
    year?: number;
    title?: string;
    startDate?: string;
    endDate?: string;
    surface?: string;
    inOutdoor?: string;
    city?: string;
    country?: string;
    level?: string;
  } | null;
};

type History = { playerId: string; matches: MatchRow[]; urls: string[] };

type SideSummary = {
  matches: number;
  wins: number;
  winPct: number;
  last5WinPct: number | null;
  last10WinPct: number | null;
  setsWon: number;
  setsPlayed: number;
  setWinPct: number | null;
  last5SetWinPct: number | null;
  last10SetWinPct: number | null;
  set1WinPct: number | null;
  set2WinPct: number | null;
  decidingSetWinPct: number | null;
  decidingSetsPlayed: number;
  winAfterLosingSet1Pct: number | null;
  winAfterWinningSet1Pct: number | null;
  secondSetAfterLosingSet1WinPct: number | null;
  straightSetMatchWinPct: number | null;
  comebackWinPct: number | null;
  tiebreakWinPct: number | null;
  tiebreaksPlayed: number;
  performanceVariance: number | null;
  floorCeilingRange: number | null;
  matches7: number;
  matches14: number;
  matches28: number;
  sets14: number;
  threeSetters14: number;
  qualifying14: number;
  daysSinceLastMatch: number | null;
  recentInterMatchGapDays: number | null;
  tournamentSwitchesLast10: number;
  currentStreakSigned: number;
  longestWinStreak: number;
  longestLayoffDays: number | null;
  layoffs30: number;
  layoffs60: number;
  layoffs90: number;
  returnAfterLayoffWinPct: number | null;
  sameLevelMatches: number;
  sameLevelWinPct: number | null;
  sameTournamentMatches: number;
  sameTournamentWinPct: number | null;
  avgOpponentRankLast10: number | null;
  bestRankedRecentWin: number | null;
  top20WinPct: number | null;
  top50WinPct: number | null;
  top100WinPct: number | null;
  badLossRateRank100Plus: number | null;
  sourceUrls: string[];
};

const norm = (value: unknown) => String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const pct = (a: number, b: number) => b > 0 ? 100 * a / b : null;
const codeOf = (value: unknown) => { const m = String(value ?? "").match(/(\d{1,3})$/); return m ? m[1].padStart(3, "0") : String(value ?? "").padStart(3, "0"); };
function contextDate(context: string) { const m = context.match(/(?:date|scheduled_date)\s*[:=]?\s*(20\d{2}-\d{2}-\d{2})/i); return m?.[1] ?? new Date().toISOString().slice(0, 10); }
function contextSurface(context: string) { const m = context.match(/surface\s*[:=]?\s*(hard|clay|grass|carpet)/i); return m?.[1]?.toLowerCase() ?? null; }
function contextTournament(context: string) { const m = context.match(/tournament\s*[:=]\s*([^|·\n]+)/i); return m?.[1]?.trim() ?? null; }
function explicitWtaMain(context: string) { const s = norm(context); if (!/(^| )wta( |$)/.test(s)) return false; if (["125", "challenger", "itf", "futures", "utr"].some(x => s.includes(x))) return false; return true; }
function allowedMainLevel(level: unknown) { const s = norm(level); if (!s || ["125", "challenger", "itf", "futures"].some(x => s.includes(x))) return false; return /(grand slam|wta 1000|wta 500|wta 250|tour finals|wta finals|premier|international)/.test(s); }
function dayDiff(a: string, b: string) { return Math.max(0, Math.round((Date.parse(`${b.slice(0,10)}T00:00:00Z`) - Date.parse(`${a.slice(0,10)}T00:00:00Z`)) / 86400000)); }
// A gap spanning a calendar-year boundary is the routine off-season break
// every tour player takes, not an "Availability" signal (injury/withdrawal/
// retirement/medical timeout). See docs/metric-audit-013-availability.md and
// the equivalent ATP fix in availability-layoff.server.ts.
function crossesCalendarYearBoundary(earlierDate: string, laterDate: string) { return earlierDate.slice(0,4) !== laterDate.slice(0,4); }
function mean(values: number[]) { return values.length ? values.reduce((a,b)=>a+b,0)/values.length : null; }
function variance(values: number[]) { if (!values.length) return null; const m=mean(values)!; return values.reduce((s,v)=>s+(v-m)**2,0)/values.length; }

async function getJson(url: string) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "tennis-truth-engine-evidence-coverage/1.0" }, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`WTA official API ${r.status}: ${url}`);
  // Deliberately untyped: this is a third-party API response whose shape is not ours to
  // assert. Every read below narrows it defensively (Array.isArray, optional chaining)
  // before use, and that narrowing -- not a declared type -- is what makes it safe. Under
  // the standalone app's DOM lib this was implicitly `any`; the annotation makes the same
  // contract explicit now that the server tsconfig resolves it to `{}`.
  return r.json() as Promise<any>;
}

async function resolvePlayerId(player: string): Promise<string | null> {
  const payload = await getJson(RANKED);
  const rows = (Array.isArray(payload) ? payload : Array.isArray(payload?.content) ? payload.content : []) as RankingRow[];
  const target = norm(player);
  const exact = rows.filter(row => norm(row.player?.fullName) === target && row.player?.id != null);
  if (exact.length !== 1) return null;
  return String(exact[0].player!.id);
}

async function loadHistory(player: string, asOfDate: string): Promise<History | null> {
  const playerId = await resolvePlayerId(player);
  if (!playerId) return null;
  const year = Number(asOfDate.slice(0,4));
  const years = [year - 1, year].filter(y => y >= 1960);
  const urls = years.map(y => `${BASE}/players/${encodeURIComponent(playerId)}/matches?year=${y}&page=0&pageSize=500`);
  const payloads = await Promise.all(urls.map(async url => { try { return await getJson(url); } catch { return null; } }));
  const matches = payloads.flatMap(payload => Array.isArray(payload?.matches) ? payload.matches as MatchRow[] : [])
    .filter(row => String(row.s_d_flag ?? "").toUpperCase() === "S")
    .filter(row => row.opponent?.fullName && row.scores && row.StartDate)
    .filter(row => String(row.StartDate).slice(0,10) <= asOfDate)
    .filter(row => allowedMainLevel(row.tournament?.tournamentGroup?.level ?? row.tournament?.level ?? row.TournamentLevel));
  const seen = new Set<string>();
  return { playerId, urls, matches: matches.filter(row => { const k=[row.StartDate,row.TournamentName,row.round_name,row.player_1,row.player_2,row.scores].join("|"); if(seen.has(k))return false; seen.add(k); return true; }).sort((a,b)=>String(b.StartDate).localeCompare(String(a.StartDate))) };
}

function parseSets(score: string): Array<[number,number]> {
  const out: Array<[number,number]> = [];
  for (const token of score.replace(/RET|W\/O|DEF/gi, " ").split(/\s+/)) {
    const m=token.match(/^(\d+)-(\d+)(?:\([^)]*\))?$/); if(!m) continue;
    out.push([Number(m[1]),Number(m[2])]);
  }
  return out;
}
function playerWon(row: MatchRow, playerId: string) { const side = String(row.player_1 ?? "").trim() === playerId ? 1 : String(row.player_2 ?? "").trim() === playerId ? 2 : null; return side != null && Number(row.winner) === side; }
function orientedSets(row: MatchRow, playerId: string) { const sets=parseSets(String(row.scores ?? "")); const playerSide=String(row.player_1 ?? "").trim()===playerId?1:String(row.player_2??"").trim()===playerId?2:null; if(!playerSide)return []; return playerSide===1?sets:sets.map(([a,b])=>[b,a] as [number,number]); }

function summarize(history: History, asOfDate: string, context: string): SideSummary | null {
  const cutoff = new Date(`${asOfDate}T00:00:00Z`); cutoff.setUTCDate(cutoff.getUTCDate()-370); const minDate=cutoff.toISOString().slice(0,10);
  const rows=history.matches.filter(r=>String(r.StartDate).slice(0,10)>=minDate); if(!rows.length)return null;
  const surface=contextSurface(context), tournament=contextTournament(context), levelMatch=context.match(/(?:level|tour)\s*[:=]\s*([^|·\n]+)/i)?.[1]?.trim()??"WTA MAIN";
  const winFlags=rows.map(r=>playerWon(r,history.playerId)); const wins=winFlags.filter(Boolean).length;
  const setRecords=rows.map(r=>orientedSets(r,history.playerId));
  const totalSets=setRecords.reduce((n,s)=>n+s.length,0), setsWon=setRecords.reduce((n,s)=>n+s.filter(([a,b])=>a>b).length,0);
  const recentPct=(n:number)=>pct(winFlags.slice(0,n).filter(Boolean).length,Math.min(n,winFlags.length));
  const setRecentPct=(n:number)=>{const s=setRecords.slice(0,n).flat();return pct(s.filter(([a,b])=>a>b).length,s.length)};
  const set1=setRecords.map(s=>s[0]).filter(Boolean),set2=setRecords.map(s=>s[1]).filter(Boolean);
  const deciding=setRecords.map(s=>s.length>=3?s[2]:null).filter((x):x is [number,number]=>!!x);
  const lost1=rows.map((r,i)=>({won:winFlags[i],sets:setRecords[i]})).filter(x=>x.sets[0]&&x.sets[0][0]<x.sets[0][1]);
  const won1=rows.map((r,i)=>({won:winFlags[i],sets:setRecords[i]})).filter(x=>x.sets[0]&&x.sets[0][0]>x.sets[0][1]);
  const straightWins=rows.map((r,i)=>winFlags[i]&&setRecords[i].length===2&&setRecords[i].every(([a,b])=>a>b)).filter(Boolean).length;
  const tbs=setRecords.flat().filter(([a,b])=>Math.max(a,b)===7&&Math.min(a,b)>=6);
  const setMargins=setRecords.map(s=>s.reduce((n,[a,b])=>n+(a>b?1:-1),0));
  const dates=rows.map(r=>String(r.StartDate).slice(0,10));
  const gaps=dates.slice(0,-1).map((d,i)=>dayDiff(dates[i+1],d));
  const inSeason=dates.slice(0,-1).map((d,i)=>!crossesCalendarYearBoundary(dates[i+1],d));
  const inSeasonGaps=gaps.filter((_,i)=>inSeason[i]);
  const returns=rows.slice(0,-1).map((r,i)=>({gap:gaps[i],won:winFlags[i],inSeason:inSeason[i]}));
  let streak=0; for(let i=0;i<winFlags.length;i++){if(i===0)streak=winFlags[i]?1:-1;else if((streak>0)===winFlags[i])streak+=winFlags[i]?1:-1;else break;}
  let longest=0,cur=0; for(const won of [...winFlags].reverse()){cur=won?cur+1:0;longest=Math.max(longest,cur)}
  const d7=dates.filter(d=>dayDiff(d,asOfDate)<=7).length,d14=dates.filter(d=>dayDiff(d,asOfDate)<=14).length,d28=dates.filter(d=>dayDiff(d,asOfDate)<=28).length;
  const idx14=dates.map((d,i)=>dayDiff(d,asOfDate)<=14?i:-1).filter(i=>i>=0),sets14=idx14.reduce((n,i)=>n+setRecords[i].length,0),three14=idx14.filter(i=>setRecords[i].length>=3).length,qual14=idx14.filter(i=>/qual/i.test(String(rows[i].round_name??""))).length;
  const last10=rows.slice(0,10), switches=last10.slice(1).filter((r,i)=>norm(r.TournamentName??r.tournament?.title)!==norm(last10[i].TournamentName??last10[i].tournament?.title)).length;
  const sameLevel=rows.filter(r=>allowedMainLevel(r.tournament?.tournamentGroup?.level??r.TournamentLevel) && !norm(levelMatch).includes("125"));
  const sameTournament=tournament?rows.filter(r=>norm(r.TournamentName??r.tournament?.title).includes(norm(tournament))||norm(tournament).includes(norm(r.TournamentName??r.tournament?.title))):[];
  const opponentRank=(r:MatchRow)=>{const side=String(r.player_1??"").trim()===history.playerId?1:String(r.player_2??"").trim()===history.playerId?2:null;const value=side===1?r.rank_2:side===2?r.rank_1:null;const n=Number(value);return Number.isFinite(n)&&n>0?n:null};
  const ranked=rows.map((r,i)=>({rank:opponentRank(r),won:winFlags[i]})).filter((x):x is {rank:number;won:boolean}=>x.rank!=null);
  const recentRanks=ranked.slice(0,10).map(x=>x.rank), winningRanks=ranked.filter(x=>x.won).map(x=>x.rank);
  const bucket=(maxRank:number)=>{const x=ranked.filter(v=>v.rank<=maxRank);return pct(x.filter(v=>v.won).length,x.length)};
  const weakLosses=ranked.filter(x=>x.rank>=100), sourceUrls=history.urls;
  return {matches:rows.length,wins,winPct:pct(wins,rows.length)!,last5WinPct:recentPct(5),last10WinPct:recentPct(10),setsWon,setsPlayed:totalSets,setWinPct:pct(setsWon,totalSets),last5SetWinPct:setRecentPct(5),last10SetWinPct:setRecentPct(10),set1WinPct:pct(set1.filter(([a,b])=>a>b).length,set1.length),set2WinPct:pct(set2.filter(([a,b])=>a>b).length,set2.length),decidingSetWinPct:pct(deciding.filter(([a,b])=>a>b).length,deciding.length),decidingSetsPlayed:deciding.length,winAfterLosingSet1Pct:pct(lost1.filter(x=>x.won).length,lost1.length),winAfterWinningSet1Pct:pct(won1.filter(x=>x.won).length,won1.length),secondSetAfterLosingSet1WinPct:pct(lost1.filter(x=>x.sets[1]&&x.sets[1][0]>x.sets[1][1]).length,lost1.filter(x=>x.sets[1]).length),straightSetMatchWinPct:pct(straightWins,rows.length),comebackWinPct:pct(lost1.filter(x=>x.won).length,lost1.length),tiebreakWinPct:pct(tbs.filter(([a,b])=>a>b).length,tbs.length),tiebreaksPlayed:tbs.length,performanceVariance:variance(setMargins),floorCeilingRange:setMargins.length?Math.max(...setMargins)-Math.min(...setMargins):null,matches7:d7,matches14:d14,matches28:d28,sets14,threeSetters14:three14,qualifying14:qual14,daysSinceLastMatch:dates[0]?dayDiff(dates[0],asOfDate):null,recentInterMatchGapDays:gaps[0]??null,tournamentSwitchesLast10:switches,currentStreakSigned:streak,longestWinStreak:longest,longestLayoffDays:inSeasonGaps.length?Math.max(...inSeasonGaps):null,layoffs30:inSeasonGaps.filter(g=>g>=30).length,layoffs60:inSeasonGaps.filter(g=>g>=60).length,layoffs90:inSeasonGaps.filter(g=>g>=90).length,returnAfterLayoffWinPct:pct(returns.filter(x=>x.inSeason&&x.gap>=30&&x.won).length,returns.filter(x=>x.inSeason&&x.gap>=30).length),sameLevelMatches:sameLevel.length,sameLevelWinPct:pct(sameLevel.filter(r=>playerWon(r,history.playerId)).length,sameLevel.length),sameTournamentMatches:sameTournament.length,sameTournamentWinPct:pct(sameTournament.filter(r=>playerWon(r,history.playerId)).length,sameTournament.length),avgOpponentRankLast10:mean(recentRanks),bestRankedRecentWin:winningRanks.length?Math.min(...winningRanks):null,top20WinPct:bucket(20),top50WinPct:bucket(50),top100WinPct:bucket(100),badLossRateRank100Plus:pct(weakLosses.filter(x=>!x.won).length,weakLosses.length),sourceUrls};
}

function fmt(v:number|null, digits=1){return v==null?"NA":v.toFixed(digits)}
function metricValue(code:string,s:SideSummary){switch(code){
  case"005":return `last5_win_pct=${fmt(s.last5WinPct)}; last10_win_pct=${fmt(s.last10WinPct)}; last5_set_win_pct=${fmt(s.last5SetWinPct)}; last10_set_win_pct=${fmt(s.last10SetWinPct)}; set_win_pct=${fmt(s.setWinPct)}; sample_matches=${s.matches}`;
  case"006":return `official_opponent_rank_avg_last10=${fmt(s.avgOpponentRankLast10)}; best_ranked_recent_win=${fmt(s.bestRankedRecentWin,0)}; win_pct_vs_top20=${fmt(s.top20WinPct)}; win_pct_vs_top50=${fmt(s.top50WinPct)}; win_pct_vs_top100=${fmt(s.top100WinPct)}; loss_rate_vs_rank100_plus=${fmt(s.badLossRateRank100Plus)}`;
  case"008":return `set1_win_pct=${fmt(s.set1WinPct)}; set2_win_pct=${fmt(s.set2WinPct)}; deciding_set_win_pct=${fmt(s.decidingSetWinPct)}; deciding_sets_played=${s.decidingSetsPlayed}; win_after_losing_set1_pct=${fmt(s.winAfterLosingSet1Pct)}; win_after_winning_set1_pct=${fmt(s.winAfterWinningSet1Pct)}; second_set_after_losing_set1_win_pct=${fmt(s.secondSetAfterLosingSet1WinPct)}`;
  case"009":return `win_after_losing_set1_pct=${fmt(s.comebackWinPct)}; tiebreak_win_pct=${fmt(s.tiebreakWinPct)}; tiebreaks_played=${s.tiebreaksPlayed}`;
  case"010":return `straight_set_match_win_pct=${fmt(s.straightSetMatchWinPct)}; all_match_denominator=${s.matches}`;
  case"011":return `performance_variance=${fmt(s.performanceVariance,3)}; performance_floor_ceiling_set_margin_range=${fmt(s.floorCeilingRange,0)}`;
  case"012":return `matches_last_7_days=${s.matches7}; matches_last_14_days=${s.matches14}; matches_last_28_days=${s.matches28}; sets_last_14_days=${s.sets14}; three_setters_last_14_days=${s.threeSetters14}; qualifying_matches_last_14_days=${s.qualifying14}; days_since_last_match=${fmt(s.daysSinceLastMatch,0)}; recent_inter_match_gap_days=${fmt(s.recentInterMatchGapDays,0)}; tournament_switches_last10=${s.tournamentSwitchesLast10}`;
  case"013":return `longest_observed_layoff_days=${fmt(s.longestLayoffDays,0)}; observed_layoffs_30d_plus=${s.layoffs30}; observed_layoffs_60d_plus=${s.layoffs60}; observed_layoffs_90d_plus=${s.layoffs90}; return_after_layoff_win_pct=${fmt(s.returnAfterLayoffWinPct)}`;
  case"020":return `same_level_matches=${s.sameLevelMatches}; same_level_win_pct=${fmt(s.sameLevelWinPct)}`;
  case"028":return `matches_last_14_days=${s.matches14}; matches_last_28_days=${s.matches28}; days_since_last_match=${fmt(s.daysSinceLastMatch,0)}; recent_inter_match_gap_days=${fmt(s.recentInterMatchGapDays,0)}; tournament_switches_last10=${s.tournamentSwitchesLast10}`;
  case"030":return s.sameTournamentMatches?`same_tournament_matches=${s.sameTournamentMatches}; same_tournament_win_pct=${fmt(s.sameTournamentWinPct)}`:null;
  case"068":return `current_streak_signed=${s.currentStreakSigned}; longest_win_streak_observed=${s.longestWinStreak}`;
  case"080":return `official_opponent_rank_avg_last10=${fmt(s.avgOpponentRankLast10)}; best_ranked_recent_win=${fmt(s.bestRankedRecentWin,0)}; win_pct_vs_top20=${fmt(s.top20WinPct)}; win_pct_vs_top50=${fmt(s.top50WinPct)}; win_pct_vs_top100=${fmt(s.top100WinPct)}`;
  default:return null;
}}

function commonOpponentPair(a:History|null,b:History|null,asOfDate:string){
  if(!a||!b)return null;
  const cutoff=new Date(`${asOfDate}T00:00:00Z`);cutoff.setUTCDate(cutoff.getUTCDate()-370);const min=cutoff.toISOString().slice(0,10);
  const usable=(h:History)=>h.matches.filter(r=>String(r.StartDate).slice(0,10)>=min&&r.opponent?.fullName&&allowedMainLevel(r.tournament?.tournamentGroup?.level??r.TournamentLevel));
  const group=(h:History)=>{const m=new Map<string,{name:string;matches:number;wins:number}>();for(const r of usable(h)){const k=norm(r.opponent?.fullName),old=m.get(k)??{name:String(r.opponent?.fullName),matches:0,wins:0};old.matches++;if(playerWon(r,h.playerId))old.wins++;m.set(k,old);}return m};
  const am=group(a),bm=group(b),keys=[...am.keys()].filter(k=>bm.has(k));if(!keys.length)return null;
  const av=keys.reduce((n,k)=>n+am.get(k)!.matches,0),aw=keys.reduce((n,k)=>n+am.get(k)!.wins,0),bv=keys.reduce((n,k)=>n+bm.get(k)!.matches,0),bw=keys.reduce((n,k)=>n+bm.get(k)!.wins,0);
  return {p1:`direct_common_opponents=${keys.length}; common_opponent_matches=${av}; common_opponent_wins=${aw}; common_opponent_losses=${av-aw}; common_opponent_win_pct=${fmt(pct(aw,av))}; opponents=${keys.slice(0,8).map(k=>am.get(k)!.name).join(",")}`,p2:`direct_common_opponents=${keys.length}; common_opponent_matches=${bv}; common_opponent_wins=${bw}; common_opponent_losses=${bv-bw}; common_opponent_win_pct=${fmt(pct(bw,bv))}; opponents=${keys.slice(0,8).map(k=>bm.get(k)!.name).join(",")}`,sample:keys.length};
}
function refs(urls:string[]):SourceRef[]{return urls.map(url=>({source_name:"WTA Official Match History",url,retrieved_at:new Date().toISOString()}))}

export async function officialWtaMetricRows(args:{p1:string;p2:string;context:string;metrics:Array<{code:string;name:string;body:string|null}>}):Promise<MetricFinding[]|null>{
  if(!explicitWtaMain(args.context))return null;
  const asOfDate=contextDate(args.context);
  const [a,b]=await Promise.all([loadHistory(args.p1,asOfDate),loadHistory(args.p2,asOfDate)]);
  const [sa,sb]=[a?summarize(a,asOfDate,args.context):null,b?summarize(b,asOfDate,args.context):null];
  if(!sa&&!sb)return null;
  const common=commonOpponentPair(a,b,asOfDate);return args.metrics.map(metric=>{const code=codeOf(metric.code);if(!SUPPORTED.has(code))return buildTrustedInternalFinding({metric_code:metric.code,players:{p1:args.p1,p2:args.p2},p1:null,p2:null,evidence_family:null,reliability:90,unavailable_reason:"Official WTA match history is not an allowed source for this metric family",persistedSources:[]});const av=code==="007"?common?.p1??null:sa?metricValue(code,sa):null,bv=code==="007"?common?.p2??null:sb?metricValue(code,sb):null;const sources=[...(sa?refs(sa.sourceUrls):[]),...(sb?refs(sb.sourceUrls):[])].filter((s,i,x)=>x.findIndex(v=>v.url===s.url)===i);const sample=code==="007"?common?.sample??null:null;return buildTrustedInternalFinding({metric_code:metric.code,players:{p1:args.p1,p2:args.p2},p1:av?{player:args.p1,value:av,treatment:"PARTIAL",sample:sample??sa?.matches??null,sources:sa?refs(sa.sourceUrls):[]}:null,p2:bv?{player:args.p2,value:bv,treatment:"PARTIAL",sample:sample??sb?.matches??null,sources:sb?refs(sb.sourceUrls):[]}:null,evidence_family:code==="007"?"WTA_OFFICIAL_COMMON_OPPONENT_NETWORK":"WTA_OFFICIAL_MATCH_HISTORY",reliability:90,unavailable_reason:av||bv?"Official WTA results reconstruct only explicitly supported match/set/ranking/workload components; game/point-only components remain unavailable.":"No qualifying WTA Main match-history component was available for this metric",persistedSources:sources});});
}
