# PACK Contracts

Non-negotiable invariants for the PACK project. These are the rules that every code change, refactor, and feature addition must satisfy. Violating a contract is a bug, regardless of intent.

---

## C1: No Silent Data Loss

PACK never deletes, overwrites, or corrupts user memory without explicit user action.

- `memory_update` requires SHA-based optimistic concurrency for existing files. A stale SHA must return a conflict error, never silently overwrite.
- `pack migrate` preserves the original `MEMORY.md` in `legacy/MEMORY.md`. The original is never deleted.
- `pack validate` and `pack list` flag expired TTL files but never delete them. Deletion requires explicit user action via `pack prune` (interactive).
- Sync failures (Notion, Google Docs, webhook) never block or roll back a successful GitHub write.

## C2: v1 Prompts Never Hard-Fail Against a v2 Repo

Agents using v1 system prompts must continue to function against a v2 memory repo.

- `memory_get` with no `path` returns a concatenated view of all files in sync order.
- `memory_update` with no `path` routes to `context/general.md` with a deprecation warning in the response. It must never reject, throw, or return an error.
- The v1 tool names (`memory_get`, `memory_update`) must remain registered in v2 mode alongside the new tools.

## C3: Sync Targets Receive a Single Markdown String

Downstream sync connectors (`notion-sync.js`, `google-docs.js`) always receive one markdown string as input. The sync layer is responsible for concatenation. Sync connectors never need to know about v1 vs v2, files vs directories, or frontmatter.

## C4: No Business Logic Outside the Shared Core

All read/write/search/sync logic lives in `core/memory.js`. The MCP server (`servers/memory.js`) and CLI (`bin/pack`) are thin wrappers that translate between their interface (MCP protocol, terminal args) and core function calls. If you're writing an `if` statement that decides what to do with memory content, it belongs in core.

## C5: Connector Interface Stability

The core depends on a connector interface, not a specific implementation. Any connector (GitHub API, local git, future backends) must implement:

```
getContents(path) → { content, sha, last_modified }
putContents(path, content, sha, message) → { sha, commit_url }
listDir(dirPath) → [{ name, path, type, sha }]
deleteFile(path, sha) → void
getTree() → [{ path, type, sha }]
```

Swapping connectors must not require changes to core or interface layers.

## C6: Plain Files, No Vendor Lock-In

Memory is stored as plain markdown files with YAML frontmatter in a git repo. No database, no binary formats, no proprietary schemas. A user must be able to read, edit, and reorganize their memory with nothing but a text editor and git.

## C7: The User Owns Their Memory

PACK never refuses to store information the user explicitly asks to save. The user decides what goes in their memory — personal facts, work context, preferences, style profiles, contacts, or anything else. No gatekeeping, no filtering, no "this doesn't seem appropriate" responses.

## C8: Webhook Backward Compatibility

v2 webhook payloads include a `version` field (value: `2`). v1 payloads have no `version` field. Webhook consumers must be able to distinguish between v1 and v2 payloads by checking for the presence of `version`. The `event`, `content`, `message`, `repo`, `sha`, `commit_url`, and `timestamp` fields must remain present in both versions.

## C9: Every Write Produces a Git Commit

Every `memory_update` (MCP or CLI) results in exactly one git commit with a meaningful message that includes the file path. No batching writes silently, no deferred commits, no write-without-commit modes. The git log is the audit trail.

## C10: Index Consistency

`index.md` is regenerated on every write operation. If `index.md` drifts from actual repo state (e.g., manual git operations), the next write auto-corrects it. `pack validate` detects and reports drift without modifying anything.

## C11: Notion Multi-Page Sync Safety

Multi-page Notion sync (`NOTION_SYNC_MODE=multi`) is opt-in and requires explicit migration via `pack migrate-notion`.

- When `NOTION_SYNC_MODE=multi` and `.notion-pages.json` does not exist, PACK falls back to single-page sync with a warning. It never auto-creates sub-pages during normal sync.
- `pack migrate-notion` is idempotent. It skips files that already have pages in the mapping and only creates missing ones. A partial failure writes the mapping so the next run resumes from where it left off.
- The parent Notion page is only rewritten as an index after all sub-pages are confirmed created.
- The "PACK Full Export (read-only)" page attempts section replacement first. If the heading is not found or block manipulation fails, it falls back to a full page rewrite. It never leaves the page in a partial state.
- Google Docs sync is unaffected by Notion sync mode. It always receives the full concatenated memory.
