export function normalizeBatchMatchIds(matchIds:unknown,max=100):string[]{
  if(!Array.isArray(matchIds))return[];
  return[...new Set(matchIds.filter((id):id is string=>typeof id==="string"&&id.length>=10))].slice(0,max);
}

export async function mapBounded<T,R>(items:readonly T[],concurrency:number,worker:(item:T,index:number)=>Promise<R>):Promise<R[]>{
  const results=new Array<R>(items.length);
  let next=0;
  const run=async()=>{
    while(next<items.length){
      const index=next++;
      results[index]=await worker(items[index]!,index);
    }
  };
  await Promise.all(Array.from({length:Math.min(items.length,Math.max(1,Math.floor(concurrency)))},run));
  return results;
}
// ----------------------------------------------------------------------------
// BATCH DISPATCH (pure). Extracted verbatim from the audit app's
// audit-pipeline.functions.ts, which also held TanStack server-function
// wrappers. The scheduling itself never touched the transport or the database,
// so it belongs with the rest of the pure batch logic rather than behind a
// server-function boundary it never needed.
// ----------------------------------------------------------------------------
export interface PreparedAuditMatch { matchId: string; [key: string]: unknown; }
export interface AuditBatchInput { matches: PreparedAuditMatch[]; concurrency?: number; budgetMs?: number; }

export async function dispatchAuditBatch(
  data: AuditBatchInput,
  dispatch: (match: PreparedAuditMatch, matchIndex: number) => Promise<unknown> = async (match) => match,
): Promise<Array<{ matchId: string; result?: unknown; error?: unknown }>> {
  const prepared = Array.isArray(data?.matches) ? [...data.matches] : [];
  const concurrency = Math.max(1, Number.isFinite(data?.concurrency) ? Number(data.concurrency) : 1);
  const results: Array<{ matchId: string; result?: unknown; error?: unknown }> = [];
  const queue = prepared.slice();
  const active = new Set<Promise<void>>();
  let nextIndex = 0;

  const scheduleNext = () => {
    if (queue.length === 0 || active.size >= concurrency) return;

    const match = queue.shift()!;
    let task!: Promise<void>;
    task = Promise.resolve()
      .then(() => dispatch(match, nextIndex++))
      .then((result) => {
        results.push({ matchId: String(match.matchId), result });
      })
      .catch((error) => {
        results.push({ matchId: String(match.matchId), error });
      })
      .finally(() => {
        active.delete(task);
        scheduleNext();
      });

    active.add(task);
  };

  while (queue.length || active.size) {
    while (queue.length && active.size < concurrency) {
      scheduleNext();
    }
    if (active.size === 0) break;
    await Promise.race([...active]);
  }

  return results;
}
