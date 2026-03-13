#!/usr/bin/env node

import fetch from 'node-fetch';
import { createMCPServer } from './shared.js';
import { GitHubConnector } from '../connectors/github.js';
import { MemorySyncManager } from '../connectors/memory-sync.js';
import { MemoryCore } from '../core/memory.js';

const github = new GitHubConnector(
  process.env.GITHUB_TOKEN,
  process.env.GITHUB_OWNER,
  process.env.GITHUB_REPO,
  process.env.GITHUB_MEMORY_PATH || 'MEMORY.md'
);

const core = new MemoryCore(github);

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

async function fireWebhook(path, content, message, commitResult) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'memory_update',
        path: path || null,
        content,
        message: message || 'Update memory',
        repo: `${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}`,
        sha: commitResult.sha,
        commit_url: commitResult.commit_url,
        timestamp: new Date().toISOString(),
        version: path ? 2 : 1,
      }),
    });
    console.error('[webhook] ok');
  } catch (err) {
    console.error('[webhook] failed -', err.message);
  }
}

async function fireSyncAndWebhook(path, content, message, result) {
  const tasks = [];
  if (sync.enabled) {
    // For v2, sync the full concatenated content, not just the updated file
    const syncContent = await core.getSyncContent();
    tasks.push(sync.sync(syncContent));
  }
  if (webhookUrl) {
    tasks.push(fireWebhook(path, content, message, result));
  }
  if (tasks.length) Promise.allSettled(tasks).catch(() => {});
}

// Detect mode at startup for logging
const mode = await core.detectMode();
console.error(`[pack] Mode: ${mode}`);

await createMCPServer({
  name: 'pack',
  defaultPort: 3005,
  tools: [
    {
      name: 'memory_list',
      description: 'List memory files with optional filtering. Returns the index. Call at session start.',
      inputSchema: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Filter by tag' },
          topic: { type: 'string', description: 'Filter by topic' },
          dir: { type: 'string', description: 'Filter by directory (e.g., "projects/")' },
        },
      },
    },
    {
      name: 'memory_get',
      description: 'Get persistent memory contents. In v2: pass a file path. Without path: returns all memory concatenated.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (e.g., "projects/binlog-server.md"). Omit for full memory.' },
        },
      },
    },
    {
      name: 'memory_update',
      description: 'Write a memory file. In v2: pass a file path and content. Without path: saves to context/general.md.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (e.g., "projects/binlog-server.md")' },
          content: { type: 'string', description: 'Full file content (frontmatter + body for v2, or markdown for v1)' },
          sha: { type: 'string', description: 'SHA for optimistic concurrency (required for existing files in v2)' },
          message: { type: 'string', description: 'Git commit message' },
        },
        required: ['content'],
      },
    },
    {
      name: 'memory_search',
      description: 'Search across all memory files by content or frontmatter.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term' },
        },
        required: ['query'],
      },
    },
  ],
  handler: async (name, args) => {
    switch (name) {
      case 'memory_list':
        return core.list({ tag: args.tag, topic: args.topic, dir: args.dir });

      case 'memory_get':
        return core.get(args.path);

      case 'memory_update': {
        const result = await core.update({
          path: args.path,
          content: args.content,
          sha: args.sha,
          message: args.message,
        });
        // Fire-and-forget sync + webhook (Contract C3: sync receives single markdown string)
        fireSyncAndWebhook(args.path, args.content, args.message, result);
        return result;
      }

      case 'memory_search':
        return core.search(args.query);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  },
});
