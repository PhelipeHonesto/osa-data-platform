/**
 * Public entry point for the data-quality module.
 * Phase 1 ships five assertions; add more by dropping into assertions/
 * and including here.
 */

import { faaRegistryCount } from "./assertions/faa-registry-count.js";
import { adsbLegsPresence } from "./assertions/adsb-legs-presence.js";
import { operatorIdentityOrphans } from "./assertions/operator-identity-orphans.js";
import { routeVectorEmbeddings } from "./assertions/route-vector-embeddings.js";
import { adsbLegDuplicates } from "./assertions/adsb-leg-duplicates.js";
import type { Assertion } from "./assertions/types.js";

export { runAssertions } from "./runner.js";
export type { Assertion, AssertionResult, AssertionStatus } from "./assertions/types.js";
export type { DqRunResult } from "./runner.js";

export const ALL_ASSERTIONS: ReadonlyArray<Assertion> = [
  faaRegistryCount,
  adsbLegsPresence,
  operatorIdentityOrphans,
  routeVectorEmbeddings,
  adsbLegDuplicates,
];
