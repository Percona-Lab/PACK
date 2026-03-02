#!/usr/bin/env node

import { createMCPServer } from './shared.js';
import { GitHubConnector } from '../connectors/github.js';
import { MemorySyncManager } from '../connectors/memory-sync.js';

const github = new GitHubConnector(
  process.env.GITHUB_TOKEN,
  process.env.GITHUB_OWNER,
  process.env.GITHUB_REPO,
  process.env.GITHUB_MEMORY_PATH || 'MEMORY.md'
);

const sync = new MemorySyncManager();
await sync.init();
if (sync.enabled) {
  console.error(`[pack] Sync targets: ${sync.targets.join(', ')}`);
}

await createMCPServer({
  name: 'pack',
  defaultPort: 3005,
  tools: [
    {
      name: 'memory_get',
      description: 'Get persistent memory contents (markdown).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'memory_update',
      description: 'Replace persistent memory with new markdown content.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Full markdown content' },
          message: { type: 'string', description: 'Commit message' },
        },
        required: ['content'],
      },
    },
  ],
  handler: async (name, args) => {
    switch (name) {
      case 'memory_get': return github.getMemory();
      case 'memory_update': {
        const result = await github.updateMemory(args.content, args.message);
        if (sync.enabled) {
          sync.sync(args.content).catch(() => {});
        }
        return result;
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }
  },
});
