# mcp-perplexity-search

Thin MCP server wrapping the Perplexity Search API. Provides the
discovery leg of Session B's three-tool LLM ER architecture:

- **Sonnet 4.6** — reasoning
- **Perplexity Search API** — discovery (this server)
- **Firecrawl** — scrape (verbatim quote capture)

Each tool does what it's good at. Cost: ~$0.005 per query, ~$3.50
across Session B's 700-ish discovery queries.

## Setup (one-time, ~10 min)

### 1. Get a Perplexity API key

- Sign up at https://www.perplexity.ai/settings/api (top-right
  account → Settings → API).
- Generate a key starting with `pplx-`.

### 2. Add the key to your environment

Append to `~/osa/osa-data-platform/.env`:

```
PERPLEXITY_API_KEY=pplx-your-key-here
```

### 3. Install dependencies

```
cd ~/osa/osa-data-platform/scripts/mcp-perplexity-search
npm install
```

### 4. Register the server in Claude Code's MCP config

Edit `~/.claude.json` (or wherever your Claude Code MCP config
lives). Add to the `mcpServers` block:

```json
{
  "mcpServers": {
    "perplexity-search": {
      "command": "npx",
      "args": [
        "tsx",
        "/Users/phelipehonesto/osa/osa-data-platform/scripts/mcp-perplexity-search/index.ts"
      ],
      "env": {
        "PERPLEXITY_API_KEY": "${PERPLEXITY_API_KEY}"
      }
    }
  }
}
```

If the `mcpServers` block doesn't exist yet, create it as the top
level. If other servers are already registered (firecrawl,
claude-in-chrome, etc.), add `perplexity-search` as a sibling key
inside the existing object.

The `${PERPLEXITY_API_KEY}` syntax pulls from the parent shell env,
so make sure the key is exported (or sourced from `.env`) before
launching Claude Code.

### 5. Restart Claude Code

The MCP server loads at session start. After restart, agent spawns
will see a deferred `mcp__perplexity-search__perplexity_search` tool.

### 6. Smoke test (optional)

Spawn an agent with this prompt to verify wiring:

```
Use the perplexity_search MCP tool (you may need to load it via
ToolSearch with query 'select:mcp__perplexity-search__perplexity_search'
first) to search for "Keystone Aviation, LLC". Return the JSON
response verbatim.
```

Expected: a JSON object with a `results` array of ~10 items, each
containing `url`, `title`, `snippet`, `date`. The Keystone search
should surface eag.aero (rebrand to Elevate Jet press release),
keystoneaviation.com, regulations.gov DOT filing, and aviation press
aggregators.

If you get an "PERPLEXITY_API_KEY not set" error, check your env
isn't being clobbered by Claude Code — the `env` block in the MCP
config should pass the key through.

## Tool surface

### `perplexity_search`

```
input:
  query: string                  (required)
  max_results: number = 10       (1..25)

output:
  results: Array<{
    url: string,
    title: string,
    snippet: string,
    date?: string,
    last_updated?: string
  }>
```

Use the discovery output to identify URLs by Two-Source bucket
(see V4 prompt's bucket map), then `mcp__firecrawl__firecrawl_scrape`
the selected URLs for verbatim quote capture.

## Why a thin wrapper

The Perplexity API endpoint is one POST request with a JSON body. We
don't need a complex client — just authentication, the request, and
returning the response verbatim. The MCP-server boilerplate
(`@modelcontextprotocol/sdk`) is the bulk of the code, not the
Perplexity-specific logic.

## Future expansion

If this becomes load-bearing infrastructure (Loud Hawk editorial
research, OSA Connect operator verification), promote it to the
workspace level (`~/osa/mcp-servers/perplexity-search/`) with
shared installation. For now it lives in `osa-data-platform/scripts/`
so it commits with the LLM ER pass work.
