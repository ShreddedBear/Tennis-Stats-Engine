// Canonical cross-source match deduplication guard.
// One real-world match may appear in several datasets, but it must contribute
// exactly once to player records, H2H, form, surface, common-opponent, fatigue,
// Elo/calibration, or any downstream aggregate.

export interface HistoricalMatchIdentity {
  source: string;
  sourceMatchId?: string | null;
  tour?: string | null;
  date?: string | null;
  tournament?: string | null;
  round?: string | null;
  surface?: string | null;
  player1: string;
  player2: string;
  score?: string | null;
}

const clean=(v:string|null|undefined)=>(v??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g," ");
const date=(v:string|null|undefined)=>{const x=clean(v).replace(/ /g,"-");const m=x.match(/(20\d{2})[-]?(\d{2})[-]?(\d{2})/);return m?`${m[1]}-${m[2]}-${m[3]}`:x;};
const score=(v:string|null|undefined)=>clean(v).replace(/retired|ret|walkover|w o|wo|defaulted|def/g,"").trim();

export function canonicalMatchKey(m:HistoricalMatchIdentity):string{
  const players=[clean(m.player1),clean(m.player2)].sort();
  return [clean(m.tour),date(m.date),clean(m.tournament),clean(m.round),players[0],players[1]].join("|");
}

export function strictMatchFingerprint(m:HistoricalMatchIdentity):string{
  return `${canonicalMatchKey(m)}|${clean(m.surface)}|${score(m.score)}`;
}

export interface DedupedMatch<T extends HistoricalMatchIdentity>{canonicalKey:string;primary:T;duplicates:T[];sources:string[];}

// Source priority controls which copy supplies overlapping fields. Duplicate
// copies remain available for validation/enrichment, never as extra matches.
const PRIORITY=["official","datahub","tennis-data","current","archive","other"];
function priority(source:string){const s=clean(source);const i=PRIORITY.findIndex(x=>s.includes(x));return i<0?PRIORITY.length:i;}

export function dedupeHistoricalMatches<T extends HistoricalMatchIdentity>(rows:T[]):DedupedMatch<T>[] {
  const groups=new Map<string,T[]>();
  for(const row of rows){const k=canonicalMatchKey(row);const g=groups.get(k)??[];g.push(row);groups.set(k,g);}
  const out:DedupedMatch<T>[]=[];
  for(const [canonicalKey,items] of groups){
    items.sort((a,b)=>priority(a.source)-priority(b.source));
    const primary=items[0]!;
    out.push({canonicalKey,primary,duplicates:items.slice(1),sources:[...new Set(items.map(x=>x.source))]});
  }
  return out;
}

export function uniqueMatchesOnly<T extends HistoricalMatchIdentity>(rows:T[]):T[]{return dedupeHistoricalMatches(rows).map(x=>x.primary);}

// Cross-source fields may enrich the primary copy only when they do not conflict.
// This deliberately never creates another match observation.
export function enrichWithoutDoubleCounting<T extends HistoricalMatchIdentity>(group:DedupedMatch<T>):T{
  const merged:any={...group.primary};
  for(const d of group.duplicates){for(const [k,v] of Object.entries(d)){if((merged[k]===null||merged[k]===undefined||merged[k]==="")&&v!==null&&v!==undefined&&v!=="")merged[k]=v;}}
  merged.source=group.sources.join(" + ");
  return merged as T;
}
