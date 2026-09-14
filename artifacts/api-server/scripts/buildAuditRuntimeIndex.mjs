import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';

const root=process.cwd();
const outputArg=process.argv[2];
// Written into data/generated/ (a real Node filesystem read, for local dev and build
// scripts) rather than public/ -- the raw file is 61MB, well over Cloudflare Workers'
// hard 25 MiB per-asset limit, so shipping it as a static asset fails deployment outright
// ("Asset too large"). A gzip-compressed copy (~5.2MB, safely under the cap) is written
// to public/generated/tennis-runtime-index.json.gz below instead; that is what the
// deployed Worker actually fetches over the ASSETS binding and decompresses at request
// time -- see runtime-tennis-index-data.server.ts for the loader that depends on both
// locations.
const outputPath=outputArg?resolve(root,outputArg):join(root,'data/generated/tennis-runtime-index.json');
const gzOutputPath=join(root,'public/generated/tennis-runtime-index.json.gz');
const sources=[['ATP','data/public/predixsport/atp/atp_elo_matches.csv'],['WTA','data/public/predixsport/wta/wta_elo_ratings.csv']];
function parseCsv(text){const rows=[];let r=[],c='',q=false;for(let i=0;i<text.length;i++){const x=text[i];if(x==='"'){if(q&&text[i+1]==='"'){c+='"';i++;}else q=!q;}else if(x===','&&!q){r.push(c);c='';}else if((x==='\n'||x==='\r')&&!q){if(x==='\r'&&text[i+1]==='\n')i++;r.push(c);c='';if(r.some(Boolean))rows.push(r);r=[];}else c+=x;}if(c||r.length){r.push(c);rows.push(r);}if(!rows.length)return[];const h=rows[0].map(x=>x.trim());return rows.slice(1).map(a=>Object.fromEntries(h.map((k,i)=>[k,(a[i]??'').trim()])));}
function norm(v){return String(v??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function num(v){const n=Number(v);return Number.isFinite(n)&&String(v??'').trim()!==''?n:null;}
function normDate(v){const s=String(v??'').trim();if(/^\d{8}$/.test(s))return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;return s.slice(0,10);}
function blank(){return{n:0,w:0,l:0,sets:0,setsWon:0,straightWins:0,deciding:0,decidingWins:0,elo:null,peak:null,lastDate:null,recent:[]};}
function touch(map,name){const key=norm(name);if(!key)return null;if(!map[key])map[key]={name,overall:blank(),surface:{}};return map[key];}
function addBucket(b,row){b.n++;const won=String(row.won??'')==='1';if(row.won!==undefined&&row.won!==''){won?b.w++:b.l++;}const sf=num(row.sets_for),sa=num(row.sets_against);if(sf!==null&&sa!==null){b.sets+=sf+sa;b.setsWon+=sf;if(won&&sa===0)b.straightWins++;if(sf+sa===3||sf+sa===5){b.deciding++;if(won)b.decidingWins++;}}const elo=num(row.elo_post)??num(row.elo_pre)??num(row.elo);if(elo!==null){b.elo=elo;b.peak=b.peak===null?elo:Math.max(b.peak,elo);}const d=normDate(row.date||'');if(d&&(!b.lastDate||d>b.lastDate))b.lastDate=d;b.recent.push([d,won?1:0,String(row.surface??'').toLowerCase(),elo,row.opponent??row.opponent_name??'',row.tournament??'']);if(b.recent.length>20)b.recent.shift();}
function first(row,keys){for(const k of keys){const v=row[k];if(v!==undefined&&v!==null&&String(v).trim()!=='')return v;}return null;}
function parseSetScores(value){const text=String(value??'').replace(/\([^)]*\)/g,'');const out=[];for(const m of text.matchAll(/(?:^|\s|,|;)(\d{1,2})\s*[-:]\s*(\d{1,2})(?=$|\s|,|;)/g)){const a=Number(m[1]),b=Number(m[2]);if(a<=30&&b<=30)out.push([a,b]);}return out;}
function compactDetails(row,orientation='PLAYER'){
  const won=String(row.won??'')==='1'?true:String(row.won??'')==='0'?false:null;
  const rawScore=first(row,['score','scoreline','match_score','result_score','set_score','sets_score']);
  let setScores=parseSetScores(rawScore);
  if(orientation==='PLAYER'&&won===false)setScores=setScores.map(([a,b])=>[b,a]);
  let sf=num(first(row,['sets_for','player_sets','sets_won'])),sa=num(first(row,['sets_against','opponent_sets','sets_lost']));
  if(orientation==='WINNER'){sf=num(first(row,['winner_sets','w_sets','sets_winner','sets_for']))??sf;sa=num(first(row,['loser_sets','l_sets','sets_loser','sets_against']))??sa;}
  if(orientation==='HOME'){sf=num(first(row,['home_sets','home_score_sets','sets_home','home_set_score']));sa=num(first(row,['away_sets','away_score_sets','sets_away','away_set_score']));}
  if((sf===null||sa===null)&&setScores.length){sf=setScores.filter(([a,b])=>a>b).length;sa=setScores.filter(([a,b])=>a<b).length;}
  let status=first(row,['status','match_status','result_status','retirement_status','walkover_status','comment']);
  if(!status&&rawScore&&/(?:\bRET\b|\bW\/?O\b|walkover|retired)/i.test(String(rawScore)))status=String(rawScore).match(/(?:RET|W\/?O|walkover|retired)/i)?.[0]??null;
  let bestOf=num(first(row,['best_of','bestof','format_best_of']));
  if(bestOf===null&&orientation==='PLAYER')bestOf=String(row.tournament_type??'').toLowerCase().includes('grand_slam')?5:3;
  if(bestOf===null&&(orientation==='WINNER'||orientation==='HOME'))bestOf=3;
  const selfRank=num(first(row,orientation==='WINNER'?['winner_rank','player_rank','rank']:orientation==='HOME'?['home_rank','player_rank','rank']:['player_rank','rank']));
  const opponentRank=num(first(row,orientation==='WINNER'?['loser_rank','opponent_rank','opp_rank']:orientation==='HOME'?['away_rank','opponent_rank','opp_rank']:['opponent_rank','opp_rank','loser_rank']));
  const selfElo=num(first(row,['player_elo','elo_pre','elo']));
  const opponentElo=num(first(row,['_task18a_opponent_elo','opponent_elo','opp_elo','loser_elo']));
  // Metric 062 (Motivation/Stakes) support: winner_seed/loser_seed, draw_size, and
  // winner_rank_points/loser_rank_points exist as real columns in the TennisMyLife ATP
  // Challenger normalized CSVs (data/public/tennismylife-challenger/normalized/*.csv,
  // orientation='WINNER' below) but were never captured into the runtime index before this
  // task -- a real, verified column, not a schema gap (see docs/audit-task-038-040-062.md).
  // Only orientation==='WINNER' rows have these columns; PLAYER/HOME rows leave them null
  // rather than guessing at a column name that source doesn't actually have.
  const selfSeed=orientation==='WINNER'?num(first(row,['winner_seed'])):null;
  const opponentSeed=orientation==='WINNER'?num(first(row,['loser_seed'])):null;
  const drawSize=orientation==='WINNER'?num(first(row,['draw_size'])):null;
  const selfRankPoints=orientation==='WINNER'?num(first(row,['winner_rank_points'])):null;
  const opponentRankPoints=orientation==='WINNER'?num(first(row,['loser_rank_points'])):null;
  return {sets_for:sf,sets_against:sa,set_scores:setScores,best_of:bestOf,self_rank:selfRank,opponent_rank:opponentRank,self_elo:selfElo,opponent_elo:opponentElo,status:status?String(status):null,raw_score:rawScore?String(rawScore):null,self_seed:selfSeed,opponent_seed:opponentSeed,draw_size:drawSize,self_rank_points:selfRankPoints,opponent_rank_points:opponentRankPoints};
}
function reverseDetails(d){return{...d,sets_for:d.sets_against,sets_against:d.sets_for,set_scores:Array.isArray(d.set_scores)?d.set_scores.map(([a,b])=>[b,a]):[],self_rank:d.opponent_rank,opponent_rank:d.self_rank,self_elo:d.opponent_elo,opponent_elo:d.self_elo,self_seed:d.opponent_seed??null,opponent_seed:d.self_seed??null,self_rank_points:d.opponent_rank_points??null,opponent_rank_points:d.self_rank_points??null};}
function exactMatchKey(row,player){const d=normDate(row.date||row.tourney_date||'');const t=norm(row.tournament??row.tourney_name??'');const p=norm(player);return d&&t&&p?`${d}|${t}|${p}`:null;}
function attachExactOpponentElo(rows){
  const byPlayerMatch=new Map();
  for(const row of rows){const key=exactMatchKey(row,row.player);const elo=num(row.elo_pre);if(!key||elo===null)continue;const vals=byPlayerMatch.get(key)??new Set();vals.add(elo);byPlayerMatch.set(key,vals);}
  let joined=0,ambiguous=0;
  for(const row of rows){const opponent=row.opponent??row.opponent_name??'';const key=exactMatchKey(row,opponent);if(!key)continue;const vals=byPlayerMatch.get(key);if(!vals||vals.size===0)continue;if(vals.size!==1){ambiguous++;continue;}row._task18a_opponent_elo=String([...vals][0]);joined++;}
  return {joined,ambiguous};
}

// Row layout: [date,tournament,surface,opponent,won,round,source,details].
const matchHistory={ATP_MAIN:{},WTA_MAIN:{},ATP_CHALLENGER:{},WTA_CHALLENGER:{}};
function addHistory(lane,player,opponent,date,tournament,surface,won,round,source,details=null){const key=norm(player),d=normDate(date);if(!key||!/^\d{4}-\d{2}-\d{2}$/.test(d))return;const bucket=matchHistory[lane][key]??=[];bucket.push([d,String(tournament??''),String(surface??''),String(opponent??''),won===true?1:won===false?0:null,String(round??''),String(source??''),details]);}
function addSymmetric(lane,a,b,date,tournament,surface,aWon,round,source,aDetails=null){addHistory(lane,a,b,date,tournament,surface,aWon,round,source,aDetails);addHistory(lane,b,a,date,tournament,surface,aWon===null?null:!aWon,round,source,aDetails?reverseDetails(aDetails):null);}
function winnerCode(code){const raw=String(code??'').trim();const numeric=Number(raw);if(Number.isFinite(numeric)){if(numeric===1)return true;if(numeric===2)return false;}const v=norm(raw);if(['1','h','home','home player','home_player'].includes(v))return true;if(['2','a','away','away player','away_player'].includes(v))return false;return null;}

const out={generatedAt:new Date().toISOString(),ATP:{},WTA:{},matchHistory};
for(const [tour,rel] of sources){const path=join(root,rel);if(!existsSync(path)){console.warn('runtime index source missing',rel);continue;}const rows=parseCsv(readFileSync(path,'utf8'));if(tour==='ATP'){const q=attachExactOpponentElo(rows);console.log(`ATP exact-match opponent Elo joins: ${q.joined}; ambiguous rejected: ${q.ambiguous}`);}for(const row of rows){const p=touch(out[tour],row.player);if(!p)continue;addBucket(p.overall,row);const s=String(row.surface??'').toLowerCase();if(s){p.surface[s]??=blank();addBucket(p.surface[s],row);}const opponent=row.opponent??row.opponent_name??'';if(opponent&&row.date){addHistory(tour==='ATP'?'ATP_MAIN':'WTA_MAIN',row.player,opponent,row.date,row.tournament??row.tourney_name,row.surface,String(row.won??'')==='1'?true:String(row.won??'')==='0'?false:null,row.round,`runtime:${tour.toLowerCase()}_main`,compactDetails(row,'PLAYER'));}}console.log(`${tour}: ${Object.keys(out[tour]).length} players indexed from ${rows.length} rows`);}

const challengerDir=join(root,'data/public/tennismylife-challenger/normalized');
if(existsSync(challengerDir)){const currentYear=new Date().getUTCFullYear();let accepted=0;for(const file of readdirSync(challengerDir).filter(x=>/^\d{4}_challenger_normalized\.csv$/.test(x)).sort()){const year=Number(file.slice(0,4));if(year<currentYear-5)continue;for(const row of parseCsv(readFileSync(join(challengerDir,file),'utf8'))){if(row._dedup_status&&row._dedup_status!=='NEW_MATCH')continue;const winner=row.winner_name??'',loser=row.loser_name??'',date=row.tourney_date??'';if(!winner||!loser||!date)continue;addSymmetric('ATP_CHALLENGER',winner,loser,date,row.tourney_name,row.surface,true,row.round,'TennisMyLife ATP Challenger',compactDetails(row,'WINNER'));accepted++;}}console.log(`ATP_CHALLENGER: ${accepted} repository matches indexed`);}

const wta125Path=join(root,'data/public/production-history/wta_challenger/matches_2021_2026.csv');
if(existsSync(wta125Path)){const rows=parseCsv(readFileSync(wta125Path,'utf8'));let accepted=0;for(const row of rows){if(row.tour_family!=='WTA_CHALLENGER'||row.competition_level!=='WTA_125'||row.production_scope!=='WTA_125_ONLY'||row.contamination_firewall!=='PASS'||row.classification!=='WTA_125_CHALLENGER'||row.level!=='WTA Chall')throw new Error(`WTA125_CONTAMINATION_FIREWALL_BLOCKED:${row.match_key??accepted}`);const home=row.home_player??'',away=row.away_player??'',date=row.date??'';if(!home||!away||!date)throw new Error(`WTA125_INVALID_MATCH:${row.match_key??accepted}`);const homeWon=winnerCode(row.winner_code);addSymmetric('WTA_CHALLENGER',home,away,date,row.tournament,row.surface,homeWon,row.round,'Validated WTA 125 production history',compactDetails(row,'HOME'));accepted++;}if(accepted!==7615)throw new Error(`WTA125_ROW_COUNT_MISMATCH:${accepted}`);console.log(`WTA_CHALLENGER: ${accepted} validated WTA 125 matches indexed`);}

// WTA Tour main-draw matches, TennisData.app season exports (raw, user-supplied; the
// WTA Challenger portion of these exact same season files was already ingested above via
// production-history/wta_challenger -- confirmed by an exact per-year row-count match
// (540/881/1096/1374/2092/1632), so only the WTA Tour rows are new here, never
// re-ingesting the Challenger rows a second time). Row shape has explicit per-set score
// columns (home_set_1_score..home_set_5_score) rather than a combined score string, and a
// separate coarse `status` (FINISHED/SCHEDULED) plus granular `status_extra`
// (FINISHED/RETIRED/WALKOVER/CANCELED/SCHEDULED) -- only `status==='FINISHED'` rows (a
// completed result exists) with a resolvable winner_code are indexed; `status_extra` is
// preserved into the row's `status` detail field so retirement/walkover-aware codes (013)
// can still see it. WTA tour-level matches are always best-of-3.
const wtaMainDir=join(root,'data/public/tennisdata-wta-main');
if(existsSync(wtaMainDir)){
  let accepted=0;
  for(const file of readdirSync(wtaMainDir).filter(x=>/^\d{4}wtaseason\.csv$/.test(x)).sort()){
    for(const row of parseCsv(readFileSync(join(wtaMainDir,file),'utf8'))){
      if(row.tour_type_human!=='WTA Tour')continue;
      if(row.status!=='FINISHED')continue;
      const homeWon=winnerCode(row.winner_code);
      if(homeWon===null)continue;
      const home=row.home_name??'',away=row.away_name??'';
      const ts=Number(row.date_timestamp);
      const date=Number.isFinite(ts)?new Date(ts*1000).toISOString().slice(0,10):'';
      if(!home||!away||!date)continue;
      const setScores=[];
      for(let s=1;s<=5;s++){const hs=num(row[`home_set_${s}_score`]),as=num(row[`away_set_${s}_score`]);if(hs===null||as===null)break;setScores.push([hs,as]);}
      // status is always populated with the real granular status_extra value (FINISHED
      // included, not just RETIRED/WALKOVER) -- code 013's retirement-rate computation
      // (deriveHistoricalResultMetric's statusRows()) divides retirement/walkover count by
      // the count of rows with a *non-null* status. Nulling status out for ordinary
      // finishes would make every status-bearing row a retirement by construction, turning
      // a real percentage into a tautological 100% -- exactly the kind of misleading
      // denominator this project explicitly must not produce, even unintentionally.
      const details={sets_for:setScores.filter(([a,b])=>a>b).length,sets_against:setScores.filter(([a,b])=>a<b).length,set_scores:setScores,best_of:3,self_rank:num(row.home_rank),opponent_rank:num(row.away_rank),self_elo:null,opponent_elo:null,status:row.status_extra??null,raw_score:null};
      addSymmetric('WTA_MAIN',home,away,date,row.tournament,row.surface,homeWon,row.round,'TennisData.app WTA Tour production history',details);
      accepted++;
    }
  }
  if(accepted!==23027)throw new Error(`WTA_MAIN_ROW_COUNT_MISMATCH:${accepted}`);
  console.log(`WTA_MAIN: ${accepted} TennisData.app WTA Tour matches indexed`);
}

for(const lane of Object.values(matchHistory))for(const rows of Object.values(lane))rows.sort((a,b)=>String(b[0]).localeCompare(String(a[0])));
mkdirSync(dirname(outputPath),{recursive:true});const json=JSON.stringify(out);writeFileSync(outputPath,json);console.log(`Runtime tennis index written to ${outputPath}`);
mkdirSync(dirname(gzOutputPath),{recursive:true});writeFileSync(gzOutputPath,gzipSync(json,{level:9}));console.log(`Gzip-compressed runtime tennis index (Cloudflare Workers asset) written to ${gzOutputPath}`);