/**
 * Orchestrates optional 1-way sync from GitHub memory to Google Docs and/or Notion.
 * Sync is non-blocking — failures are logged but never propagate to the caller.
 * Contract C3: downstream connectors always receive a single markdown string.
 */

export class MemorySyncManager {
  constructor() {
    this.targets = [];
    this.notionConnector = null;
    this.notionPageId = null;
    this.googleDocsConnector = null;
    this.googleDocId = null;
  }

  async init() {
    // Notion sync: needs NOTION_TOKEN + NOTION_SYNC_PAGE_ID
    if (process.env.NOTION_TOKEN && process.env.NOTION_SYNC_PAGE_ID) {
      const { NotionSyncConnector } = await import('./notion-sync.js');
      this.notionConnector = new NotionSyncConnector(process.env.NOTION_TOKEN);
      this.notionPageId = process.env.NOTION_SYNC_PAGE_ID;
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

  get enabled() {
    return this.targets.length > 0;
  }

  /**
   * Fire-and-forget sync to all configured targets.
   * Each target is independent — one failure doesn't affect the other.
   * @param {string} content - Single markdown string (v1 or v2 concatenated)
   */
  async sync(content) {
    const promises = [];

    if (this.notionConnector) {
      promises.push(
        this.notionConnector.replacePageContent(this.notionPageId, content)
          .then(() => console.error('[sync] Notion: ok'))
          .catch(err => console.error('[sync] Notion: failed -', err.message))
      );
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
}
