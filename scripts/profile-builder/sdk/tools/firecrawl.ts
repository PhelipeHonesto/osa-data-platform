/**
 * Firecrawl HTTP wrapper for the SDK runner.
 *
 * Sonnet sees this as a `firecrawl_scrape` tool. We translate to the
 * Firecrawl /v1/scrape API. Returns markdown content + URL, matching
 * the shape MCP returned during calibration.
 */

const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/scrape";

export interface FirecrawlScrapeResult {
  url: string;
  content: string;       // markdown
  status_code: number;
  fetched_at: string;    // ISO 8601
}

export async function firecrawlScrape(url: string): Promise<FirecrawlScrapeResult> {
  const apiKey = process.env["FIRECRAWL_API_KEY"];
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY not set");

  const body = {
    url,
    formats: ["markdown"],
    onlyMainContent: true,
  };

  const res = await fetch(FIRECRAWL_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const fetched_at = new Date().toISOString();

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`firecrawl_http_${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json() as {
    success?: boolean;
    data?: { markdown?: string; metadata?: { statusCode?: number } };
    error?: string;
  };

  if (!json.success) {
    throw new Error(`firecrawl_failed: ${json.error ?? "unknown"}`);
  }

  return {
    url,
    content: json.data?.markdown ?? "",
    status_code: json.data?.metadata?.statusCode ?? 200,
    fetched_at,
  };
}
