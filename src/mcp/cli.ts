import 'dotenv/config';
import { startMcpServer } from './server.js';

startMcpServer().catch(e => {
  process.stderr.write(`MCP server fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
