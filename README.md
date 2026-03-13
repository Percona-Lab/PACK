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

> **Upgrading from v1?** PACK v2 is fully backward compatible. Your existing single-file memory works without changes. Migrate when ready with `pack migrate`. See [DESIGN.md](DESIGN.md) for details.

## Setup

### 1. Create a memory repo

Create a **private** GitHub repo to store your memory. You can create it under your personal account or a GitHub organization — wherever you prefer.

```bash
# Personal account
gh repo create ai-memory-yourname --private --clone=false

# Or under an organization
gh repo create your-org/ai-memory-yourname --private --clone=false
```

Replace `yourname` with your name (e.g. `ai-memory-dennis`, `ai-memory-sarah`).

> **Privacy notice**: Your memory will accumulate sensitive context over time — meeting notes, project details, personal preferences, etc. To protect your data:
>
> 1. **Always create the repo as Private** — never public or internal.
> 2. **If using a GitHub org**, request that an admin restrict the repo to your account only — by default, org owners and admins can see all repos, even private ones.
> 3. **Do not store secrets** (passwords, API tokens, credentials) in your memory. Treat it as sensitive but not secret.

Generate a [fine-grained personal access token](https://github.com/settings/tokens?type=beta) with:
- **Repository access**: Only select your `ai-memory-yourname` repo
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
GITHUB_REPO=ai-memory-yourname    # Your private memory repo
```

### 4. Initialize

Bootstrap the v2 directory structure in your memory repo:

```bash
pack init
```

This creates `index.md` and `context/general.md` in your repo. You're now in v2 (directory) mode.

> **Existing v1 users**: If you already have a `MEMORY.md` file, use `pack migrate` instead of `pack init`. See [Migrating from v1](#migrating-from-v1).

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
> - **Claude Desktop**: Add to your project's custom instructions
> - **Cursor / Windsurf**: Add to your rules or system prompt settings

### v2 prompt (recommended for new users and after `pack migrate`)

```
You have access to persistent memory via pack (memory_list / memory_get / memory_update / memory_search).
- Call memory_list at the start of every conversation to load the memory index
- Call memory_get with a file path to read specific context
- Call memory_update with a file path and content to save information — this is the user's personal memory and they decide what goes in it
- Call memory_search with keywords to find information across all memory files
- Each file is independent — no need to merge with other files when updating
```

### v1 prompt (single file mode — still supported)

```
You have access to persistent memory via pack (memory_get / memory_update).
- Use memory_get when you need context from previous sessions, or the user asks "what do you know"
- Use memory_update when the user says "remember this", "save this", or asks you to store any information — this is the user's personal memory and they decide what goes in it
- CRITICAL: Before EVERY memory_update, you MUST call memory_get first. The memory file may contain important content from other sessions. Read it, merge your changes into the existing content, then write the complete updated markdown. Never overwrite blindly.
- Keep memory organized with ## headings and bullet points
At the start of every conversation:
- Call memory_get to load persistent memory
```

### Train once, use everywhere

PACK stores profiles for two companion plugins. Train them once in Claude Code or Cowork (where plugins are supported), and every AI client connected to PACK can use the results, even clients that don't support plugins.

**[MYNAH](https://github.com/Percona-Lab/MYNAH)** (My Natural Authoring Helper) learns how you write and stores style profiles in PACK memory under `## MYNAH Profiles`. **[BINER](https://github.com/Percona-Lab/BINER)** (Beautiful Intelligent Notion Enhancement & Reformatting) learns your Notion design preferences and stores them under `## NOTION Design Profiles`.

**In Cowork and Claude Code**, install the plugins and everything works automatically. The plugins handle training, storage, and composition with no system prompt changes needed.

**In Claude Desktop, Cursor, Open WebUI, and other MCP clients**, plugins aren't available, but PACK is. Add these lines to the suggested system prompt above so the AI knows to use your stored profiles:

```
When drafting any communication on the user's behalf (Slack messages, emails,
docs, etc.), call memory_get and check for a "## MYNAH Profiles" section. If
it exists, match the user's style for the relevant context (e.g., slack-dm-tech,
email-external). This ensures messages sound like the user, not like a generic AI.

When creating or reformatting Notion pages, call memory_get and check for a
"## NOTION Design Profiles" section. If present, apply the user's stored design
preferences (colors, patterns, layout density) instead of generic defaults.
```

This gives you writing style matching and Notion formatting in any MCP-compatible client. The only difference is that without the plugins, you won't have the structured LEARN mode to train or update profiles. You'd do that in Cowork or Claude Code, and the results carry over everywhere.

## Migrating from v1

If you have an existing v1 PACK (single `MEMORY.md` file), migrate to v2:

```bash
pack migrate --dry-run    # preview what will happen
pack migrate              # run the migration
pack validate             # verify everything is correct
```

Migration splits your `MEMORY.md` by `## ` headings into individual files organized by directory (`context/`, `projects/`, `profiles/`, `contacts/`). Your original file is preserved at `legacy/MEMORY.md`. Then update your system prompt to the v2 version above.

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

## CLI

PACK v2 includes a CLI for direct human access to memory:

```bash
npm link                           # install globally as 'pack' command

pack init                          # bootstrap v2 directory structure (new users)
pack status                        # show current memory state
pack list                          # list all memory files
pack list --tag mysql              # filter by tag
pack get projects/binlog-server.md # read a specific file
pack search "q3 2026"              # search across all files
pack migrate --dry-run             # preview v1 → v2 migration
pack migrate                       # run migration
pack sync                          # manually trigger sync
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
├── DESIGN.md               # v2 architecture and design decisions
└── package.json
```

## License

MIT
