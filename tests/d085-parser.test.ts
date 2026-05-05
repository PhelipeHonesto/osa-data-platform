import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { S3Client } from "@aws-sdk/client-s3";
import {
  parseD085Xlsx,
  fetchS3Json,
  fetchS3Buffer,
  INDEX_KEY,
  type IndexFile,
} from "../src/utils/d085-parser.js";

const MAY_1_URL =
  "https://www.faa.gov/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_List.xlsx";
const TMP_PATH_A = `/tmp/osa-session-a5-test-${process.pid}-A.xlsx`;

describe("d085-parser — May 1 dialect (Test A)", () => {
  it("parses 11,465 rows from the live May 1 Part 135 file with correct schema", async () => {
    try {
      const resp = await fetch(MAY_1_URL);
      if (!resp.ok) {
        throw new Error(`Failed to fetch May 1 file from FAA: HTTP ${resp.status}`);
      }
      const ab = await resp.arrayBuffer();
      const buf = Buffer.from(ab);
      writeFileSync(TMP_PATH_A, buf);

      // parseD085Xlsx requires an xlsxS3Key in canonical shape so it can
      // extract a 14-digit cdxTs. Synthesize one matching the May 1
      // Last-Modified timestamp recorded in the recon (Fri 1 May 2026 17:20:56).
      const fakeKey =
        "raw/faa/d085/xlsx/20260501172056__Part_135_Operators_and_Aircraft_List.xlsx";
      const rows = parseD085Xlsx(buf, fakeKey);

      // Recon baseline: exactly 11,465 data rows.
      expect(rows.length).toBe(11465);

      // ≥99.5% of cert_designators match the FAA designator regex.
      const validCerts = rows.filter((r) => /^[0-9A-Z]{3,5}$/.test(r.cert_number)).length;
      expect(validCerts / rows.length).toBeGreaterThanOrEqual(0.995);

      // 100% of operator_names non-empty.
      const nonEmptyNames = rows.filter((r) => r.holder_name.length > 0).length;
      expect(nonEmptyNames).toBe(rows.length);

      // CFR distribution: recon shows ~98.9% '135' + ~1.1% '121/135'.
      // Loose assertion: ≥95% '135' AND ≥0.5% '121/135' AND together = 100%.
      const part135 = rows.filter((r) => r.operating_part === "135").length;
      const dual = rows.filter((r) => r.operating_part === "121/135").length;
      expect(part135 / rows.length).toBeGreaterThanOrEqual(0.95);
      expect(dual / rows.length).toBeGreaterThanOrEqual(0.005);
      expect(part135 + dual).toBe(rows.length);

      // New post-2026-05 fields populated.
      expect(rows[0]!.operating_part).toBeTruthy();
      expect(rows[0]!.fsdo).toBeTruthy();
      expect(rows[0]!.make_model_series).toBeTruthy();
    } finally {
      try {
        unlinkSync(TMP_PATH_A);
      } catch {
        // file may not exist if fetch failed — swallow ENOENT
      }
    }
  }, 60_000);
});

describe("d085-parser — historical dialect (Test B)", () => {
  it("parses an older D085 archive and still extracts cert + name", async () => {
    const s3 = new S3Client({});

    let index: IndexFile;
    try {
      index = await fetchS3Json<IndexFile>(s3, INDEX_KEY);
    } catch (err) {
      throw new Error(
        `Test B requires S3 access to read s3://osa-dumont-backup/${INDEX_KEY}. ` +
          `Configure AWS credentials or the test will not pass. Underlying error: ${(err as Error).message}`,
      );
    }

    // Pick the most-recent pre-2026-05 xlsx (last historical capture before
    // the May 1 restoration), so we exercise the OLD dialect candidates.
    const candidate = index.snapshots
      .filter((s) => s.xlsx_archived && s.xlsx_s3_key !== null)
      .filter((s) => s.snapshot_timestamp.slice(0, 6) < "202605")
      .sort((a, b) => b.snapshot_timestamp.localeCompare(a.snapshot_timestamp))[0];

    if (!candidate || !candidate.xlsx_s3_key) {
      throw new Error(
        `Test B: no pre-2026-05 historical xlsx found in s3://osa-dumont-backup/${INDEX_KEY}. ` +
          `Expected at least one snapshot with xlsx_archived=true and snapshot_timestamp < 202605.`,
      );
    }

    const buf = await fetchS3Buffer(s3, candidate.xlsx_s3_key);
    const rows = parseD085Xlsx(buf, candidate.xlsx_s3_key);

    // Resilient assertions — don't hardcode row counts (drift across captures).
    // Field presence (operating_part / fsdo / make_model_series) varies by
    // archive year and is intentionally not asserted here.
    expect(rows.length).toBeGreaterThan(0);

    const validCerts = rows.filter((r) => /^[0-9A-Z]{3,5}$/.test(r.cert_number)).length;
    expect(validCerts / rows.length).toBeGreaterThanOrEqual(0.99);

    const nonEmptyNames = rows.filter((r) => r.holder_name.length > 0).length;
    expect(nonEmptyNames).toBe(rows.length);
  }, 60_000);
});
