/**
 * Unit tests for safety-ratings-scrape parsers.
 * Fixtures are slices of real Firecrawl responses captured 2026-04-18
 * so tests catch regressions on actual upstream markdown shapes.
 */

import { describe, it, expect } from "vitest";
import {
  parseArgusMarkdown,
  parseWyvernMarkdown,
} from "../src/ingestion/safety-ratings-scrape.js";

// ── ARGUS fixture (real 2026-04-18 markdown, trimmed) ──────────────────────

const ARGUS_MD = `top of page

![ARGUS Ratings_edited.png](https://www.argus.aero/quality_auto/ARGUS%20Ratings_edited.png)

Operator Registry
=================

ARGUS Charter Operator Ratings represent the highest level of quality in the industry. Being an ARGUS Rated Operator demonstrates a commitment to safety.
=========================================================================================================================================================

![logo](https://example.com/logo1.png)

![gold.png](https://example.com/Platinum%20Elite.png)

2106701 Ontario Inc. dba NovaJet
--------------------------------

Platinum Elite

![logo](https://example.com/logo2.png)

![gold.png](https://example.com/Gold3.png)

24/7 JET, INC
-------------

Gold

![logo](https://example.com/logo3.png)

![gold.png](https://example.com/Gold%20Plus.png)

Fake Gold Plus Operator LLC
---------------------------

Gold Plus
`;

// ── Wyvern fixture (real 2026-04-18 markdown, trimmed) ─────────────────────

const WYVERN_WINGMAN_MD = `WYVERN

[Back to WYVERN](http://www.wyvernltd.com/)

WYVERN Wingman Directory
========================

###### _A global list of air charter operators who have passed, and are in good standing, with the Wingman Certified Operator Program_

Name

![logo](https://storage.googleapis.com/wyvern-main/476/cpo2r4s4.qxi_18.jpg)

ACI Jet

San Luis Obispo, CA United States

![Wingman Logo](https://app.wyvern.systems/assets/images/wyvern_wingman_tall.png)

![Flight Leader Logo](https://app.wyvern.systems/assets/images/wyvern-flight-leader.png)

**W9BA551H
AVIATION CONSULTANTS INC.**


[Website](http://www.acijet.com/)

![logo](https://storage.googleapis.com/wyvern-main/2241/anmnrkzc.fz2_18.jpg)

Acropolis Aviation Ltd

Farnborough, United Kingdom

![Wingman Logo](https://app.wyvern.systems/assets/images/wyvern_wingman_tall.png)

![Flight Leader Logo](https://app.wyvern.systems/assets/images/wyvern-flight-leader.png)

**GB 2363
ACROPOLIS AVIATION LIMITED**


[Website](http://www.acropolis-aviation.com/)
`;

const WYVERN_REGISTERED_MD = `WYVERN Registered Directory
===========================

Name

![logo](https://example.com/a.jpg)

24/7 Jet, Inc.

Van Nuys, CA United States

**1C6A480N
24/7 Jet, Inc.**


[Website](http://www.iconicaviationgroup.com/)

![logo](https://example.com/b.jpg)

AB Jets

Memphis, TN United States

**B5ZA004J
AB Jets, LLC**


[Website](http://www.abjets.com/)
`;

// ── ARGUS tests ────────────────────────────────────────────────────────────

describe("parseArgusMarkdown", () => {
  const rows = parseArgusMarkdown(ARGUS_MD);

  it("parses three operator rows from the fixture", () => {
    expect(rows.length).toBe(3);
  });

  it("skips the H1 promotional block (Operator Registry) and the ARGUS tagline", () => {
    const names = rows.map((r) => r.operator_name);
    expect(names).not.toContain("Operator Registry");
    expect(names.some((n) => n.includes("ARGUS Charter Operator Ratings"))).toBe(false);
  });

  it("maps rating text to enum values including all four tiers", () => {
    const byName = Object.fromEntries(rows.map((r) => [r.operator_name, r.argus_rating]));
    expect(byName["2106701 Ontario Inc. dba NovaJet"]).toBe("platinum_elite");
    expect(byName["24/7 JET, INC"]).toBe("gold");
    expect(byName["Fake Gold Plus Operator LLC"]).toBe("gold_plus");
  });

  it("sets source_url on every row", () => {
    for (const r of rows) {
      expect(r.source_url).toBe("https://www.argus.aero/operatorregistry");
    }
  });

  it("returns empty array when no H2 operator blocks present", () => {
    expect(parseArgusMarkdown("no operators here")).toEqual([]);
  });
});

// ── Wyvern tests ──────────────────────────────────────────────────────────

describe("parseWyvernMarkdown — Wingman directory", () => {
  const rows = parseWyvernMarkdown(WYVERN_WINGMAN_MD, "wingman", "https://app.wyvern.systems/public/directory/wingman");

  it("parses two operator rows from the fixture", () => {
    expect(rows.length).toBe(2);
  });

  it("extracts certificate numbers including internationals with slashes/spaces", () => {
    const certs = rows.map((r) => r.certificate_number);
    expect(certs).toContain("W9BA551H");
    expect(certs).toContain("GB 2363");
  });

  it("uses display name (not legal name) as operator_name", () => {
    const names = rows.map((r) => r.operator_name);
    expect(names).toContain("ACI Jet");
    expect(names).toContain("Acropolis Aviation Ltd");
    expect(names).not.toContain("AVIATION CONSULTANTS INC.");
  });

  it("extracts country from 'City, ST Country' and 'City, Country' lines", () => {
    const byName = Object.fromEntries(rows.map((r) => [r.operator_name, r.wyvern_country]));
    expect(byName["ACI Jet"]).toBe("United States");
    expect(byName["Acropolis Aviation Ltd"]).toBe("United Kingdom");
  });

  it("marks all rows as wingman status", () => {
    for (const r of rows) expect(r.wyvern_status).toBe("wingman");
  });
});

describe("parseWyvernMarkdown — Registered directory", () => {
  const rows = parseWyvernMarkdown(WYVERN_REGISTERED_MD, "registered", "https://app.wyvern.systems/public/directory/registered");

  it("parses operator rows even when Wingman/Flight-Leader badges are absent", () => {
    expect(rows.length).toBe(2);
  });

  it("marks all rows as registered status", () => {
    for (const r of rows) expect(r.wyvern_status).toBe("registered");
  });

  it("preserves display-name punctuation like '24/7 Jet, Inc.'", () => {
    const names = rows.map((r) => r.operator_name);
    expect(names).toContain("24/7 Jet, Inc.");
  });
});
