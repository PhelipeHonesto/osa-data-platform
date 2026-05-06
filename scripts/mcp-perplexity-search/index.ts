#!/usr/bin/env node
/**
 * Thin MCP server wrapper around the Perplexity Search API.
 *
 * Architecture per Session B V4: Sonnet (reasoning) + Perplexity
 * (discovery) + Firecrawl (scrape). This server provides the discovery
 * leg. Agent calls perplexity_search(query) to get a ranked URL list,
 * then picks 2-4 URLs covering ≥2 distinct buckets and scrapes them
 * via firecrawl_scrape for verbatim quote capture.
 *
 * Endpoint: POST https://api.perplexity.ai/search
 * Auth:     Bearer ${PERPLEXITY_API_KEY}
 * Body:     {"query": string, "max_results"?: number}
 * Returns:  results[] with {url, title, snippet, date, last_updated}
 *
 * Cost: $0.005/query at the time of writing. Session B budget covers
 * ~700 queries (~$3.50 — well within the $50 cap).
 *
 * Usage:
 *   1. Add PERPLEXITY_API_KEY to .env (or shell env).
 *   2. cd scripts/mcp-perplexity-search && npm install
 *   3. Add to Claude Code MCP config (see README.md).
 *   4. Restart Claude Code; agent spawns can then call perplexity_search.
 */

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PERPLEXITY_ENDPOINT = "https://api.perplexity.ai/search";
const DEFAULT_MAX_RESULTS = 10;
const HARD_MAX_RESULTS = 25; // defensive cap; Perplexity API max is unclear

interface PerplexityResult {
  url: string;
  title: string;
  snippet: string;
  date?: string;
  last_updated?: string;
}

interface PerplexityResponse {
  results: PerplexityResult[];
  // ... other fields ignored
}

const server = new Server(
  { name: "perplexity-search", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "perplexity_search",
      description:
        "Web search via Perplexity API. Returns ranked URL list with title, snippet, and date. " +
        "Use for discovery (find which URLs to scrape). Pair with mcp__firecrawl__firecrawl_scrape " +
        "for verbatim quote capture from selected URLs.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query. Just the entity name for the cleanest results — Perplexity ranks well without qualifiers.",
            minLength: 1,
          },
          max_results: {
            type: "number",
            description: `Number of results to return (default ${DEFAULT_MAX_RESULTS}, max ${HARD_MAX_RESULTS}).`,
            default: DEFAULT_MAX_RESULTS,
            minimum: 1,
            maximum: HARD_MAX_RESULTS,
          },
        },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "perplexity_search") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const args = (request.params.arguments ?? {}) as {
    query?: string;
    max_results?: number;
  };

  if (!args.query || typeof args.query !== "string") {
    throw new Error("perplexity_search: 'query' (string) is required");
  }

  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "PERPLEXITY_API_KEY not set in environment. Add to .env or export in shell.",
    );
  }

  const maxResults = Math.min(
    HARD_MAX_RESULTS,
    Math.max(1, Math.floor(args.max_results ?? DEFAULT_MAX_RESULTS)),
  );

  const response = await fetch(PERPLEXITY_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: args.query,
      max_results: maxResults,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(
      `Perplexity API error ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
    );
  }

  const data = (await response.json()) as PerplexityResponse;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
