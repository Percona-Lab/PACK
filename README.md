# PACK — Portable Agent Context Keeper

A standalone [MCP](https://modelcontextprotocol.io/) server that gives any AI tool persistent memory — stored as a markdown file in a private GitHub repo.

Works with Claude Desktop, Open WebUI, Cursor, Windsurf, and any MCP-compatible client.

> 100% vibe coded with [Claude](https://claude.ai/).

## What it does

PACK exposes two tools over MCP:

- **`memory_get`** — Read the current memory (markdown).
- **`memory_update`** — Replace memory with new content. Each update is a git commit with full version history.

Memory is stored in a GitHub repo you control. Updates use SHA-based optimistic concurrency to prevent race conditions. Optional 1-way sync pushes memory to Google Docs and/or Notion for browser access.

## Setup

### 1. Create a memory repo

Create a **private** GitHub repo named `ai-memory-yourname` (e.g. `ai-memory-dennis`, `ai-memory-sarah`). The first `memory_update` call creates the `MEMORY.md` file automatically.

> **Privacy notice**: Your memory file will accumulate sensitive context over time — meeting notes, project details, personal preferences, etc. To protect your data:
>
> 1. **Always create the repo as Private** — never public or internal.
> 2. **If using a GitHub org, request that an admin restrict the repo to your account only** — by default, org owners and admins can see all repos, even private ones. Ask an admin to limit collaborator access to just you.
> 3. **Do not store secrets** (passwords, API tokens, credentials) in your memory file. Treat it as sensitive but not secret.

Generate a [fine-grained personal access token](https://github.com/settings/tokens?type=beta) with:
- **Repository access**: Only select your `ai-memory-yourname` repo
- **Permissions**: Contents → Read and write

### 2. Install PACK

```bash
git clone https://github.com/Percona-Lab/pack.git
cd pack
npm install
```

### 3. Configure

Create `~/.pack.env` (outside the repo for security):

```bash
GITHUB_TOKEN=ghp_...              # Fine-grained PAT
GITHUB_OWNER=your-username        # GitHub user or org
GITHUB_REPO=ai-memory-yourname    # Your private memory repo
GITHUB_MEMORY_PATH=MEMORY.md      # File path (default: MEMORY.md)
```

### 4. Run

```bash
# Streamable HTTP (Open WebUI, modern MCP clients)
node servers/memory.js --http      # http://localhost:3005/mcp

# stdio (Claude Desktop, Cursor, Windsurf)
node servers/memory.js

# Legacy SSE
node servers/memory.js --sse-only  # http://localhost:3005/sse
```

Override the port with `MCP_SSE_PORT=4000`.

Verify it's running:

```bash
curl http://localhost:3005/health
```

## Connecting to MCP clients

### Claude Desktop / Cursor / Windsurf

Add to your MCP config:

```json
{
  "mcpServers": {
    "pack": {
      "command": "node",
      "args": ["/path/to/pack/servers/memory.js"]
    }
  }
}
```

### Open WebUI

1. Start: `node servers/memory.js --http`
2. In Open WebUI: **Settings → Tools → MCP Servers**
3. Add: Type **Streamable HTTP**, URL `http://host.docker.internal:3005/mcp`

### System prompt (recommended)

Add this to your model's system prompt so it knows when to use memory:

```
You have access to persistent memory tools: memory_get and memory_update.

Use memory_get when:
- The user says "what do you know about me" or asks for context from previous conversations
- The user references something you should already know
- You need background on a project, preference, or decision

Use memory_update when:
- The user says "remember this", "save this", or "update memory"
- The user shares important context they'll want you to recall later

When updating memory:
1. Always call memory_get first to fetch the current content
2. Merge new information into the existing markdown — never overwrite from scratch
3. Call memory_update with the complete updated markdown
4. Use clear ## headings and bullet points to keep it organized

Do not call memory_get at the start of every conversation — only when context is needed.
```

## Sync (optional)

After each `memory_update`, content can be automatically synced to Google Docs and/or Notion. Sync is 1-way (GitHub → targets), non-blocking, and failures never break the memory update.

This makes your memory readable in a browser and accessible to other AI tools like Gemini and ChatGPT.

### Notion sync

Add to `~/.pack.env`:

```bash
NOTION_TOKEN=ntn_...
NOTION_SYNC_PAGE_ID=abcdef1234567890  # Page to overwrite with memory content
```

Create a **dedicated, private** Notion page for this — its content will be replaced on each update. Do not use a page that is shared with others unless you want them to see your memory.

### Google Docs sync

**Step 1:** Create OAuth credentials at [Google Cloud Console](https://console.cloud.google.com/) → enable Google Docs API → create OAuth client ID (Desktop app).

**Step 2:** Get a refresh token:

```bash
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node scripts/google-auth.js
```

**Step 3:** Add to `~/.pack.env`:

```bash
GOOGLE_DOC_ID=1BxiMVs0XRA5nF...
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REFRESH_TOKEN=1//0eXXXX...
```

> **Privacy reminder**: Keep the Google Doc restricted to your account only. Do not share the document link — anyone with access can read your full memory.

### Sync behavior

- Both targets are optional and independent — configure one, both, or neither
- Sync runs in the background after GitHub write succeeds
- Failures are logged to stderr but don't affect the `memory_update` response
- Google Docs receives plain markdown text
- Notion receives structured blocks (headings, bullets, code blocks)

## Project structure

```
├── servers/
│   ├── memory.js          # MCP server entry point
│   └── shared.js          # Transport abstraction (stdio, HTTP, SSE)
├── connectors/
│   ├── github.js          # GitHub Contents API (memory backend)
│   ├── memory-sync.js     # Sync orchestrator
│   ├── notion-sync.js     # Notion write connector (for sync)
│   └── google-docs.js     # Google Docs write connector (for sync)
├── scripts/
│   └── google-auth.js     # One-time Google OAuth2 setup
└── package.json
```

## License

MIT
