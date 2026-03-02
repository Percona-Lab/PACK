#!/usr/bin/env node

import fetch from 'node-fetch';
import { createMCPServer } from './shared.js';
import { GitHubConnector } from '../connectors/github.js';
import { MemorySyncManager } from '../connectors/memory-sync.js';

const github = new GitHubConnector(
  process.env.GITHUB_TOKEN,
  process.env.GITHUB_OWNER,
  process.env.GITHUB_REPO,
  process.env.GITHUB_MEMORY_PATH || 'MEMORY.md'
);

// Built-in sync (Google Docs, Notion)
const sync = new MemorySyncManager();
await sync.init();
if (sync.enabled) {
  console.error(`[pack] Sync targets: ${sync.targets.join(', ')}`);
}

// Webhook sync (n8n, Zapier, etc.)
const webhookUrl = process.env.PACK_WEBHOOK_URL;
if (webhookUrl) {
  console.error(`[pack] Webhook: ${webhookUrl}`);
}

async function fireWebhook(content, message, commitResult) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'memory_update',
        content,
        message: message || 'Update memory',
        repo: `${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}`,
        sha: commitResult.sha,
        commit_url: commitResult.commit_url,
        timestamp: new Date().toISOString(),
      }),
    });
    console.error('[webhook] ok');
  } catch (err) {
    console.error('[webhook] failed -', err.message);
  }
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
        // Fire-and-forget: built-in sync and webhook run in parallel
        if (sync.enabled || webhookUrl) {
          const tasks = [];
          if (sync.enabled) tasks.push(sync.sync(args.content));
          if (webhookUrl) tasks.push(fireWebhook(args.content, args.message, result));
          Promise.allSettled(tasks).catch(() => {});
        }
        return result;
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }
  },
});
