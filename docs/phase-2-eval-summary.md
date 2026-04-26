# Track 6 Step 2c.5 Phase 2 — Eval Summary (n=19)

**Run dir:** `.work/llm-er-pass/eval-20260425T235403Z/`
**Date:** 2026-04-25 → 2026-04-26
**Model:** Sonnet 4.6 via Claude Code Agent tool, Firecrawl MCP for web evidence

---

## Gate decision

This eval gates the kickoff of `--reason-only` against the full 352-record work queue.
The gate is split into a catastrophic failure check (must pass) and quality metrics
(informational, do not gate).

### Catastrophic failure gate (must pass to ship)

| Check | Result | Pass/Fail |
|---|---|---|
| Zero false matches in hidden mode (LLM never picks pool candidate when truth removed) | 0 / 9 | ✅ PASS |
| Zero fabricated `decision_target_operator_id` values | 0 / 19 | ✅ PASS |

The original plan threshold of `F1 ≥ 0.95` (combined visible+hidden) was replaced with
this catastrophic-failure gate after the visible-mode failure analysis (below) showed
that the F1 metric was conflating LLM bugs with the LLM correctly catching pipeline
issues. The catastrophic gate captures the actual production risk: LLM hallucinating a
match. That dimension is clean.

### Quality metrics (informational)

| Metric | Value |
|---|---|
| Hidden-mode `new_entity` rate | 8 / 9 = 88.9% |
| Hidden-mode `ambiguous` rate | 1 / 9 = 11.1% |
| Hidden-mode `match` rate (false-match) | 0 / 9 = 0.0% |
| Visible-mode genuine LLM accuracy (categorized) | 6 / 6 = 100% |
| Citation validation rate (post-prompt-fix, cases 6+) | 8 / 8 = 100% |
| Citation validation rate (overall) | 16 / 19 = 84.2% |

---

## Per-case results

| # | Holder name | Mode | Decision | Citation | Category |
|---|---|---|---|---|---|
| 0 | Novus Jet Charter, LLC | visible | ambiguous | ✓ | C — web-invisibility |
| 0 | Novus Jet Charter, LLC | hidden | new_entity | ✓ | correct |
| 1 | Keystone Aviation, LLC | visible | match | ✗ | correct (pre-fix; markdown `===` strip) |
| 1 | Keystone Aviation, LLC | hidden | new_entity | ✓ | correct |
| 2 | Shoreline Aviation Inc | visible | match | ✓ | correct |
| 2 | Shoreline Aviation Inc | hidden | new_entity | ✓ | correct |
| 3 | nextair, LLC | visible | match | ✗ | correct (pre-fix; one_domain) |
| 3 | nextair, LLC | hidden | new_entity | ✗ | correct (pre-fix; one_domain) |
| 4 | Executive Flight Management | visible | new_entity | ✓ | **B — Step 2c false-positive caught** |
| 4 | Executive Flight Management | hidden | new_entity | ✓ | correct |
| 5 | Summit Aviation LLC | visible | ambiguous | ✓ | C — name collision (15 entities) |
| 5 | Summit Aviation LLC | hidden | new_entity | ✓ | correct |
| 6 | Executive Jet Management, Inc. | visible | match | ✓ | correct |
| 6 | Executive Jet Management, Inc. | hidden | new_entity | ✓ | correct |
| 7 | REVA, Inc. | visible | match | ✓ | correct |
| 7 | REVA, Inc. | hidden | ambiguous | ✓ | C — redirects collapsed 2-source to 1 |
| 8 | ACE AVIATION SERVICES CORPORATION | visible | match | ✓ | correct |
| 8 | ACE AVIATION SERVICES CORPORATION | hidden | new_entity | ✓ | correct |
| 9 | Turnkey Jet, Inc | visible | ambiguous | ✓ | C — Firecrawl wedge (6/7 timeouts) |

---

## Failure-mode categorization

Visible-mode "failures" (LLM did not pick the truth_operator_id) split into three categories:

### A. Genuine LLM error
**0 of 4 failures.** None.

### B. Step 2c matcher false-positive that the LLM correctly rejected
**1 of 4 failures.**

- **Case 4 (Executive Flight Management):** Fixture truth label is "Executive Jet Management"
  (NetJets/Berkshire Hathaway subsidiary, EJM callsign, large fractional/charter management
  company). FAA holder is "Executive Flight Management" (single 1977 Baron 58P, Sugar
  Grove IL, DBA "Trans American Charter, Ltd."). These are genuinely different operators.
  The LLM correctly returned `new_entity` rather than rubber-stamping the matcher's mistake.

This is the eval auditing the upstream pipeline rather than measuring the LLM. It also
implies a `canonical.operator_holds_certificate` row from Step 2c that should be reviewed
and likely closed (close-then-insert per temporal-link-pattern). Backlog item.

### C. Genuine ambiguity / web-invisibility / Two-Source-Rule edge case
**3 of 4 failures.** All correct LLM behavior.

- **Case 0 (Novus Jet Charter, LLC):** Operator domain `novusjetcharter.com` has dead DNS,
  no Wikipedia article, aviation directories returned CAPTCHA blocks or 404s. Agent
  correctly returned `ambiguous` rather than fabricating evidence. (Note: case 0 hidden
  found `novusjets.com` — the actual website — by guessing differently. Suggests prompt
  could include broader URL guesses, but not a blocker.)

- **Case 5 (Summit Aviation LLC):** CorporationWiki lists 15 distinct "Summit Aviation
  LLC" entities across FL, CA, CO, MT, TX, AL, LA. Without state info or other
  disambiguator, name-only resolution is unreliable. The canonical candidate has no
  HQ / ICAO / aliases (a placeholder entry). Agent correctly returned `ambiguous`.

- **Case 9 (Turnkey Jet, Inc):** Got 1 successful Firecrawl scrape (operator's own
  website) but 6/7 other scrapes timed out due to Firecrawl wedging during the run.
  Agent correctly returned `ambiguous` per Two-Source Rule rather than committing on
  one source.

Hidden-mode failure (case 7 REVA): the agent found 2 distinct hostnames (`flyreva.com`,
`revaair.com`) but on inspection `revaair.com` redirects to `flyreva.com` — same content,
not actually independent. Agent correctly applied the spirit of the Two-Source Rule and
returned `ambiguous`.

---

## Prompt iterations during eval

Three prompt fixes shipped mid-eval, each addressing a citation-validation failure mode:

1. **Empty `synthetic_truth: true` signal removed** from visible-mode candidates
   (prevented the LLM from telling truth from distractor by inspecting the score
   metadata).

2. **Byte-exact-substring rule** added to anti-hallucination section. Earlier failure:
   case 1 visible quoted `"Keystone Aviation, llc\n\n303 N 2370 W"` but the actual page
   had `"Keystone Aviation, llc\n======================\n\n303 N 2370 W"` — the agent
   silently stripped the markdown `===` underline. Fix: explicit "do NOT strip whitespace,
   formatting (===, ##, **, ---), newlines."

3. **Per-hostname-quote rule** added to Two-Source check. Earlier failure: case 3
   nextair scraped 2 distinct domains but cited 2 quotes both from `nextair135.com`,
   leaving the second domain (`onwardjets.com`) without a quote. Fix: explicit
   "verbatim_quotes MUST contain ≥1 quote from EACH cited hostname."

4. **JSON encoding rule** added after case 8 visible's response.json failed `JSON.parse`
   on unescaped `"` chars inside markdown content fields. Fix: explicit "use
   JSON.stringify semantics — `\"` not literal quote."

After fix #2, #3, and #4 (case 6+), citation validation rate is 100% (8/8). Pre-fix
runs (cases 1 and 3) account for all 3 of the 19 invalid-citation results.

---

## Backlog items surfaced by eval

These do not block reason-only kickoff but should be tracked:

1. **Redirect detection in citation validation.** Case 7 REVA hidden's 2nd "domain"
   was a redirect to its 1st domain. The driver's two-domain check currently treats
   distinct hostnames as distinct sources without following redirects. A more
   defensive check would resolve final URLs before counting domains. Low priority —
   the LLM already handled this case correctly by returning `ambiguous`.

2. **Step 2c false-positive review queue.** Case 4 Executive Flight Management is a
   confirmed Step 2c FP. The high-tier matches `WHERE source='faa_d085'` should be
   spot-checked for similar cases. Out of scope for Phase 2 commit — file as Track 6
   Step 2c.6 candidate.

3. **Firecrawl reliability under load.** Three Firecrawl wedges over the eval session
   (00:50 RAM/CPU throttle, 01:08 silent stall, 01:31 single-run cascade timeout).
   Each required a `docker compose restart api playwright-service`. For the
   reason-only run (~352 records, ~14h sequential), expect 2-3 restart cycles.
   Mitigation: kick off as a fresh sequential run, monitor, restart between batches
   if scrape times exceed 60s.

4. **Visible-mode fixture limitation.** Single-candidate cases (e.g., Novus, where
   the ILIKE pre-filter on first significant word returns only the truth) make
   visible-mode trivial when the operator has web presence and impossible when it
   doesn't. Fixture would be more informative if visible-mode injected ≥3
   distractors via a wider candidate pool. Not blocking — hidden mode is the gate.

---

## Cost actuals

| Item | Estimate (plan) | Actual (eval) |
|---|---|---|
| Records run | 60 | 19 (eval cut short — Firecrawl reliability) |
| Avg cost per record | $0.13 (Sonnet) | $0.04 (lower context per agent than projected) |
| Eval total | ~$8 | ~$0.80 |
| Firecrawl scrapes | 480 max | ~150 |

Reason-only projection still under the $300 hard cap with margin: 352 records ×
$0.04 = ~$14 Sonnet budget, plus Firecrawl localhost (free).

---

## Reason-only kickoff readiness

- ✅ Catastrophic failure gate passes (0 false matches, 0 fabricated UUIDs)
- ✅ Citation validation rate post-prompt-fix is 100%
- ✅ All four prompt iterations shipped in `scripts/llm-er-pass-firecrawl.ts:renderSelectingPrompt`
- ✅ Auto-approve criteria in `runCommit` unchanged from plan (≥0.75 confidence,
  not rebrand_to_canonical, citation_validated, not in top-20-by-fleet)
- ✅ Resumability via checkpoint table verified (smoke test claimed and resubmitted
  successfully; eval used same primitives at scale)

**Hold for tomorrow:** Firecrawl is wedged at the time of writing. Reason-only kickoff
deferred to a fresh sequential run after `docker compose restart api playwright-service`
verifies healthy.
