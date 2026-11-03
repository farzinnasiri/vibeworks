// Boundary fixture only. It uses the real SDK stdio adapter and HTTP bridge,
// but the owning test controls the runtime replies, not a geometry kernel.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from '../src/bridge/mcp.ts';
import { forwardCommand } from '../src/bridge/client.ts';
serveStdio(() => createMcpServer((command) => forwardCommand(command, async () => JSON.parse(process.env.CAD_TEST_CONNECTION!))));
