#!/usr/bin/env node

import fetch from 'node-fetch';
import { createMCPServer } from './shared.js';
import { GitHubConnector } from '../connectors/github.js';
import { MemorySyncManager } from '../connectors/memory-sync.js';
import { MemoryCore } from '../core/memory.js';
import { parse } from '../core/frontmatter.js';

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
sync.setGitHubConnector(github);
if (sync.enabled) {
  const modeLabel = sync.notionSyncMode === 'multi' ? 'notion (multi-page)' : sync.targets.join(', ');
  console.error(`[pack] Sync targets: ${modeLabel}`);
}

// Webhook sync (n8n, Zapier, etc.)
const webhookUrl = process.env.PACK_WEBHOOK_URL;
const webhookVersion = process.env.PACK_WEBHOOK_VERSION;
if (webhookUrl) {
  console.error(`[pack] Webhook: ${webhookUrl}`);
}

async function fireWebhook(path, content, message, commitResult, fullContent) {
  if (!webhookUrl) return;
  try {
    let payload;

    if (webhookVersion === '1') {
      // v1 format: full concatenated content, no path or version field
      payload = {
        event: 'memory_update',
        content: fullContent || content,
        message: message || 'Update memory',
        repo: `${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}`,
        sha: commitResult.sha,
        commit_url: commitResult.commit_url,
        timestamp: new Date().toISOString(),
      };
    } else {
      // Default: per-file content with version field (current behavior)
      payload = {
        event: 'memory_update',
        version: 2,
        file: path || null,
        path: path || null,
        content,
        message: message || 'Update memory',
        repo: `${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}`,
        sha: commitResult.sha,
        commit_url: commitResult.commit_url,
        timestamp: new Date().toISOString(),
      };
    }

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.error('[webhook] ok');
  } catch (err) {
    console.error('[webhook] failed -', err.message);
  }
}

async function fireSyncAndWebhook(path, content, message, result) {
  const tasks = [];

  // Get full concatenated content (needed for Google Docs, v1 webhook, full export page)
  const syncContent = sync.enabled || webhookVersion === '1'
    ? await core.getSyncContent()
    : null;

  if (sync.enabled) {
    // Build per-file update info for multi-page Notion sync
    let fileUpdate = null;
    if (sync.notionSyncMode === 'multi' && path) {
      const { frontmatter, body } = parse(content);
      const allFiles = await core.getFilesWithMeta();
      fileUpdate = {
        path,
        content: body.trim(),
        topic: frontmatter.topic || path.replace(/\.md$/, '').split('/').pop(),
        allFiles,
      };
    }
    tasks.push(sync.sync(syncContent, fileUpdate));
  }

  if (webhookUrl) {
    tasks.push(fireWebhook(path, content, message, result, syncContent));
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
      description: 'Read a memory file by path. Without path: returns all memory concatenated.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (e.g., "projects/binlog-server.md"). Omit for full memory.' },
        },
      },
    },
    {
      name: 'memory_update',
      description: 'Write a memory file. Pass a file path and the full file content.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (e.g., "projects/binlog-server.md")' },
          content: { type: 'string', description: 'Full file content (YAML frontmatter + markdown body)' },
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
        // Fire-and-forget sync + webhook
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
