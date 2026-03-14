# PACK — Portable Agent Context Keeper

A standalone [MCP](https://modelcontextprotocol.io/) server that gives any AI tool persistent memory — stored as markdown files in a private GitHub repo.

Works with Claude Desktop, Open WebUI, Cursor, Windsurf, and any MCP-compatible client.

> 100% vibe coded with [Claude](https://claude.ai/).

## What it does

PACK exposes four tools over MCP:

- **`memory_list`** — List memory files with optional filtering. Call at session start.
- **`memory_get`** — Read a specific memory file (or all memory concatenated).
- **`memory_update`** — Write a memory file. Each update is a git commit with full version history.
- **`memory_search`** — Search across all memory files by content or frontmatter.

Memory is stored as markdown files with YAML frontmatter in a GitHub repo you control. Updates use SHA-based optimistic concurrency to prevent race conditions. Optional 1-way sync pushes memory to Google Docs and/or Notion for browser access.

PACK also ships a CLI (`pack`) for direct human access to memory outside of agent sessions.

## Why directory mode

PACK stores memory as a directory of small files instead of one large file. This matters for four reasons:

**Faster load times.** Loading a ~700 token index is meaningfully faster than loading ~8,000+ tokens from a monolithic file. The MCP round-trip to GitHub is the bottleneck, not context window capacity. Single-file mode also required re-reading the full file before every write to merge changes, adding slow round-trips throughout the session. Directory mode loads the index once and writes directly.

**Write safety.** In single-file mode, every update required a full `memory_get` first so the model could merge new content into existing content. That added latency and created merge-corruption risk where the model accidentally dropped sections. Directory mode writes to a specific file with no merge step.

**Structured retrieval.** YAML frontmatter on each file enables `memory_search` to find files by metadata (tags, topics), not just content matching. You can scope what gets loaded by relevance instead of loading everything and hoping the model finds the right detail.

**Token efficiency.** For a typical session with one memory update, directory mode reduces memory-related token usage by ~94% (from ~17,000 tokens to ~1,000 vs single-file mode). The savings compound as memory grows – cost stays flat regardless of total memory size.

## Setup

### 1. Create a memory repo

Create a **private** GitHub repo to store your memory. You can create it under your personal account or a GitHub organization — wherever you prefer.

```bash
# Personal account
gh repo create PACK-yourname --private --clone=false

# Or under an organization
gh repo create your-org/PACK-yourname --private --clone=false
```

Replace `yourname` with your name (e.g. `PACK-dennis`, `PACK-sarah`).

> **Privacy notice**: Your memory will accumulate sensitive context over time — meeting notes, project details, personal preferences, etc. To protect your data:
>
> 1. **Always create the repo as Private** — never public or internal.
> 2. **If using a GitHub org**, request that an admin restrict the repo to your account only — by default, org owners and admins can see all repos, even private ones.
> 3. **Do not store secrets** (passwords, API tokens, credentials) in your memory. Treat it as sensitive but not secret.

Generate a [fine-grained personal access token](https://github.com/settings/tokens?type=beta) with:
- **Repository access**: Only select your `PACK-yourname` repo
- **Permissions**: Contents → Read and write

### 2. Install PACK

```bash
git clone https://github.com/Percona-Lab/PACK.git
cd PACK
npm install
npm link    # optional: installs 'pack' CLI globally
```

### 3. Configure

Create `~/.pack.env` (outside the repo for security):

```bash
GITHUB_TOKEN=ghp_...              # Fine-grained PAT
GITHUB_OWNER=your-username        # GitHub user or org that owns the memory repo
GITHUB_REPO=PACK-yourname          # Your private memory repo
```

### 4. Initialize

Bootstrap the directory structure in your memory repo:

```bash
pack init
```

This creates `index.md` and `context/general.md` in your repo.

### 5. Run

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

## System prompt (critical)

> **Warning**: Without this system prompt, models won't use PACK's tools correctly. Always add this to your AI client.
>
> - **Open WebUI**: Settings > General > System Prompt
> - **Claude Desktop**: Add to your project's custom instructions (this is where system prompts go in Claude Desktop)
> - **Cursor / Windsurf**: Add to your rules or system prompt settings

```
CRITICAL — MANDATORY FIRST STEP: Before responding to ANY user message, you MUST call pack:memory_list first, then call pack:memory_get on context/preferences.md. Do NOT skip this. Do NOT respond until you have loaded preferences.

You have access to persistent memory via PACK (pack:memory_list / pack:memory_get / pack:memory_update / pack:memory_search).
- Call pack:memory_get with a file path to read specific context
- Call pack:memory_update with a file path and content to save information — this is the user's personal memory and they decide what goes in it
- Call pack:memory_search with keywords to find information across all memory files
- Each file is independent — no need to merge with other files when updating
When drafting any communication on my behalf, use pack:memory_search to find MYNAH profile files. If present, match my writing style for the relevant context.
When creating or formatting Notion pages, use pack:memory_search to find NOTION Design Profile files. If present, apply my stored design preferences.
```

> **Note:** Replace `my`/`my behalf` with `the user's` if configuring for a shared setup. The `pack:` prefix matches the MCP server name in your client config.

### Train once, use everywhere

PACK stores profiles for two companion plugins. Train them once in Claude Code or Cowork (where plugins are supported), and every AI client connected to PACK can use the results, even clients that don't support plugins.

**[MYNAH](https://github.com/Percona-Lab/MYNAH)** (My Natural Authoring Helper) learns how you write and stores style profiles in PACK memory. **[BINER](https://github.com/Percona-Lab/BINER)** (Beautiful Intelligent Notion Enhancement & Reformatting) learns your Notion design preferences and stores them in PACK memory.

**In Cowork and Claude Code**, install the plugins and everything works automatically. The plugins handle training, storage, and composition with no system prompt changes needed.

**In Claude Desktop, Cursor, Open WebUI, and other MCP clients**, plugins aren't available, but PACK is. The system prompt above includes MYNAH/BINER lines so the AI knows to use your stored profiles. You'd train or update profiles in Cowork or Claude Code, and the results carry over everywhere.

## Sync (optional)

After each `memory_update`, content can be automatically synced to external targets. Sync is 1-way (GitHub → targets), non-blocking, and failures never break the memory update.

This makes your memory portable across AI tools beyond MCP — sync to Google Docs and attach it as a knowledge source in a [Gemini Gem](https://gemini.google.com/gems), or sync to Notion and reference it from a [ChatGPT custom GPT](https://openai.com/index/introducing-gpts/) with web browsing enabled.

PACK supports two sync methods that can be used together, separately, or not at all:

- **Built-in connectors** -- Direct sync to Notion and Google Docs. No external infra needed. Notion supports multi-page sync for mobile reads.
- **Webhook** -- POST memory content to any URL (n8n, Zapier, Make, custom endpoint). Most flexible -- add any number of targets without changing PACK code.

### Choosing a sync method

- **Want mobile read access?** Enable the built-in Notion connector with `NOTION_SYNC_MODE=multi`. This is the only way to get structured mobile reads.
- **Want to fan out to multiple targets (Slack, S3, Confluence, etc.)?** Use webhook sync.
- **Want both?** Use them together. The built-in connector handles Notion structure for mobile reads. The webhook handles everything else. When using both, your webhook workflow should skip Notion (PACK handles it directly) to avoid conflicts.

### Notion sync (built-in)

Add to `~/.pack.env`:

```bash
NOTION_TOKEN=ntn_...
NOTION_SYNC_PAGE_ID=abcdef1234567890  # Parent page for memory sync
NOTION_SYNC_MODE=single               # single (default) or multi
```

Create a **dedicated, private** Notion page for this. Do not use a page that is shared with others unless you want them to see your memory.

**Single mode** (default): Replaces the page content with all memory concatenated on each update. Simple, no setup beyond the env vars above.

**Multi mode**: Creates one Notion sub-page per PACK file under the parent page. The parent page becomes an index with links to each sub-page. A "PACK Full Export (read-only)" page is also created for tools that need all memory in one page. On each `memory_update`, only the changed file's sub-page is updated -- not all pages.

To enable multi mode:

```bash
pack migrate-notion --dry-run    # preview what pages will be created
pack migrate-notion              # create sub-pages in Notion
```

Then set `NOTION_SYNC_MODE=multi` in `~/.pack.env` and restart your MCP server.

### Google Docs sync (built-in)

**Step 1:** Create OAuth credentials at [Google Cloud Console](https://console.cloud.google.com/) -- enable Google Docs API -- create OAuth client ID (Desktop app).

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

> **Privacy reminder**: Keep the Google Doc restricted to your account only. Do not share the document link -- anyone with access can read your full memory.

Google Docs always receives the full concatenated memory as plain markdown, regardless of Notion sync mode.

### Webhook sync

Set a webhook URL and PACK will POST memory content after every update:

```bash
# Add to ~/.pack.env
PACK_WEBHOOK_URL=https://your-n8n.example.com/webhook/pack-sync
```

The webhook receives a JSON payload with the updated file:

```json
{
  "event": "memory_update",
  "version": 2,
  "file": "context/preferences.md",
  "path": "context/preferences.md",
  "content": "--- frontmatter + body ---",
  "message": "Update context/preferences.md",
  "repo": "your-username/PACK-yourname",
  "sha": "abc123...",
  "commit_url": "https://github.com/...",
  "timestamp": "2026-03-14T12:00:00.000Z"
}
```

To receive the full concatenated memory instead of per-file content (for legacy workflows or full-text indexing), set `PACK_WEBHOOK_VERSION=1` in `~/.pack.env`.

With a workflow tool like [n8n](https://n8n.io/), you can fan out to any number of targets -- Google Docs, Confluence, Slack, email -- without touching PACK code. Example n8n workflow:

```
Webhook trigger → Switch node
  ├─ Google Docs: replace document body
  ├─ Slack: post to #memory-updates channel
  └─ S3: archive a timestamped backup
```

### Sync behavior

- All sync methods are optional, independent, and can be combined
- Webhook and built-in connectors run in parallel after GitHub write succeeds
- Failures are logged to stderr but never affect the `memory_update` response
- Google Docs receives plain markdown text
- Notion single mode: replaces one page with structured blocks
- Notion multi mode: updates only the changed file's sub-page, refreshes index

## Mobile reads

Multi-page Notion sync enables mobile AI clients (Claude.ai, ChatGPT, Gemini) to read your PACK memory through Notion, even without MCP access.

**How it works.** When `NOTION_SYNC_MODE=multi`, PACK mirrors each memory file as a Notion sub-page. The parent page serves as an index (~700 tokens). A mobile AI client can fetch just the index and then pull specific sub-pages by relevance -- the same pattern desktop PACK uses with `memory_list` followed by `memory_get`.

**Read-only.** Mobile access through Notion is read-only. Memory writes require a desktop PACK session with MCP. The system prompt below handles this gracefully -- if PACK tools are unavailable, it falls back to reading from Notion.

**Three-tier read strategy.** The mobile system prompt tries each level in order:

1. **PACK tools** (desktop) -- fastest, uses `memory_list` and `memory_get` directly
2. **Notion sub-pages** (mobile) -- reads the index page, then specific sub-pages as needed. Falls back to the "PACK Full Export (read-only)" page if a sub-page fetch fails.
3. **Native memory** (last resort) -- only if both PACK and Notion are unavailable. States clearly that context may be incomplete.

### Mobile system prompt (optional)

Use this prompt instead of the default when you have Notion sync enabled with `NOTION_SYNC_MODE=multi`:

```
CRITICAL -- MANDATORY FIRST STEP: Before responding to ANY user message, you MUST attempt memory access in this exact order. Do NOT respond until you have tried.

1. PACK (desktop): Call pack:memory_list first, then pack:memory_get on context/preferences.md.
2. Notion fallback (mobile or PACK unavailable): If PACK tools fail or are not available, fetch the PACK index from Notion page [NOTION_SYNC_PAGE_ID]. Read specific files from linked sub-pages as needed. If a sub-page fetch fails, fall back to the "PACK Full Export (read-only)" page under the same parent.
3. Native memory fallback (Notion also unavailable): ONLY if both PACK and Notion fail, fall back to the AI client's built-in memory. State clearly at the start of your response: "Working from native memory only -- context may be incomplete."

Do NOT skip to native memory out of convenience. Do NOT respond before attempting steps 1 and 2. Try each level in order and move to the next ONLY on failure.

You have access to persistent memory via PACK (pack:memory_list / pack:memory_get / pack:memory_update / pack:memory_search).
- Call pack:memory_get with a file path to read specific context
- Call pack:memory_update with a file path and content to save information -- this is the user's personal memory and they decide what goes in it
- Call pack:memory_search with keywords to find information across all memory files
- Each file is independent -- no need to merge with other files when updating
When drafting any communication on my behalf, use pack:memory_search to find MYNAH profile files. If present, match my writing style for the relevant context.
When creating or formatting Notion pages, use pack:memory_search to find NOTION Design Profile files. If present, apply my stored design preferences.
```

> **Note:** Replace `[NOTION_SYNC_PAGE_ID]` with your actual Notion page URL so the AI client can fetch it.

## CLI

PACK includes a CLI for direct human access to memory:

```bash
npm link                           # install globally as 'pack' command

pack init                          # bootstrap directory structure (new users)
pack status                        # show current memory state
pack list                          # list all memory files
pack list --tag mysql              # filter by tag
pack get projects/binlog-server.md # read a specific file
pack search "q3 2026"              # search across all files
pack sync                          # manually trigger sync
pack migrate-notion --dry-run      # preview Notion multi-page migration
pack migrate-notion                # create Notion sub-pages
pack validate                      # check index + frontmatter integrity
```

## Project structure

```
├── bin/
│   └── pack               # CLI entry point
├── core/
│   ├── memory.js           # Shared business logic
│   ├── index-builder.js    # index.md generation
│   ├── frontmatter.js      # YAML frontmatter parse/serialize
│   └── schema.js           # Frontmatter validation
├── servers/
│   ├── memory.js           # MCP server (wraps core)
│   └── shared.js           # Transport abstraction (stdio, HTTP, SSE)
├── connectors/
│   ├── github.js           # GitHub API backend
│   ├── memory-sync.js      # Sync orchestrator
│   ├── notion-sync.js      # Notion write connector (for sync)
│   └── google-docs.js      # Google Docs write connector (for sync)
├── scripts/
│   ├── accuracy-test.js    # Pre/post migration verification
│   └── google-auth.js      # One-time Google OAuth2 setup
├── CONTRACTS.md            # Non-negotiable project invariants
├── DESIGN.md               # Architecture and design decisions
└── package.json
```

## License

MIT
