// Heuristic extraction of matchups + fields from Tennis Matrix summaries and
// screenshot/betting-card PDFs. Nothing is silently guessed: every field is
// reviewable before the audit starts.

export type ExtractionStatus = "DIRECT" | "RECONSTRUCTED" | "PARTIAL" | "UNAVAILABLE" | "EXCLUDED";
export interface ParsedField { field_key:string; raw_value:string|null; normalized_value:string|null; extraction_status:ExtractionStatus; confidence:number; page_number:number; }
export interface ParsedMatchup { player1_name:string; player2_name:string; page_number:number; fields:ParsedField[]; confidence:number; }

// Deliberately requires the literal word "vs"/"v."/"versus" — every real
// matchup title observed (betting cards and the app's own reports alike)
// spells it out. A bare em/en-dash used to count too, which was harmless for
// clean text but a serious false-positive risk once OCR gets noisy: dense
// screenshots are full of dashes as dividers/bullets/table borders, and any
// two nearby capitalized phrases separated by a stray one would otherwise
// register as a fake "matchup" (e.g. two unrelated section headings).
const VS=/([A-ZÀ-Ý][\p{L}'’.\- ]{1,55}?)\s+(?:vs\.?|v\.|versus)\s+([A-ZÀ-Ý][\p{L}'’.\- ]{1,55})/iu;
const NOISE=/^(?:tennis|today|tomorrow|live|open|closed|volume|vol|atp|wta|itf|challenger|moneyline|spread|total|draw|market|starts?|ends?)\b/i;
const EVENTISH=/\b(?:ATP|WTA|ITF|Challenger|Cincinnati|Cancun|US Open|Wimbledon|Roland Garros|Australian Open)\b/i;
// Best-effort only: OCR/text-layer output from a dense app screenshot is far less
// reliable than the vision extraction path (pdf-extract.functions.ts) for anything beyond
// clearly-labelled top-level text. Only scalar, prominently-printed values are attempted
// here; the structured per-module "Full Engine Breakdown" content (Surface Elo, Serve &
// Return, Recent Form, Fatigue Index, Rest/Travel/Injury, Head-to-Head, Style Matchup
// detail) is vision-only -- see AiMatrixSummary / flattenMatrixSummary in upload.tsx.
//
// The app's own "Full Engine Breakdown" match-report screenshots repeat these
// exact section headings on every page. OCR noise on a dense page can produce
// a stray "vs"-like fragment between two of them, so they're excluded as
// player-name candidates by exact phrase rather than by generic shape (a
// generic 2-6-word title-case check can't otherwise tell "Model Votes" apart
// from a real two-word name).
const UI_CHROME_PHRASES=new Set(["model votes","monte carlo simulation","full engine breakdown","surface elo","serve return","serve and return","recent form","head to head","head-to-head","market consensus","general model","specialist model","set score distribution","fatigue index","match load recovery","rest travel injury","style matchup","builder check","bet score","win probability","data quality","model agreement","close matchup","independent conclusion","key tech view","score history","spot odds risk"]);
function isUiChromePhrase(s:string){return UI_CHROME_PHRASES.has(s.toLowerCase().replace(/[.,:&-]/g," ").replace(/\s+/g," ").trim());}
const FIELD_PATTERNS:Array<[string,RegExp]>=[
 ["tournament",/(?:tournament|event)\s*[:\-]\s*(.+)/i],["event_level",/(?:event level|level|category)\s*[:\-]\s*(.+)/i],["round",/round\s*[:\-]\s*(.+)/i],["scheduled_date",/(?:date|scheduled)\s*[:\-]\s*(.+)/i],["surface",/surface\s*[:\-]\s*(.+)/i],["indoor_outdoor",/(indoor|outdoor)\s*[:\-]?\s*(.*)/i],["best_of",/best[\s\-]?of\s*[:\-]?\s*(\d)/i],
 ["matrix_predicted_winner",/predicted winner\s*[:\-]\s*(.+)/i],["matrix_wp",/(?:win probability|matrix wp|wp)\s*[:\-]\s*([\d.]+)\s*%?/i],["matrix_wp_range",/\brange\s+(\d{1,3}\s*[-–]\s*\d{1,3})/i],["matrix_confidence_label",/\b(extreme|very high|high confidence|low confidence|no strong signal)\b/i],["matrix_agreement_label",/\b(strongly agree|high disagreement|close to a coin flip|moderate lean)\b/i],["monte_carlo_winner",/monte carlo winner\s*[:\-]\s*(.+)/i],["monte_carlo_prob",/monte carlo (?:win )?(?:probability|prob)\s*[:\-]\s*([\d.]+)/i],["monte_carlo_expected_sets",/expected sets\s*[:\-]\s*([\d.]+)/i],["monte_carlo_simulations",/simulations(?: run)?\s*[:\-]\s*([\d,]+)/i],["data_quality",/(?:data quality|dq)\s*[:\-]\s*(.+)/i],["upset_risk",/upset risk\s*[:\-]\s*(.+)/i],["model_agreement",/(?:model )?agreement\s*[:\-]\s*(.+)/i]
];
function cleanLine(v:string){return v.replace(/[|]/g," ").replace(/\s+/g," ").trim();}
// Card subtitles read "Today @ 8:10am · ATP Challenger Roehampton 2" (OCR often
// truncates/mangles "Today" and the separator, e.g. "day @ 8:18am. ATP
// Challenger..."). Left unstripped, this whole line used to get stored as the
// tournament value, and it also broke the "starts with ATP/WTA/ITF" event_level
// checks below. Matched generically on "leading word + @ + time" rather than
// enumerating day names, since OCR truncation of "Today" is unpredictable —
// no real tournament name is followed directly by an "@ H:MM" time.
const SCHEDULE_PREFIX=/^\S{1,10}\s*@?\s*\d{1,2}:\d{2}\s*(?:am|pm)?[\s.]*[-·:•]?\s*/i;
function cleanTournament(v:string){return cleanLine(v).replace(/^\$?[\d,]+\s*(?:vol(?:ume)?)?\s*/i,"").replace(/^vol(?:ume)?\s*/i,"").replace(SCHEDULE_PREFIX,"").trim();}
// Betting-card rows show a small flag/rank icon immediately to the left of each
// player's name; OCR frequently reads that icon as one or two short stray
// letter-tokens glued onto the real name (e.g. "s K Oliver Tarvet", "NE oliver
// Tarvet"). A genuine leading initial always carries a period ("J. Smith"), so a
// bare 1-2 letter token with no period in front of a real word is safe to drop.
// The stray token itself may include a misread digit (an icon read as "4"),
// but the lookahead still requires the actual name that follows to be pure
// letters — this only ever strips the noise, never a real odds/price line.
const ICON_NOISE_PREFIX=/^(?:[A-Za-zÀ-ÿ0-9]{1,2}\s+){1,2}(?=[\p{L}]{3,}\s+[\p{L}])/u;
// Title-case each letter run independently (not split on apostrophe/hyphen as
// a whole token) so "O'Connor" and "Auger-Aliassime" keep the letters after the
// punctuation capitalized instead of being lowercased as one long "word".
const titleCase=(v:string)=>v.replace(/\p{L}+/gu,w=>w[0].toUpperCase()+w.slice(1).toLowerCase());
function cleanPlayer(v:string){return titleCase(cleanLine(v).replace(/^[^A-Za-zÀ-ÿ]{0,4}/,"").replace(ICON_NOISE_PREFIX,"").replace(/^(?:BEE|SE|s|a)\s+(?=[A-ZÀ-Ý])/i,"").replace(/\s+[+\-−]\s*\d{2,4}\s*$/," ").replace(/\s+/g," ").trim());}
function looksLikeFullPlayerName(line:string){const s=cleanPlayer(line);if(!s||s.length<4||s.length>55||NOISE.test(s)||EVENTISH.test(s)||isUiChromePhrase(s))return false;if(/\d|\$|@|%|\bvol\b/i.test(s))return false;const words=s.split(/\s+/).filter(Boolean);return words.length>=2&&words.length<=6&&words.every(w=>/^[\p{L}][\p{L}'’.\-]*$/u.test(w));}
function add(out:ParsedField[],key:string,value:string,page:number,confidence=.9){const v=cleanLine(value);if(v&&!out.some(f=>f.field_key===key))out.push({field_key:key,raw_value:v,normalized_value:v,extraction_status:"DIRECT",confidence,page_number:page});}
function fieldsFromBlock(block:string,page:number){const out:ParsedField[]=[];for(const[key,re]of FIELD_PATTERNS){const m=block.match(re);if(!m)continue;const raw=(m[1]??"").trim().replace(/\s{2,}.*$/,"");if(raw)add(out,key,key==="tournament"?cleanTournament(raw):raw,page);}
 const lines=block.split(/\n/).map(cleanLine).filter(Boolean);
 const eventRaw=lines.find(l=>EVENTISH.test(l)&&!/\bvs\b/i.test(l));if(eventRaw){const event=cleanTournament(eventRaw);if(event)add(out,"tournament",event,page,.85);if(/challenger/i.test(event))add(out,"event_level","Challenger",page,.9);else if(/\bATP\b/i.test(event))add(out,"event_level","ATP",page,.8);else if(/\bWTA\b/i.test(event))add(out,"event_level","WTA",page,.8);else if(/\bITF\b/i.test(event))add(out,"event_level","ITF",page,.8);}
 const when=lines.find(l=>/@?\s*\d{1,2}:\d{2}\s*(?:am|pm)\b/i.test(l));if(when)add(out,"scheduled_date",when,page,.8);
 const vol=lines.join(" ").match(/\$\s*([\d,]+)\s*vol/i);if(vol)add(out,"market_volume",`$${vol[1]}`,page,.95);
 const odds=lines.join(" ").match(/[+\-−]\s*\d{2,4}/g)?.map(x=>x.replace(/\s+/g,""))??[];if(odds[0])add(out,"p1_moneyline",odds[0],page,.9);if(odds[1])add(out,"p2_moneyline",odds[1],page,.9);
 return out;}
function canonicalNamesAroundAnchor(lines:string[],anchor:number,p1Hint:string,p2Hint:string):[string,string]{const window=lines.slice(anchor+1,Math.min(lines.length,anchor+12)).map(cleanLine);const names=window.filter(looksLikeFullPlayerName).map(cleanPlayer);if(names.length>=2)return[names[0],names[1]];const p1=cleanPlayer(p1Hint),p2=cleanPlayer(p2Hint);
 // The anchor line itself matched "X vs Y", but neither side turned out to be
 // a real nearby full name — only accept the hint text directly if it isn't
 // one of the app's own known section headings (a stray dash-like OCR
 // artifact between two headings would otherwise register as a "vs" match).
 if(isUiChromePhrase(p1)||isUiChromePhrase(p2))return["",""];
 return[p1,p2];}
function inferPairWithoutVs(lines:string[]):[string,string]|null{const candidates=lines.map(cleanLine).filter(looksLikeFullPlayerName).map(cleanPlayer);const unique=candidates.filter((n,i,a)=>a.findIndex(x=>normalizeName(x)===normalizeName(n))===i);return unique.length>=2?[unique[0],unique[1]]:null;}
export function parseSummaryText(pages:string[]){const matchups:ParsedMatchup[]=[];pages.forEach((pageText,idx)=>{const page=idx+1;const lines=pageText.split(/\n/).map(cleanLine).filter(Boolean);const anchors:number[]=[];lines.forEach((l,i)=>{if(VS.test(l))anchors.push(i);});if(anchors.length){anchors.forEach((anchorIdx,k)=>{const nextAnchor=anchors[k+1]??lines.length;const block=lines.slice(anchorIdx,nextAnchor).join("\n");const m=lines[anchorIdx].match(VS);if(!m)return;const[p1,p2]=canonicalNamesAroundAnchor(lines,anchorIdx,m[1]??"",m[2]??"");if(!p1||!p2)return;const fields=fieldsFromBlock(block,page);matchups.push({player1_name:p1,player2_name:p2,page_number:page,fields,confidence:Number(Math.min(1,.72+fields.length*.03).toFixed(2))});});return;}const inferred=inferPairWithoutVs(lines);if(!inferred)return;const fields=fieldsFromBlock(lines.join("\n"),page);matchups.push({player1_name:inferred[0],player2_name:inferred[1],page_number:page,fields,confidence:Number(Math.min(.95,.75+fields.length*.03).toFixed(2))});});return matchups;}
export function normalizeName(name:string){return name.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z ]/g,"").replace(/\s+/g," ").trim();}
export function canonicalKey(parts:{tournament?:string|null;round?:string|null;date?:string|null;p1:string;p2:string;}){const players=[normalizeName(parts.p1),normalizeName(parts.p2)].sort().join("|");return[(parts.tournament??"unknown").toLowerCase().trim(),(parts.round??"unknown").toLowerCase().trim(),(parts.date??"unknown").toLowerCase().trim(),players].join("::");}
