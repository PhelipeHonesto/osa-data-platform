import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';

const VERSION = '0.1.0';

const connStr = process.env['OSA_MCP_READONLY_URL'];
if (!connStr) {
  process.stderr.write('OSA_MCP_READONLY_URL is not set — aborting\n');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: connStr,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', err => {
  process.stderr.write(`[mcp-pool] unexpected error: ${err.message}\n`);
});

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'osa-data-platform', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'run_sql',
        description:
          'Execute a read-only SQL query against the OSA aviation database. ' +
          'Returns rows as JSON. Queries are automatically limited — the underlying ' +
          'role has SELECT-only permissions so INSERT/UPDATE/DELETE/DROP will fail safely.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'SQL query to execute.' },
            limit: {
              type: 'number',
              description: 'Max rows to return (default 100, cap 1000).',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'describe_schema',
        description:
          'Describe tables and columns in the public schema. Without arguments, ' +
          'returns all tables with their columns. With a table argument, returns ' +
          'just that table. Use this to understand the schema before writing queries.',
        inputSchema: {
          type: 'object',
          properties: {
            table: {
              type: 'string',
              description: 'Specific table name. Omit to return all tables.',
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    const params = args ?? {};

    try {
      switch (name) {
        case 'run_sql':
          return ok(await handleRunSql(params));
        case 'describe_schema':
          return ok(await handleDescribeSchema(params));
        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function handleRunSql(p: Record<string, unknown>) {
  const query = typeof p['query'] === 'string' ? p['query'] : '';
  if (!query.trim()) throw new Error('`query` is required');

  const rawLimit = typeof p['limit'] === 'number' ? p['limit'] : 100;
  const limit = Math.min(Math.max(1, rawLimit), 1000);

  const finalQuery = /\blimit\s+\d+/i.test(query)
    ? query
    : `SELECT * FROM (${query}) _sub LIMIT ${limit}`;

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '10s'`);
    const result = await client.query(finalQuery);
    return {
      rowCount: result.rowCount,
      columns: result.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
      rows: result.rows,
    };
  } finally {
    client.release();
  }
}

async function handleDescribeSchema(p: Record<string, unknown>) {
  const table = typeof p['table'] === 'string' ? p['table'] : null;

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '10s'`);
    const result = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      ordinal_position: number;
    }>(
      `SELECT t.table_name, c.column_name, c.data_type, c.is_nullable, c.ordinal_position
       FROM information_schema.tables t
       JOIN information_schema.columns c
         ON t.table_name = c.table_name AND t.table_schema = c.table_schema
       WHERE t.table_schema = 'public'
         AND t.table_type = 'BASE TABLE'
         AND ($1::text IS NULL OR t.table_name = $1)
       ORDER BY t.table_name, c.ordinal_position`,
      [table],
    );

    type TableEntry = { name: string; columns: { name: string; type: string; nullable: boolean }[] };
    const tableMap = new Map<string, TableEntry>();
    for (const row of result.rows) {
      if (!tableMap.has(row.table_name)) {
        tableMap.set(row.table_name, { name: row.table_name, columns: [] });
      }
      tableMap.get(row.table_name)!.columns.push({
        name: row.column_name,
        type: row.data_type,
        nullable: row.is_nullable === 'YES',
      });
    }

    return { tables: Array.from(tableMap.values()) };
  } finally {
    client.release();
  }
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}
