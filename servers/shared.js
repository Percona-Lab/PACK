import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import crypto from 'crypto';
import dotenv from 'dotenv';
import http from 'http';
import { homedir } from 'os';
import { join } from 'path';

// Load env from ~/.pack.env (outside the repo for security)
dotenv.config({ path: join(homedir(), '.pack.env'), override: true });

/**
 * Create and run a standalone MCP server.
 * @param {object} opts
 * @param {string} opts.name - Server name
 * @param {Array} opts.tools - Tool definitions array
 * @param {function} opts.handler - async (name, args) => result object
 * @param {number} [opts.defaultPort] - HTTP/SSE port (default 3005)
 */
export async function createMCPServer({ name, tools, handler, defaultPort = 3005 }) {
  const port = process.env.MCP_SSE_PORT || defaultPort;

  function buildServer() {
    const server = new Server(
      { name, version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name: toolName, arguments: args } = request.params;
        const result = await handler(toolName, args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    });

    return server;
  }

  const mode = process.argv[2];

  if (mode === '--http') {
    const sessions = {};
    const httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: name, transport: 'streamable-http', port }));
        return;
      }

      if (req.url === '/mcp') {
        const sessionId = req.headers['mcp-session-id'];

        if (req.method === 'POST') {
          if (sessionId && sessions[sessionId]) {
            await sessions[sessionId].handleRequest(req, res);
            return;
          }
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid) => { sessions[sid] = transport; },
          });
          transport.onclose = () => {
            const sid = Object.keys(sessions).find(k => sessions[k] === transport);
            if (sid) delete sessions[sid];
          };
          const server = buildServer();
          await server.connect(transport);
          await transport.handleRequest(req, res);
        } else if (req.method === 'GET') {
          if (sessionId && sessions[sessionId]) {
            await sessions[sessionId].handleRequest(req, res);
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No valid session. Send an initialize request first.' }));
          }
        } else if (req.method === 'DELETE') {
          if (sessionId && sessions[sessionId]) {
            await sessions[sessionId].handleRequest(req, res);
            delete sessions[sessionId];
          } else { res.writeHead(404); res.end('Session not found'); }
        } else { res.writeHead(405); res.end('Method not allowed'); }
      } else { res.writeHead(404); res.end('Not found'); }
    });

    httpServer.listen(port, () => {
      console.error(`${name} — Streamable HTTP on http://localhost:${port}/mcp`);
    });

  } else if (mode === '--sse-only') {
    const sseServer = buildServer();
    const transports = {};
    const httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.url === '/sse' && req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        transports[transport.sessionId] = transport;
        res.on('close', () => { delete transports[transport.sessionId]; });
        await sseServer.connect(transport);
      } else if (req.url === '/messages' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          const url = new URL(req.url, `http://localhost:${port}`);
          const sessionId = url.searchParams.get('sessionId');
          const transport = transports[sessionId];
          if (transport) {
            req.body = body;
            await transport.handlePostMessage(req, res);
          } else { res.writeHead(404); res.end('Session not found'); }
        });
      } else if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: name, transport: 'sse', port }));
      } else { res.writeHead(404); res.end('Not found'); }
    });

    httpServer.listen(port, () => {
      console.error(`${name} — SSE on http://localhost:${port}/sse`);
    });

  } else {
    // stdio
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`${name} — running on stdio`);
  }
}
