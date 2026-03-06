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
git clone https://github.com/Percona-Lab/PACK.git
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

### System prompt (critical)

> **Warning**: Without this system prompt, models may overwrite your entire memory file instead of merging changes. Always add this prompt to your AI client.
>
> - **Open WebUI**: Settings → General → System Prompt
> - **Claude Desktop**: Add to your project's custom instructions
> - **Cursor / Windsurf**: Add to your rules or system prompt settings

The prompt teaches the model to read-before-write and merge, which prevents data loss:

```
You have access to persistent memory via pack (memory_get / memory_update).
- Use memory_get when you need context from previous sessions, or the user asks "what do you know"
- Use memory_update when the user says "remember this", "save this", or asks you to store any information — this is the user's personal memory and they decide what goes in it
- CRITICAL: Before EVERY memory_update, you MUST call memory_get first. The memory file may contain important content from other sessions. Read it, merge your changes into the existing content, then write the complete updated markdown. Never overwrite blindly.
- Keep memory organized with ## headings and bullet points
At the start of every conversation:
- Call memory_get to load persistent memory
```

## Sync (optional)

After each `memory_update`, content can be automatically synced to external targets. Sync is 1-way (GitHub → targets), non-blocking, and failures never break the memory update.

This makes your memory portable across AI tools beyond MCP — sync to Google Docs and attach it as a knowledge source in a [Gemini Gem](https://gemini.google.com/gems), or sync to Notion and reference it from a [ChatGPT custom GPT](https://openai.com/index/introducing-gpts/) with web browsing enabled.

PACK supports two sync methods that can be used together, separately, or not at all:

- **Webhook** — POST memory content to any URL (n8n, Zapier, Make, custom endpoint). Most flexible — add any number of targets without changing PACK code.
- **Built-in connectors** — Direct sync to Notion and Google Docs. No external infra needed.

### Webhook sync (recommended)

Set a webhook URL and PACK will POST the full memory content after every update:

```bash
# Add to ~/.pack.env
PACK_WEBHOOK_URL=https://your-n8n.example.com/webhook/pack-sync
```

The webhook receives a JSON payload:

```json
{
  "event": "memory_update",
  "content": "# My Memory\n\n- Full markdown content...",
  "message": "Update memory",
  "repo": "your-username/ai-memory-yourname",
  "sha": "abc123...",
  "commit_url": "https://github.com/...",
  "timestamp": "2026-03-02T12:00:00.000Z"
}
```

With a workflow tool like [n8n](https://n8n.io/), you can fan out to any number of targets — Notion, Google Docs, Confluence, Slack, email — without touching PACK code. Example n8n workflow:

```
Webhook trigger → Switch node
  ├─ Notion: update page with content
  ├─ Google Docs: replace document body
  ├─ Slack: post to #memory-updates channel
  └─ S3: archive a timestamped backup
```

### Notion sync (built-in)

Add to `~/.pack.env`:

```bash
NOTION_TOKEN=ntn_...
NOTION_SYNC_PAGE_ID=abcdef1234567890  # Page to overwrite with memory content
```

Create a **dedicated, private** Notion page for this — its content will be replaced on each update. Do not use a page that is shared with others unless you want them to see your memory.

### Google Docs sync (built-in)

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

- All sync methods are optional, independent, and can be combined
- Webhook and built-in connectors run in parallel after GitHub write succeeds
- Failures are logged to stderr but never affect the `memory_update` response
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
