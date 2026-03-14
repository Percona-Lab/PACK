# PACK v2 Design Document

**Status:** Final
**Author:** Dennis Kittrell
**Date:** 2026-03-13
**Repo:** Percona-Lab/pack

---

## Overview

PACK v2 migrates from a single-file memory store (`MEMORY.md`) to a directory-of-files architecture. Each memory topic becomes its own markdown file with YAML frontmatter. The system gains granular reads/writes, meaningful git history, per-file concurrency, and selective context loading -- while preserving full backward compatibility for existing v1 users.

PACK v2 also introduces a CLI (`pack`) for direct human interaction with memory outside of agent sessions. The MCP server and CLI are thin wrappers over a shared core library, ensuring identical behavior regardless of interface.

---

## Design Principles

- **Portable:** Plain markdown files in a git repo. No database, no binary formats, no vendor lock-in.
- **Version-controlled:** Every write is a git commit. Per-file diffs are meaningful and revertable.
- **Scalable:** Agents load an index, then fetch only what's relevant. Memory growth doesn't degrade session performance.
- **Backward-compatible:** Existing v1 repos work without changes. Users migrate on their own schedule.
- **Agent-agnostic:** MCP-native agents use granular tools. Knowledge-file agents (Gemini Gems, ChatGPT GPTs) consume a synced Google Doc or Notion page built from the same source.

---

## Architecture

### Shared Core Pattern

All business logic lives in a shared core module. The MCP server and CLI are thin interface layers that call into it. This ensures identical behavior regardless of how PACK is accessed.

```
┌──────────────┐     ┌──────────────┐
│   pack CLI   │     │  MCP Server  │
│  (bin/pack)  │     │ (servers/    │
│              │     │  memory.js)  │
└──────┬───────┘     └──────┬───────┘
       │                    │
       └────────┬───────────┘
                │
       ┌────────▼────────┐
       │   Shared Core   │
       │  (core/memory.js)│
       │                 │
       │  list()         │
       │  get()          │
       │  update()       │
       │  search()       │
       │  migrate()      │
       │  sync()         │
       │  validate()     │
       │  init()         │
       │  status()       │
       └────────┬────────┘
                │
       ┌────────▼────────┐
       │   Connector     │
       │  (connectors/   │
       │   github.js)    │
       └────────┬────────┘
                │
       ┌────────▼────────┐
       │  GitHub API /   │
       │  Local Git      │
       └─────────────────┘
```

### Module Responsibilities

**`core/memory.js` (shared core):**
All read/write/search/sync logic. Accepts a connector instance. Returns plain objects. No knowledge of MCP protocols or CLI formatting.

**`servers/memory.js` (MCP interface):**
Registers MCP tools. Translates MCP tool calls into core function calls. Formats core responses for MCP output. Handles transport (stdio, HTTP, SSE) via `shared.js`.

**`bin/pack` (CLI interface):**
Parses arguments. Calls core functions. Formats output for terminal (tables, color, exit codes). No business logic.

**`connectors/github.js` (storage backend):**
GitHub Contents API and Trees API operations. Injected into the core at startup. Could be swapped for a local git connector in the future without changing core or interfaces.

### File Layout (v2)

```
pack/
├── bin/
│   └── pack                    # CLI entry point (#!/usr/bin/env node)
├── core/
│   ├── memory.js               # Shared business logic
│   ├── index-builder.js        # index.md generation
│   ├── frontmatter.js          # YAML frontmatter parse/serialize
│   └── schema.js               # Frontmatter validation
├── servers/
│   ├── memory.js               # MCP server (wraps core)
│   └── shared.js               # Transport abstraction (unchanged)
├── connectors/
│   ├── github.js               # GitHub API backend (expanded)
│   ├── memory-sync.js          # Sync orchestrator (updated)
│   ├── notion-sync.js          # Notion connector (unchanged)
│   └── google-docs.js          # Google Docs connector (unchanged)
├── scripts/
│   ├── migrate.js              # v1 --> v2 migration (calls core)
│   └── google-auth.js          # Google OAuth setup (unchanged)
├── package.json                # Adds "bin": { "pack": "./bin/pack" }
└── .pack.env                   # Config (unchanged)
```

### Why This Matters

- **One source of truth:** Bug fixes in core automatically apply to both CLI and MCP.
- **Testable:** Core functions are pure logic with injected dependencies. Unit tests don't need MCP or CLI harnesses.
- **Extensible:** Adding a REST API, VS Code extension, or Raycast plugin means writing another thin wrapper -- not duplicating logic.
- **Future connector swap:** A `connectors/local-git.js` that uses `simple-git` instead of GitHub API could be dropped in without touching core or interfaces. This is the path to the local-first + push model discussed earlier.

---

## Directory Structure

```
<memory-repo>/
├── index.md                    # Manifest + sync ordering
├── context/
│   ├── work.md                 # Role, company, responsibilities
│   ├── personal.md             # Personal context, preferences
│   └── tooling.md              # Agent config, MCP setup, conventions
├── projects/
│   ├── binlog-server.md        # Per-project memory
│   ├── vector-capabilities.md
│   └── mynah.md
├── profiles/
│   ├── mynah-slack.md          # Communication style profiles
│   ├── mynah-email.md
│   └── notion-design.md        # Design/formatting profiles
├── contacts/
│   └── strategic-accounts.md
└── legacy/
    └── MEMORY.md               # v1 snapshot (migration rollback)
```

### Directory Taxonomy

| Directory    | Purpose                                    | Example files                     |
|--------------|--------------------------------------------|-----------------------------------|
| `context/`   | Stable background: role, prefs, tooling    | `work.md`, `personal.md`          |
| `projects/`  | Active and archived project memory         | `binlog-server.md`, `mynah.md`    |
| `profiles/`  | Style/format profiles (MYNAH, Notion, etc) | `mynah-slack.md`, `notion-design.md` |
| `contacts/`  | People, accounts, org references           | `strategic-accounts.md`           |
| `legacy/`    | v1 snapshot, preserved for rollback        | `MEMORY.md`                       |

New directories can be added freely. The system discovers structure from `index.md`, not from hardcoded paths.

---

## File Format

Every memory file uses YAML frontmatter followed by markdown body content.

```yaml
---
topic: binlog-server
tags: [mysql, mvp, q3-2026]
created: 2026-03-13
updated: 2026-03-13
sync: true
ttl: null
---

## MySQL Binlog Server

- Targets enterprise point-in-time recovery
- First release: Q3 2026
- Key validation accounts: Nokia, Akamai, Bloomberg
```

### Frontmatter Fields

| Field     | Type       | Required | Description                                          |
|-----------|------------|----------|------------------------------------------------------|
| `topic`   | string     | yes      | Machine-readable topic identifier                    |
| `tags`    | string[]   | no       | Filterable tags for `memory_list` queries             |
| `created` | date       | yes      | File creation date (ISO 8601)                        |
| `updated` | date       | yes      | Last modification date (auto-set on write)           |
| `sync`    | boolean    | no       | Include in sync output (default: true)               |
| `ttl`     | string/null| no       | Advisory expiry hint (e.g., "90d", "2026-06-30", null = never). Never auto-deletes; flagged by `pack validate`, shown as `[expired]` in `pack list`. Future `pack prune` command for interactive cleanup. |

---

## Index File Schema

`index.md` is auto-generated on every write. It serves three purposes:

1. **Agent discovery:** Agents read this first to decide which files to load.
2. **Sync ordering:** Controls the concatenation order for Google Docs/Notion sync output.
3. **Human overview:** Readable summary of everything in memory.

### Format

```yaml
---
version: 2
file_count: 9
last_updated: 2026-03-13T14:30:00Z
sync_order:
  - context/work.md
  - context/personal.md
  - context/tooling.md
  - projects/binlog-server.md
  - projects/vector-capabilities.md
  - projects/mynah.md
  - profiles/mynah-slack.md
  - profiles/mynah-email.md
  - profiles/notion-design.md
  - contacts/strategic-accounts.md
---

# Memory Index

## context/

| File          | Topic     | Tags                | Updated    |
|---------------|-----------|---------------------|------------|
| work.md       | work      | role, percona       | 2026-03-13 |
| personal.md   | personal  | preferences         | 2026-03-10 |
| tooling.md    | tooling   | mcp, agents         | 2026-03-12 |

## projects/

| File                      | Topic               | Tags                    | Updated    |
|---------------------------|----------------------|-------------------------|------------|
| binlog-server.md          | binlog-server        | mysql, mvp, q3-2026     | 2026-03-13 |
| vector-capabilities.md    | vector-capabilities  | mysql, mvp, q3-2026     | 2026-03-11 |
| mynah.md                  | mynah                | ai-tools, alpine        | 2026-03-12 |

## profiles/

| File              | Topic         | Tags                | Updated    |
|-------------------|---------------|---------------------|------------|
| mynah-slack.md    | mynah-slack   | communication       | 2026-03-08 |
| mynah-email.md    | mynah-email   | communication       | 2026-03-08 |
| notion-design.md  | notion-design | formatting          | 2026-03-05 |

## contacts/

| File                    | Topic              | Tags            | Updated    |
|-------------------------|--------------------|-----------------|------------|
| strategic-accounts.md   | strategic-accounts | customers       | 2026-03-13 |
```

### Sync Order Rules

- `sync_order` defines the exact sequence for concatenating files into a single document for sync targets (Google Docs, Notion).
- Files with `sync: false` in their frontmatter are excluded from sync output regardless of their position in `sync_order`.
- Files not listed in `sync_order` are appended alphabetically at the end.
- Sync output inserts `---` dividers and `# Section` headers between files.

---

## MCP Tool Contract

### v2 Tools (4 tools)

#### `memory_list`

Returns the index with optional filtering. This is the entry point for every session.

```
Input:
  tag:    string (optional) -- filter by tag
  topic:  string (optional) -- filter by topic
  dir:    string (optional) -- filter by directory (e.g., "projects/")

Output:
  content: string -- filtered index.md content (frontmatter tables)
```

**Agent usage:** Call at session start. Scan the result, then call `memory_get` for relevant files only.

#### `memory_get`

Reads one memory file by path.

```
Input:
  path: string (required) -- relative path, e.g., "projects/binlog-server.md"

Output:
  content:     string -- full file content (frontmatter + body)
  sha:         string -- git SHA for optimistic concurrency
  updated_at:  string -- last commit timestamp
```

#### `memory_update`

Writes one memory file. Auto-updates `index.md` after write.

```
Input:
  path:        string (required) -- relative path
  content:     string (required) -- full file content (frontmatter + body)
  sha:         string (optional) -- SHA for optimistic concurrency (required for existing files, omit for new files)
  message:     string (optional) -- git commit message (default: "Update {path}")

Output:
  sha:         string -- new SHA after write
  index_updated: boolean -- confirms index was regenerated
```

**Behavior:**

- If `path` doesn't exist and `sha` is omitted, creates a new file.
- If `path` exists and `sha` doesn't match, returns a conflict error.
- After writing the file, regenerates `index.md` from the current directory state.
- Commit message includes the file path for meaningful git history.

#### `memory_search`

Searches across all memory files by content or frontmatter.

```
Input:
  query: string (required) -- search term (matched against file content and frontmatter)

Output:
  results: array of:
    path:    string -- file path
    topic:   string -- from frontmatter
    tags:    string[] -- from frontmatter
    snippet: string -- matching line(s) with context
```

**Implementation:** Server-side substring matching across all files in the repo. No regex in v2.0 (core `search()` accepts a `mode` parameter for future regex support). No embedding/vector search -- keep it simple and portable.

---

### v1 Compatibility Shim

When running in v1-detected mode (single `MEMORY.md` file), PACK exposes only the original 2 tools:

- `memory_get` -- reads `MEMORY.md`
- `memory_update` -- writes `MEMORY.md` with SHA-based concurrency

When running in v2 mode, the shim handles v1-style calls gracefully:

- `memory_get` with no `path` argument -- concatenates all files in sync order and returns as a single string (mimics v1 behavior)
- `memory_update` with no `path` argument -- **routes to `context/general.md`** with a deprecation warning in the response: *"Warning: pathless memory_update is deprecated. Your content was saved to context/general.md. Update your system prompt to use path-based updates."* This prevents hard failures for agents still using v1 prompts while nudging toward migration.

---

## Backward Compatibility Guarantees

### Mode Detection

Mode is detected **per-request**, not at startup. The server checks repo state on each tool call to handle mid-session migration scenarios (e.g., `pack migrate` runs while an agent session is active).

```
1. Check for index.md at repo root
2. If index.md exists --> v2 mode for this request
3. Else if GITHUB_MEMORY_PATH points to a .md file --> v1 mode
4. Else --> error: "No memory store found"
```

### Transition Period Checklist

After running `pack migrate`, update system prompts in ALL clients:

| Client | Where to update |
|--------|-----------------|
| Claude Desktop | Project custom instructions |
| Open WebUI | Settings > General > System Prompt |
| Cursor | Rules or system prompt settings |
| Windsurf | Rules or system prompt settings |
| Gemini Gem | Knowledge source (auto-updated via Google Docs sync) |
| ChatGPT GPT | Web browsing target (auto-updated via Notion sync) |

**During transition:** Both v1 and v2 system prompts are documented in README.md. Clients using v1 prompts will continue to work against v2 repos via the compat shim (reads return concatenated view, writes route to `context/general.md` with deprecation warning).

### Webhook Payload (v2)

v2 webhook payloads include the file path and maintain backward compatibility:

```json
{
  "event": "memory_update",
  "path": "projects/binlog-server.md",
  "content": "--- frontmatter + body ---",
  "message": "Update projects/binlog-server.md",
  "repo": "owner/ai-memory",
  "sha": "abc123",
  "commit_url": "https://github.com/...",
  "timestamp": "2026-03-13T14:30:00Z",
  "version": 2
}
```

Changes from v1:
- Added `path` field (new)
- Added `version` field (new, value: `2`)
- `content` contains single file content, not full memory (changed)

Webhook consumers can check `version` to handle both formats. Absence of `version` field implies v1.

### Sync Output Format Change

After migration, sync targets (Notion, Google Docs) receive concatenated files with section headers instead of raw `MEMORY.md`:

```markdown
# Work Context
[contents of context/work.md, frontmatter stripped]

---

# Binlog Server
[contents of projects/binlog-server.md, frontmatter stripped]

---
...
```

This is a format change, not a breaking change. Gemini Gems and ChatGPT GPTs consuming the synced doc will see better-organized content with clear section boundaries.

---

## CLI Interface

The `pack` CLI provides direct human access to memory without requiring an agent session. Installed globally via `npm install -g` or linked locally via `npm link`.

### Commands

#### `pack list`

List memory files with optional filtering. Files past their TTL are marked `[expired]`.

```bash
pack list                          # show full index
pack list --tag mysql              # filter by tag
pack list --dir projects/          # filter by directory
pack list --format json            # machine-readable output
pack list --local                  # read from local clone, skip GitHub API
```

#### `pack get <path>`

Read a single memory file to stdout.

```bash
pack get projects/binlog-server.md
pack get projects/binlog-server.md --no-frontmatter   # body only
pack get projects/binlog-server.md --json              # structured output
```

#### `pack update <path>`

Write a memory file. Reads from stdin or a local file.

```bash
pack update projects/binlog-server.md --file ./edits.md
pack update projects/binlog-server.md --message "Add Q3 milestones"
echo "new content" | pack update projects/binlog-server.md
```

Follows the same SHA-based concurrency as MCP: fetches current SHA before write, fails on conflict.

#### `pack search <query>`

Search across all memory files.

```bash
pack search "q3 2026"
pack search "nokia" --format json
```

#### `pack init`

Bootstrap a new v2 memory repo. Creates the private GitHub repo via API if it doesn't exist.

```bash
pack init                          # creates repo + directory structure + index.md
pack init --repo my-memory         # specify repo name (default: ai-memory)
pack init --local-only             # scaffold locally, skip GitHub repo creation
```

Generates:

```
context/
projects/
profiles/
contacts/
index.md
```

If the repo already exists, `pack init` detects it and skips creation (no error). If the repo exists and contains a `MEMORY.md`, suggests `pack migrate` instead.

#### `pack migrate`

Migrate a v1 repo to v2 structure.

```bash
pack migrate                       # interactive: shows plan, asks for confirmation
pack migrate --dry-run             # show what would happen, write nothing
pack migrate --yes                 # skip confirmation
```

#### `pack sync`

Manually trigger sync to configured targets.

```bash
pack sync                          # sync to all configured targets
pack sync --target notion          # sync to Notion only
pack sync --target google-docs     # sync to Google Docs only
pack sync --dry-run                # show what would be pushed
```

#### `pack status`

Show current memory state.

```bash
pack status
```

Output:

```
PACK v2 | 9 files | Last updated: 2026-03-13T14:30:00Z
Mode:       v2 (directory)
Repo:       github.com/user/ai-memory
Sync:       Notion (enabled), Google Docs (disabled)
Files:      3 context, 3 projects, 3 profiles, 1 contacts
Index:      valid
```

#### `pack validate`

Check index integrity, frontmatter schema compliance, and TTL expiry.

```bash
pack validate
```

Output:

```
Checking index.md... OK
Checking index drift... WARN: projects/new-file.md not in index (run pack reindex)
Checking frontmatter schema...
  context/work.md           OK
  projects/mynah.md         WARN: missing tags
  profiles/mynah-slack.md   OK
Checking TTL expiry...
  projects/old-poc.md       EXPIRED (ttl: 90d, last updated 120 days ago)
9 files checked, 0 errors, 3 warnings
```

### CLI Design Principles

- **No business logic in the CLI layer.** Every command calls a core function and formats the result.
- **Exit codes:** 0 = success, 1 = error, 2 = conflict (SHA mismatch). Scripts and CI can rely on these.
- **Piping:** `pack get` writes to stdout cleanly (no chrome). `pack update` reads from stdin. Standard Unix composability.
- **`--format json`:** Available on all read commands for scripting and chaining with `jq`.
- **`--dry-run`:** Available on all write commands. No surprises.
- **`--local`:** Available on all commands. Reads/writes a local clone directly instead of calling the GitHub API. Uses `simple-git` for commit and push. Faster and works offline (push deferred until connectivity).

---

## Auto-Detect Logic

On each request, PACK determines the operating mode:

```
1. Read repo contents at root level
2. If index.md exists at root --> v2 mode (directory structure)
3. Else if GITHUB_MEMORY_PATH points to a .md file --> v1 mode (legacy)
4. Else --> error: "No memory store found"
```

Mode is detected **per-request** to handle mid-session migration. Result is cached for 60 seconds to avoid redundant API calls, with cache invalidated on any write operation.

---

## Connector Changes (connectors/github.js)

The connector is injected into the shared core at startup. This decoupling enables a future `local-git.js` connector that uses `simple-git` for local-first workflows (write to local repo, commit, push) without changing core or interface layers.

### Current (v1)

```javascript
getContents(path)       // reads MEMORY.md
putContents(path, content, sha)  // writes MEMORY.md
```

### New (v2)

```javascript
getContents(path)             // reads any single file
putContents(path, content, sha, message)  // writes any single file with custom commit message
listDir(dirPath)              // lists directory contents (recursive)
deleteFile(path, sha)         // removes a file (for cleanup/reorganization)
getTree()                     // gets full repo tree (for index regeneration)
```

All methods continue to use the GitHub Contents API. SHA tracking is per-file (no global lock).

---

## Sync Layer (memory-sync.js)

### Single-Page Mode (default)

```
memory_update --> getSyncContent() --> concat all files --> push to Notion / Google Docs
```

Google Docs and Notion single mode receive one markdown string. Contract C3 applies.

### Multi-Page Mode (NOTION_SYNC_MODE=multi)

```
memory_update for context/preferences.md
  --> update sub-page for context/preferences.md (Notion)
  --> update index page with links (Notion)
  --> section-replace in Full Export page (Notion, fallback: full rewrite)
  --> push full concat to Google Docs (unchanged)
```

Multi-page Notion sync creates one sub-page per PACK file under the parent page (`NOTION_SYNC_PAGE_ID`). The parent page becomes an index with links. A "PACK Full Export (read-only)" page holds all memory concatenated for tools that need a single page.

**Mapping**: `.notion-pages.json` in the GitHub repo maps PACK file paths to Notion page IDs. This file is version-controlled and auto-updated when new files are created.

**Migration**: `pack migrate-notion` creates all sub-pages and the full export page. Idempotent -- skips files that already have pages. Required before multi mode works; PACK falls back to single mode if the mapping doesn't exist.

**Per-file sync flow**:
1. `memory_update` completes for a specific file
2. Sync manager reads `.notion-pages.json` from GitHub
3. Updates or creates the file's sub-page
4. Rebuilds index page with links to all sub-pages
5. Attempts section replacement in the full export page; falls back to full rewrite on failure

### Sync Output Format

Files are concatenated with section headers and dividers:

```markdown
# Work Context
[contents of context/work.md, frontmatter stripped]

---

# Binlog Server
[contents of projects/binlog-server.md, frontmatter stripped]

---
...
```

Frontmatter is stripped from sync output to keep it clean for non-technical consumers (Gemini Gems, human readers).

### Webhook Versioning

The webhook payload format is controlled by `PACK_WEBHOOK_VERSION`:

- **Unset** (default): Per-file content with `version: 2`, `file`, and `path` fields.
- **`1`**: Full concatenated content. No `version`, `file`, or `path` fields. For legacy workflows that expect the whole memory blob.

---

## Migration

PACK v2 includes a `pack migrate` command (see CLI Interface above) that automates the split from v1 to v2. The underlying logic lives in `core/memory.js` and is shared between CLI and any future programmatic callers.

### Usage

```bash
pack migrate --dry-run     # preview first
pack migrate               # interactive migration
```

### Behavior

1. Reads `MEMORY.md` from the configured repo
2. Parses by `##` headings
3. Generates files with auto-populated frontmatter (topic from heading, tags inferred, dates from current timestamp)
4. Places files in a default taxonomy:
   - Headings containing "profile", "MYNAH", "style" --> `profiles/`
   - Headings containing "project", product names --> `projects/`
   - Headings containing "contact", "account" --> `contacts/`
   - Everything else --> `context/`
5. Generates `index.md` with default sync ordering
6. Copies original `MEMORY.md` to `legacy/MEMORY.md`
7. Writes all files to the repo in a single commit: "Migrate to PACK v2 directory structure"
8. Outputs a summary of files created and their paths for human review

### Post-Migration Review

The migration script outputs a checklist:

```
Migration complete. Review the following:
[ ] Check taxonomy: are files in the right directories?
[ ] Check tags: do they make sense for your filtering needs?
[ ] Update sync_order in index.md if needed
[ ] Update agent prompts to use v2 tool names (see README for both v1 and v2 prompts)
[ ] Test: node servers/memory.js --> call memory_list
```

---

## Agent Prompt Changes

### v1 Prompt (current -- still supported via compat shim)

```
You have access to persistent memory via pack (memory_get / memory_update).
- Use memory_get when you need context from previous sessions, or the user asks "what do you know"
- Use memory_update when the user says "remember this", "save this", or asks you to store any information — this is the user's personal memory and they decide what goes in it
- CRITICAL: Before EVERY memory_update, you MUST call memory_get first. The memory file may contain important content from other sessions. Read it, merge your changes into the existing content, then write the complete updated markdown. Never overwrite blindly.
- Keep memory organized with ## headings and bullet points
At the start of every conversation:
- Call memory_get to load persistent memory
```

### v2 Prompt (new)

```
You have access to persistent memory via pack (memory_list / memory_get / memory_update / memory_search).
- Call memory_list at the start of every conversation to load the memory index
- Call memory_get with a file path to read specific context
- Call memory_update with a file path and content to save information — this is the user's personal memory and they decide what goes in it
- Call memory_search with keywords to find information across all memory files
- Each file is independent — no need to merge with other files when updating
```

Key improvement: the "read everything, merge, write everything" pattern is eliminated. Updates are scoped to one file. No more accidental overwrites.

---

## Risk Register

| Risk                                | Mitigation                                              |
|-------------------------------------|---------------------------------------------------------|
| Migration script mis-categorizes    | Human review step; `--dry-run` flag; files can be moved after migration |
| Existing users break on update      | Auto-detect preserves v1 behavior; no forced migration  |
| Agent calls memory_get without path | Compat shim returns concatenated view                   |
| Agent calls memory_update without path | Shim routes to `context/general.md` with deprecation warning |
| v1 prompt used against v2 repo      | Compat shim handles gracefully; both prompts documented in README |
| Index.md gets out of sync           | Regenerated on every write; `pack validate` for manual checks |
| GitHub API rate limits with many files | Batch reads via Trees API; writes are infrequent     |
| Sync output grows too large for Gemini | `sync: false` flag to exclude files; monitor size    |
| Core logic diverges between CLI and MCP | Both are thin wrappers; no business logic in either   |
| CLI installed globally conflicts    | Scoped npm package name; `npx` as alternative           |
| Connector swap breaks behavior      | Core depends on connector interface, not implementation; integration tests cover both |
| Webhook consumers break on v2 payload | `version` field added; absence implies v1; document migration |
| Concurrent session during migration  | Per-request mode detection (not startup-only); cached 60s with write-invalidation |
| Sync output format surprises Gem/GPT consumers | Format change is additive (section headers); document in migration checklist |

---

## Implementation Phases

| Phase | What                                            | Depends On | Est. Time |
|-------|-------------------------------------------------|------------|-----------|
| 1     | This design doc                                 | --         | 45 min    |
| 2     | Shared core extraction (`core/memory.js`)       | Phase 1    | 1 hr      |
| 3     | Connector refactor (`connectors/github.js`)     | Phase 2    | 1 hr      |
| 4     | MCP server rewire (wrap core, 4 tools + shim)   | Phase 2, 3 | 1 hr      |
| 5     | CLI layer (`bin/pack`, all commands)             | Phase 2, 3 | 1 hr      |
| 6     | Migration command (`pack migrate`)              | Phase 2, 3 | 45 min    |
| 7     | Sync layer update (`memory-sync.js`)            | Phase 3    | 30 min    |
| 8     | Smoke test + prompt updates + cutover           | Phase 4-7  | 30 min    |
| 9     | Notion migration guide for other PACK users     | Phase 8    | Post-validation |

Phases 2-5 can be done in a single Claude Code session. Phase 6 runs against your actual memory repo. Total estimated hands-on time: ~6 hours including testing.

---

## Design Decisions (Resolved)

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Search matching strategy | Substring only for v2.0 | Covers 95% of use cases. Core `search()` accepts a `mode` parameter internally so regex drops in later via `--regex` CLI flag without interface changes. Agents are bad at writing regex anyway. |
| 2 | TTL enforcement model | Advisory + `pack prune` on roadmap | PACK never silently deletes data. `pack validate` flags expired files, `pack list` shows `[expired]` marker. `pack prune` added in a future release for interactive cleanup. |
| 3 | index.md storage | Committed to git + `pack validate` detects drift | Readable on GitHub, available to non-MCP consumers (Gemini Gems reading raw repo), and critical for sync layer which reads index.md to build the concat output for Google Docs/Notion. `pack validate` warns on drift; next write auto-corrects. |
| 4 | GitHub API file count limit | Document recommended max | GitHub Contents API returns up to 1000 items per directory. Trees API handles more but degrades. Document a recommended ceiling in README. |
| 5 | CLI `--local` flag | Yes, implement in v2.0 | Operates directly on a local clone using `simple-git`. Precursor to the `local-git.js` connector. Enables fast offline workflows and the local-first + push model. |
| 6 | npm package scope | Deferred | Decide before first publish. Candidates: `@percona-lab/pack`, `pack-memory`, `pack-agent-memory`. |
| 7 | `pack init` repo creation | Yes, create via GitHub API | `pack init` creates the private GitHub repo, scaffolds directory structure, and pushes initial commit. Lowers onboarding friction for new users. Falls back gracefully if repo already exists. |
| 8 | v1 pathless memory_update in v2 mode | Route to `context/general.md` with deprecation warning | Soft degradation instead of hard rejection. Prevents write failures for agents using v1 prompts against v2 repos. |
| 9 | Mode detection timing | Per-request with 60s cache | Handles mid-session migration. Cache invalidated on writes. Avoids redundant API calls while staying responsive to repo changes. |
| 10 | Notion multi-page mapping storage | `.notion-pages.json` in GitHub repo | Version-controlled, accessible from any PACK instance, excluded from memory index (dotfile). Alternative was Notion page properties but that adds API complexity. |
| 11 | Notion multi-page migration | Explicit `pack migrate-notion` command | No auto-migration during sync. Migration is previewable with `--dry-run`, idempotent, and resumes from partial failures. |
| 12 | Webhook versioning | Keep current per-file format as default | No breaking change. `PACK_WEBHOOK_VERSION=1` opts into full concatenated content for legacy consumers. |

---

## Future Roadmap (Post-v2.0)

| Feature | Description | Depends On |
|---------|-------------|------------|
| `pack prune` | Interactive deletion of expired (TTL) files | Advisory TTL flagging in v2.0 |
| `--regex` search | Regex matching for `memory_search` and `pack search` | Core `mode` parameter (already designed) |
| `local-git.js` connector | Full local-first connector using `simple-git` | `--local` flag in v2.0 |
| Embedding search | Semantic search across memory files | Evaluate need based on file count growth |
| Multi-repo support | Memory split across multiple repos | Evaluate need based on usage patterns |
| Notion reverse sync | `memory_pull` to pull mobile edits from Notion back to GitHub | Multi-page Notion sync (implemented) |
