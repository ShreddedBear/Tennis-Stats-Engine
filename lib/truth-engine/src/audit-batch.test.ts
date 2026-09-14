import { describe, expect, it } from "vitest";
import { mapBounded, normalizeBatchMatchIds } from "./audit-batch";

describe("audit batch coordinator",()=>{
  it("deduplicates duplicate clicks before any run is scheduled",()=>{
    expect(normalizeBatchMatchIds(["match-00001","match-00001","match-00002"])).toEqual(["match-00001","match-00002"]);
  });

  it.each([4,100])("processes a %i-match batch once with bounded concurrency",async total=>{
    let active=0,maxActive=0;
    const seen:number[]=[];
    const results=await mapBounded(Array.from({length:total},(_,index)=>index),3,async item=>{
      active++;maxActive=Math.max(maxActive,active);
      await Promise.resolve();
      seen.push(item);
      active--;
      return item*2;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(new Set(seen).size).toBe(total);
    expect(results).toHaveLength(total);
  });

  it("preserves completed work when a later item returns a persisted blocker",async()=>{
    const results=await mapBounded(["a","b","c"],2,async item=>item==="b"?{status:"BLOCKED",reason:"provider timeout"}:{status:"COMPLETE"});
    expect(results).toEqual([{status:"COMPLETE"},{status:"BLOCKED",reason:"provider timeout"},{status:"COMPLETE"}]);
  });
});