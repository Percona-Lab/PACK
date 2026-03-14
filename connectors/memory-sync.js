/**
 * Orchestrates optional sync from GitHub memory to Google Docs and/or Notion.
 * Supports two Notion modes:
 *   - single (default): replaces one page with all memory concatenated
 *   - multi: one sub-page per PACK file, parent page as index, full export page
 * Sync is non-blocking -- failures are logged but never propagate to the caller.
 * Contract C3: in single mode, downstream connectors receive a single markdown string.
 */

export class MemorySyncManager {
  constructor() {
    this.targets = [];
    this.notionConnector = null;
    this.notionPageId = null;
    this.notionSyncMode = 'single';
    this.googleDocsConnector = null;
    this.googleDocId = null;
    this.githubConnector = null;
  }

  async init() {
    // Notion sync: needs NOTION_TOKEN + NOTION_SYNC_PAGE_ID
    if (process.env.NOTION_TOKEN && process.env.NOTION_SYNC_PAGE_ID) {
      const { NotionSyncConnector } = await import('./notion-sync.js');
      this.notionConnector = new NotionSyncConnector(process.env.NOTION_TOKEN);
      this.notionPageId = process.env.NOTION_SYNC_PAGE_ID;
      this.notionSyncMode = (process.env.NOTION_SYNC_MODE || 'single').toLowerCase();
      this.targets.push('notion');
    }

    // Google Docs sync: needs all four GOOGLE_* vars
    if (process.env.GOOGLE_DOC_ID && process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
      const { GoogleDocsConnector } = await import('./google-docs.js');
      this.googleDocsConnector = new GoogleDocsConnector(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REFRESH_TOKEN
      );
      this.googleDocId = process.env.GOOGLE_DOC_ID;
      this.targets.push('google-docs');
    }
  }

  /**
   * Set the GitHub connector for reading/writing .notion-pages.json mapping.
   * Must be called after init() when using multi-page mode.
   * @param {object} connector - GitHubConnector instance
   */
  setGitHubConnector(connector) {
    this.githubConnector = connector;
  }

  get enabled() {
    return this.targets.length > 0;
  }

  /**
   * Fire-and-forget sync to all configured targets.
   * @param {string} content - Full concatenated markdown (for single mode + Google Docs)
   * @param {object} [fileUpdate] - Per-file update info for multi-page Notion sync
   * @param {string} fileUpdate.path - PACK file path that changed
   * @param {string} fileUpdate.content - Updated file content (with frontmatter)
   * @param {string} fileUpdate.topic - File topic from frontmatter
   * @param {Array} [fileUpdate.allFiles] - All files metadata for index rebuild
   */
  async sync(content, fileUpdate = null) {
    const promises = [];

    if (this.notionConnector) {
      if (this.notionSyncMode === 'multi' && fileUpdate) {
        promises.push(
          this._syncNotionMulti(fileUpdate, content)
            .then(() => console.error('[sync] Notion multi: ok'))
            .catch(err => console.error('[sync] Notion multi: failed -', err.message))
        );
      } else {
        promises.push(
          this.notionConnector.replacePageContent(this.notionPageId, content)
            .then(() => console.error('[sync] Notion: ok'))
            .catch(err => console.error('[sync] Notion: failed -', err.message))
        );
      }
    }

    if (this.googleDocsConnector) {
      promises.push(
        this.googleDocsConnector.replaceContent(this.googleDocId, content)
          .then(() => console.error('[sync] Google Docs: ok'))
          .catch(err => console.error('[sync] Google Docs: failed -', err.message))
      );
    }

    await Promise.allSettled(promises);
  }

  /**
   * Multi-page Notion sync: update the specific file's sub-page,
   * refresh the index page, and update the full export section.
   */
  async _syncNotionMulti(fileUpdate, fullContent) {
    const { path, content, topic, allFiles } = fileUpdate;

    // Read mapping from GitHub
    const mapping = await this._readMapping();
    if (!mapping) {
      console.error('[sync] Notion multi: .notion-pages.json not found. Run `pack migrate-notion` first.');
      // Fall back to single-page sync
      await this.notionConnector.replacePageContent(this.notionPageId, fullContent);
      console.error('[sync] Notion: fell back to single-page sync');
      return;
    }

    // 1. Sync the changed file's sub-page
    const existingPageId = mapping.pages[path];
    if (existingPageId) {
      await this.notionConnector.replacePageContent(existingPageId, content);
      // Update title if topic changed
      if (topic) {
        await this.notionConnector.updatePageTitle(existingPageId, topic);
      }
    } else {
      // New file -- create sub-page
      const title = topic || path.replace(/\.md$/, '').split('/').pop();
      const { pageId } = await this.notionConnector.createChildPage(
        this.notionPageId, title, content
      );
      mapping.pages[path] = pageId;
      await this._writeMapping(mapping);
    }

    // 2. Update index page
    if (allFiles) {
      const indexContent = this.notionConnector.buildIndexContent(
        allFiles, mapping.pages, mapping.full_export_page_id
      );
      await this.notionConnector.replacePageContent(this.notionPageId, indexContent);
    }

    // 3. Update full export page (section replacement with fallback)
    if (mapping.full_export_page_id) {
      const sectionTitle = topic
        ? topic.charAt(0).toUpperCase() + topic.slice(1)
        : path.replace(/\.md$/, '').split('/').pop();

      const result = await this.notionConnector.replacePageSection(
        mapping.full_export_page_id, sectionTitle, content
      );

      if (!result.success) {
        console.error('[sync] Notion: section replace failed, rewriting full export page');
        await this.notionConnector.replacePageContent(mapping.full_export_page_id, fullContent);
      }
    }
  }

  /**
   * Read .notion-pages.json from GitHub repo.
   * @returns {object|null}
   */
  async _readMapping() {
    if (!this.githubConnector) return null;
    try {
      const data = await this.githubConnector.getContents('.notion-pages.json');
      if (!data) return null;
      return JSON.parse(data.content);
    } catch {
      return null;
    }
  }

  /**
   * Write .notion-pages.json to GitHub repo.
   * @param {object} mapping
   */
  async _writeMapping(mapping) {
    if (!this.githubConnector) return;
    const content = JSON.stringify(mapping, null, 2) + '\n';
    const existing = await this.githubConnector.getContents('.notion-pages.json');
    const sha = existing ? existing.sha : null;
    await this.githubConnector.putContents('.notion-pages.json', content, sha, 'Update Notion page mapping');
  }

  /**
   * Run Notion multi-page migration.
   * Creates sub-pages for all PACK files, a full export page, and the index.
   * Idempotent: skips files that already have pages in the mapping.
   * @param {Array<{ path: string, content: string, topic: string, tags: string, updated: string }>} files
   * @param {string} fullContent - Full concatenated markdown for the export page
   * @param {object} [options]
   * @param {boolean} [options.dryRun=false]
   * @returns {{ mapping: object, created: string[], skipped: string[], fullExportPageId: string }}
   */
  async migrateNotion(files, fullContent, { dryRun = false } = {}) {
    if (!this.notionConnector) {
      throw new Error('Notion sync not configured. Set NOTION_TOKEN and NOTION_SYNC_PAGE_ID.');
    }

    // Load existing mapping or create new one
    let mapping = await this._readMapping() || {
      version: 1,
      full_export_page_id: null,
      pages: {},
    };

    const created = [];
    const skipped = [];

    if (dryRun) {
      for (const f of files) {
        if (mapping.pages[f.path]) {
          skipped.push(f.path);
        } else {
          created.push(f.path);
        }
      }
      return {
        mapping,
        created,
        skipped,
        fullExportPageId: mapping.full_export_page_id,
        dryRun: true,
      };
    }

    // Create sub-pages for each file
    for (const f of files) {
      if (mapping.pages[f.path]) {
        // Page exists -- update content
        try {
          await this.notionConnector.replacePageContent(mapping.pages[f.path], f.content);
          skipped.push(f.path);
        } catch (err) {
          console.error(`[migrate-notion] Failed to update ${f.path}: ${err.message}`);
          // Page may have been deleted -- create a new one
          delete mapping.pages[f.path];
        }
      }

      if (!mapping.pages[f.path]) {
        try {
          const title = f.topic || f.path.replace(/\.md$/, '').split('/').pop();
          const { pageId } = await this.notionConnector.createChildPage(
            this.notionPageId, title, f.content
          );
          mapping.pages[f.path] = pageId;
          created.push(f.path);
        } catch (err) {
          console.error(`[migrate-notion] Failed to create page for ${f.path}: ${err.message}`);
          // Write partial mapping so we can resume
          await this._writeMapping(mapping);
          throw err;
        }
      }
    }

    // Create or update full export page
    if (!mapping.full_export_page_id) {
      try {
        const { pageId } = await this.notionConnector.createChildPage(
          this.notionPageId, 'PACK Full Export (read-only)', fullContent
        );
        mapping.full_export_page_id = pageId;
      } catch (err) {
        console.error(`[migrate-notion] Failed to create full export page: ${err.message}`);
        await this._writeMapping(mapping);
        throw err;
      }
    } else {
      await this.notionConnector.replacePageContent(mapping.full_export_page_id, fullContent);
    }

    // Write mapping
    await this._writeMapping(mapping);

    // Rewrite parent page as index
    const indexContent = this.notionConnector.buildIndexContent(
      files, mapping.pages, mapping.full_export_page_id
    );
    await this.notionConnector.replacePageContent(this.notionPageId, indexContent);

    return {
      mapping,
      created,
      skipped,
      fullExportPageId: mapping.full_export_page_id,
      dryRun: false,
    };
  }
}
