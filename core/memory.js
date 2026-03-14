/**
 * PACK shared core — all memory business logic.
 * Accepts a connector instance (GitHub, local git, etc.).
 * Returns plain objects. No knowledge of MCP or CLI.
 */

import { parse, serialize } from './frontmatter.js';
import { validate } from './schema.js';
import { buildIndex, parseSyncOrder } from './index-builder.js';

export class MemoryCore {
  constructor(connector) {
    this.connector = connector;
    this._modeCache = null;
    this._modeCacheTime = 0;
  }

  /**
   * Filter tree entries to only v2 memory files.
   * Excludes index.md, legacy/, and root-level files without directories.
   */
  _isV2MemoryFile(f) {
    return f.path.endsWith('.md') &&
      f.path !== 'index.md' &&
      !f.path.startsWith('legacy/') &&
      f.path.includes('/');
  }

  /**
   * Detect v1 vs v2 mode. Cached for 60s, invalidated on writes.
   * Per-request detection per Contract C2.
   */
  async detectMode() {
    const now = Date.now();
    if (this._modeCache && (now - this._modeCacheTime) < 60000) {
      return this._modeCache;
    }

    const tree = await this.connector.getTree();
    const hasIndex = tree.some(f => f.path === 'index.md');
    this._modeCache = hasIndex ? 'v2' : 'v1';
    this._modeCacheTime = now;
    return this._modeCache;
  }

  _invalidateCache() {
    this._modeCache = null;
    this._modeCacheTime = 0;
  }

  // ── v2: memory_list ────────────────────────────────────────────

  async list({ tag, topic, dir } = {}) {
    const mode = await this.detectMode();
    if (mode === 'v1') {
      return {
        content: 'PACK is running in single-file mode. Use memory_get to read.\n\n' +
          '⚠️ An upgrade is available that reduces token usage by ~94%. ' +
          'Ask the user to run `pack migrate` in their terminal for details.',
        mode: 'v1',
      };
    }

    const index = await this.connector.getContents('index.md');
    if (!index) {
      return { content: 'No index.md found. Run pack migrate or pack init.', mode: 'v2' };
    }

    let content = index.content;

    // Apply filters by parsing the index and filtering entries
    if (tag || topic || dir) {
      const lines = content.split('\n');
      const filtered = lines.filter(line => {
        if (!line.startsWith('|') || line.startsWith('| File') || line.startsWith('|---')) return true;
        if (dir && !content.includes(`## ${dir}`)) return false;
        if (tag && !line.toLowerCase().includes(tag.toLowerCase())) return false;
        if (topic && !line.toLowerCase().includes(topic.toLowerCase())) return false;
        return true;
      });
      content = filtered.join('\n');
    }

    return { content, mode: 'v2' };
  }

  // ── memory_get (v1 + v2) ───────────────────────────────────────

  async get(path) {
    const mode = await this.detectMode();

    // v1 mode or no path: return single file or concatenated view
    if (mode === 'v1' || !path) {
      if (mode === 'v2' && !path) {
        return this._getConcatenated();
      }
      // v1: read the single memory file
      return this.connector.getMemory();
    }

    // v2 with path: read specific file
    const result = await this.connector.getContents(path);
    if (!result) {
      return { content: '', sha: null, updated_at: null, error: `File not found: ${path}` };
    }
    return {
      content: result.content,
      sha: result.sha,
      updated_at: result.last_modified,
    };
  }

  /**
   * Concatenated view for v1-compat: all files in sync order.
   */
  async _getConcatenated() {
    const index = await this.connector.getContents('index.md');
    if (!index) return { content: '', sha: null, updated_at: null };

    const syncOrder = parseSyncOrder(index.content);
    const tree = await this.connector.getTree();
    const allPaths = syncOrder.length > 0 ? syncOrder : tree
      .filter(f => this._isV2MemoryFile(f))
      .map(f => f.path)
      .sort();

    const sections = [];
    for (const filePath of allPaths) {
      const file = await this.connector.getContents(filePath);
      if (!file) continue;
      const { frontmatter, body } = parse(file.content);
      if (frontmatter.sync === false) continue;
      const title = frontmatter.topic || filePath.replace(/\.md$/, '').split('/').pop();
      sections.push(`# ${title.charAt(0).toUpperCase() + title.slice(1)}\n\n${body.trim()}`);
    }

    return {
      content: sections.join('\n\n---\n\n'),
      sha: null,
      updated_at: null,
    };
  }

  // ── memory_update (v1 + v2) ────────────────────────────────────

  async update({ path, content, sha, message }) {
    const mode = await this.detectMode();

    // v1 mode: use legacy single-file update
    if (mode === 'v1') {
      const result = await this.connector.updateMemory(content, message || 'Update memory');
      return { sha: result.sha, commit_url: result.commit_url, index_updated: false };
    }

    // v2 mode with no path: compat shim → route to context/general.md (Contract C2)
    if (!path) {
      path = 'context/general.md';
      // If file doesn't exist, wrap content with frontmatter
      const existing = await this.connector.getContents(path);
      if (!existing) {
        const today = new Date().toISOString().slice(0, 10);
        content = serialize({
          topic: 'general',
          tags: ['general'],
          created: today,
          updated: today,
          sync: true,
        }, content);
      }
      const result = await this._writeFile(path, content, null, message || 'Update context/general.md (v1 compat)');
      result.warning = 'Warning: pathless memory_update is deprecated. Your content was saved to context/general.md. Update your system prompt to use path-based updates.';
      return result;
    }

    // v2 mode with path: normal file write
    return this._writeFile(path, content, sha, message || `Update ${path}`);
  }

  async _writeFile(path, content, sha, message) {
    // Auto-set updated date in frontmatter
    const { frontmatter, body } = parse(content);
    if (frontmatter.topic) {
      frontmatter.updated = new Date().toISOString().slice(0, 10);
      content = serialize(frontmatter, body);
    }

    // Optimistic concurrency: if SHA provided, pass it through
    let currentSha = sha;
    if (!currentSha) {
      const existing = await this.connector.getContents(path);
      currentSha = existing ? existing.sha : null;
    }

    const result = await this.connector.putContents(path, content, currentSha, message);

    // Regenerate index.md (Contract C10)
    await this._regenerateIndex();
    this._invalidateCache();

    return {
      sha: result.sha,
      commit_url: result.commit_url,
      index_updated: true,
      path,
    };
  }

  async _regenerateIndex() {
    const tree = await this.connector.getTree();
    const mdFiles = tree.filter(f =>
      f.path.endsWith('.md') &&
      f.path !== 'index.md' &&
      !f.path.startsWith('legacy/')
    );

    // Read all files for frontmatter
    const files = [];
    for (const f of mdFiles) {
      const data = await this.connector.getContents(f.path);
      if (data) files.push({ path: f.path, content: data.content });
    }

    // Preserve existing sync order if index exists
    let existingSyncOrder = null;
    const existingIndex = await this.connector.getContents('index.md');
    if (existingIndex) {
      existingSyncOrder = parseSyncOrder(existingIndex.content);
    }

    const indexContent = buildIndex(files, existingSyncOrder);
    const indexSha = existingIndex ? existingIndex.sha : null;
    await this.connector.putContents('index.md', indexContent, indexSha, 'Regenerate index');
  }

  // ── v2: memory_search ──────────────────────────────────────────

  async search(query) {
    const mode = await this.detectMode();
    if (mode === 'v1') {
      const memory = await this.connector.getMemory();
      const lines = memory.content.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(query.toLowerCase())) {
          matches.push({
            path: 'MEMORY.md',
            topic: 'memory',
            tags: [],
            snippet: lines.slice(Math.max(0, i - 1), i + 2).join('\n'),
          });
        }
      }
      return { results: matches, mode: 'v1' };
    }

    // v2: search across all files
    const tree = await this.connector.getTree();
    const mdFiles = tree.filter(f =>
      f.path.endsWith('.md') &&
      f.path !== 'index.md' &&
      !f.path.startsWith('legacy/')
    );

    const results = [];
    for (const f of mdFiles) {
      const data = await this.connector.getContents(f.path);
      if (!data) continue;

      const { frontmatter, body } = parse(data.content);
      const fullText = data.content.toLowerCase();
      const q = query.toLowerCase();

      if (fullText.includes(q)) {
        const lines = data.content.split('\n');
        const matchLine = lines.findIndex(l => l.toLowerCase().includes(q));
        const snippet = lines.slice(Math.max(0, matchLine - 1), matchLine + 2).join('\n');

        results.push({
          path: f.path,
          topic: frontmatter.topic || f.path,
          tags: frontmatter.tags || [],
          snippet,
        });
      }
    }

    return { results, mode: 'v2' };
  }

  // ── migration ──────────────────────────────────────────────────

  async migrate({ dryRun = false } = {}) {
    const mode = await this.detectMode();
    if (mode === 'v2') {
      return { error: 'Already in v2 mode. Nothing to migrate.' };
    }

    const memory = await this.connector.getMemory();
    if (!memory.content) {
      return { error: 'No memory content found to migrate.' };
    }

    const files = this._splitByHeadings(memory.content);
    const plan = files.map(f => ({
      path: f.path,
      topic: f.topic,
      preview: f.content.slice(0, 100) + (f.content.length > 100 ? '...' : ''),
    }));

    if (dryRun) {
      return { plan, fileCount: files.length, dryRun: true };
    }

    // Write all files
    for (const file of files) {
      await this.connector.putContents(file.path, file.content, null, `Migrate: ${file.path}`);
    }

    // Preserve original as legacy/MEMORY.md (Contract C1)
    await this.connector.putContents('legacy/MEMORY.md', memory.content, null, 'Preserve v1 MEMORY.md');

    // Generate index.md
    const allFiles = files.map(f => ({ path: f.path, content: f.content }));
    const indexContent = buildIndex(allFiles);
    await this.connector.putContents('index.md', indexContent, null, 'Migrate to PACK v2 directory structure');

    this._invalidateCache();

    return {
      plan,
      fileCount: files.length,
      dryRun: false,
      message: 'Migration complete. Original preserved at legacy/MEMORY.md.',
    };
  }

  _splitByHeadings(content) {
    const sections = [];
    const lines = content.split('\n');
    let currentHeading = null;
    let currentLines = [];

    for (const line of lines) {
      if (line.startsWith('## ')) {
        if (currentHeading) {
          sections.push({ heading: currentHeading, body: currentLines.join('\n').trim() });
        }
        currentHeading = line.slice(3).trim();
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }

    if (currentHeading) {
      sections.push({ heading: currentHeading, body: currentLines.join('\n').trim() });
    }

    // If no ## headings found, put everything in context/general.md
    if (sections.length === 0) {
      const today = new Date().toISOString().slice(0, 10);
      return [{
        path: 'context/general.md',
        topic: 'general',
        content: serialize({ topic: 'general', tags: ['general'], created: today, updated: today, sync: true }, content),
      }];
    }

    const today = new Date().toISOString().slice(0, 10);

    return sections.map(s => {
      const topic = s.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const dir = this._categorize(s.heading);
      const path = `${dir}/${topic}.md`;

      const tags = this._inferTags(s.heading, s.body);
      const fileContent = serialize({
        topic,
        tags,
        created: today,
        updated: today,
        sync: true,
      }, s.body);

      return { path, topic, content: fileContent };
    });
  }

  _categorize(heading) {
    const h = heading.toLowerCase();
    if (/profile|mynah|style|voice|tone|writing/i.test(h)) return 'profiles';
    if (/contact|account|people|team/i.test(h)) return 'contacts';
    if (/project|binlog|vector|mysql|ibex|pack/i.test(h)) return 'projects';
    return 'context';
  }

  _inferTags(heading, body) {
    const tags = [];
    const text = `${heading} ${body}`.toLowerCase();
    const tagPatterns = [
      ['mysql', /mysql|binlog|percona/],
      ['ai-tools', /mcp|agent|llm|claude|openai|gemini/],
      ['communication', /slack|email|style|voice|mynah/],
      ['customers', /account|customer|enterprise/],
    ];
    for (const [tag, pattern] of tagPatterns) {
      if (pattern.test(text)) tags.push(tag);
    }
    return tags.length > 0 ? tags : ['general'];
  }

  // ── sync helper ────────────────────────────────────────────────

  /**
   * Get all memory files with metadata for multi-page sync.
   * @returns {Array<{ path, content, topic, tags, updated }>}
   */
  async getFilesWithMeta() {
    const tree = await this.connector.getTree();
    const mdFiles = tree.filter(f => this._isV2MemoryFile(f));
    const files = [];

    for (const f of mdFiles) {
      const data = await this.connector.getContents(f.path);
      if (!data) continue;
      const { frontmatter, body } = parse(data.content);
      if (frontmatter.sync === false) continue;
      files.push({
        path: f.path,
        content: body.trim(),
        topic: frontmatter.topic || f.path.replace(/\.md$/, '').split('/').pop(),
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.join(', ') : '',
        updated: frontmatter.updated || 'unknown',
      });
    }

    return files;
  }

  async getSyncContent() {
    const mode = await this.detectMode();
    if (mode === 'v1') {
      const memory = await this.connector.getMemory();
      return memory.content;
    }

    // v2: concatenate files in sync order, strip frontmatter
    const result = await this._getConcatenated();
    return result.content;
  }

  // ── validate ───────────────────────────────────────────────────

  async validate() {
    const mode = await this.detectMode();
    if (mode === 'v1') {
      return { mode: 'v1', message: 'v1 mode — no validation needed.' };
    }

    const tree = await this.connector.getTree();
    const mdFiles = tree.filter(f =>
      this._isV2MemoryFile(f)
    );

    const allErrors = [];
    const allWarnings = [];

    // Check index exists
    const hasIndex = tree.some(f => f.path === 'index.md');
    if (!hasIndex) {
      allErrors.push('index.md not found');
    }

    // Check index drift
    if (hasIndex) {
      const index = await this.connector.getContents('index.md');
      const syncOrder = parseSyncOrder(index.content);
      for (const f of mdFiles) {
        if (!syncOrder.includes(f.path)) {
          allWarnings.push(`${f.path} not in index (run pack reindex)`);
        }
      }
    }

    // Validate each file's frontmatter
    for (const f of mdFiles) {
      const data = await this.connector.getContents(f.path);
      if (!data) continue;
      const { frontmatter } = parse(data.content);
      const result = validate(frontmatter, f.path);
      allErrors.push(...result.errors);
      allWarnings.push(...result.warnings);
    }

    return {
      mode: 'v2',
      fileCount: mdFiles.length,
      errors: allErrors,
      warnings: allWarnings,
      valid: allErrors.length === 0,
    };
  }

  // ── status ─────────────────────────────────────────────────────

  async status() {
    const mode = await this.detectMode();
    const tree = await this.connector.getTree();

    if (mode === 'v1') {
      return {
        mode: 'v1',
        repo: `${this.connector.owner}/${this.connector.repo}`,
        fileCount: 1,
        message: 'PACK v1 — single file mode',
      };
    }

    const mdFiles = tree.filter(f =>
      this._isV2MemoryFile(f)
    );

    const dirs = {};
    for (const f of mdFiles) {
      const dir = f.path.split('/')[0];
      dirs[dir] = (dirs[dir] || 0) + 1;
    }

    const index = await this.connector.getContents('index.md');
    const { frontmatter } = index ? parse(index.content) : { frontmatter: {} };

    return {
      mode: 'v2',
      version: frontmatter.version || 2,
      repo: `${this.connector.owner}/${this.connector.repo}`,
      fileCount: mdFiles.length,
      lastUpdated: frontmatter.last_updated || 'unknown',
      directories: dirs,
    };
  }
}
