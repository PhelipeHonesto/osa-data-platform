/**
 * Perplexity HTTP wrapper for the SDK runner.
 *
 * Sonnet sees this as a `perplexity_search` tool. We translate the
 * tool_use call into a Perplexity Sonar API request, parse the response,
 * and surface a normalized {results: [{url, title, snippet, date}]}
 * shape that matches what the MCP server returned during V1.1 calibration.
 *
 * Perplexity Sonar API: https://api.perplexity.ai/chat/completions
 *   - Returns citations (URLs) plus a synthesized answer.
 *   - We extract URLs from the citations array, plus titles/snippets
 *     from the parallel search_results structure when present.
 */

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_MODEL = "sonar";  // basic search-grounded model

export interface PerplexityResult {
  url: string;
  title?: string;
  snippet?: string;
  date?: string;
}

export interface PerplexityResponse {
  query: string;
  n_results: number;
  results: PerplexityResult[];
  raw_answer?: string;  // Sonar's synthesized answer, useful for context
}

export async function perplexitySearch(query: string): Promise<PerplexityResponse> {
  const apiKey = process.env["PERPLEXITY_API_KEY"];
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY not set");

  const body = {
    model: PERPLEXITY_MODEL,
    messages: [
      { role: "user", content: query },
    ],
    return_related_questions: false,
    web_search_options: { search_context_size: "medium" },
  };

  const res = await fetch(PERPLEXITY_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`perplexity_http_${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json() as {
    citations?: string[];
    search_results?: Array<{ url?: string; title?: string; snippet?: string; date?: string }>;
    choices?: Array<{ message?: { content?: string } }>;
  };

  const answer = json.choices?.[0]?.message?.content;
  const sr = json.search_results ?? [];
  const cit = json.citations ?? [];

  // Prefer search_results when available (it has title/snippet); fall back
  // to citations array of bare URLs.
  let results: PerplexityResult[];
  if (sr.length > 0) {
    results = sr.flatMap((r) => r.url ? [{
      url: r.url,
      ...(r.title ? { title: r.title } : {}),
      ...(r.snippet ? { snippet: r.snippet } : {}),
      ...(r.date ? { date: r.date } : {}),
    }] : []);
  } else {
    results = cit.map((url) => ({ url }));
  }

  return {
    query,
    n_results: results.length,
    results: results.slice(0, 10),
    ...(answer ? { raw_answer: answer } : {}),
  };
}
