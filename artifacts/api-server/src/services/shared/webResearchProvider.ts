/**
 * Shared web-research provider (Task #107 Phase 5).
 *
 * Re-exports the neutral webResearchService implementation (services/shared/webResearchService.ts)
 * so both the Prediction Engine's availability module and the Parlay Builder can consume it
 * without either owning the other's code. webResearchService is a pure external-API wrapper with
 * no Prediction Engine or Parlay Builder dependencies, so it lives directly in services/shared/ —
 * this file is kept as the stable public import path for both engines.
 */
export { researchPlayerMatchup, type PlayerResearch, type MatchupResearch } from "./webResearchService.js";
