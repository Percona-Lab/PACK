import fetch from 'node-fetch';

/**
 * Notion connector for memory sync.
 * Supports single-page (replace all) and multi-page (per-file sub-pages) modes.
 */
export class NotionSyncConnector {
  constructor(token) {
    this.token = token;
    this.baseUrl = 'https://api.notion.com/v1';
    this.notionVersion = '2022-06-28';
  }

  async apiCall(endpoint, method = 'GET', body = null) {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': this.notionVersion,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : null,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Notion API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  // ── Single-page sync (existing) ─────────────────────────────────

  async clearPageBlocks(pageId) {
    const cleanId = pageId.replace(/-/g, '');
    const data = await this.apiCall(`/blocks/${cleanId}/children`);
    const blocks = data.results || [];
    for (const block of blocks) {
      await this.apiCall(`/blocks/${block.id}`, 'DELETE');
    }
    return blocks.length;
  }

  async replacePageContent(pageId, markdownContent) {
    const deleted = await this.clearPageBlocks(pageId);
    const blocks = this.markdownToBlocks(markdownContent);
    const cleanId = pageId.replace(/-/g, '');

    // Notion API accepts max 100 blocks per request
    for (let i = 0; i < blocks.length; i += 100) {
      await this.apiCall(`/blocks/${cleanId}/children`, 'PATCH', {
        children: blocks.slice(i, i + 100),
      });
    }

    return { synced: true, pageId, blocksDeleted: deleted, blocksCreated: blocks.length };
  }

  // ── Multi-page sync ─────────────────────────────────────────────

  /**
   * Create a child page under a parent page.
   * @param {string} parentId - Parent page ID
   * @param {string} title - Page title
   * @param {string} markdownContent - Page body as markdown
   * @returns {{ pageId: string }} - Created page ID
   */
  async createChildPage(parentId, title, markdownContent) {
    const cleanParentId = parentId.replace(/-/g, '');
    const blocks = this.markdownToBlocks(markdownContent);

    // Notion API limits children to 100 blocks on create
    const initialBlocks = blocks.slice(0, 100);

    const page = await this.apiCall('/pages', 'POST', {
      parent: { page_id: cleanParentId },
      properties: {
        title: { title: this._richText(title) },
      },
      children: initialBlocks,
    });

    // Append remaining blocks in batches
    const pageId = page.id;
    for (let i = 100; i < blocks.length; i += 100) {
      await this.apiCall(`/blocks/${pageId}/children`, 'PATCH', {
        children: blocks.slice(i, i + 100),
      });
    }

    return { pageId };
  }

  /**
   * Update the title of an existing page.
   * @param {string} pageId
   * @param {string} title
   */
  async updatePageTitle(pageId, title) {
    const cleanId = pageId.replace(/-/g, '');
    await this.apiCall(`/pages/${cleanId}`, 'PATCH', {
      properties: {
        title: { title: this._richText(title) },
      },
    });
  }

  /**
   * List all child pages under a parent page.
   * @param {string} parentId
   * @returns {Array<{ id: string, title: string }>}
   */
  async getChildPages(parentId) {
    const cleanId = parentId.replace(/-/g, '');
    const pages = [];
    let cursor = undefined;

    do {
      const params = cursor ? `?start_cursor=${cursor}` : '';
      const data = await this.apiCall(`/blocks/${cleanId}/children${params}`);
      for (const block of (data.results || [])) {
        if (block.type === 'child_page') {
          pages.push({ id: block.id, title: block.child_page?.title || '' });
        }
      }
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);

    return pages;
  }

  /**
   * Replace a section in a page identified by a heading_1 block.
   * Finds the heading, deletes blocks from it to the next heading_1 or divider,
   * then inserts new blocks in their place.
   * @param {string} pageId
   * @param {string} sectionHeading - Text of the heading_1 to find
   * @param {string} markdownContent - New section content (including the heading)
   * @returns {{ success: boolean, blocksDeleted?: number, blocksCreated?: number }}
   */
  async replacePageSection(pageId, sectionHeading, markdownContent) {
    try {
      const cleanId = pageId.replace(/-/g, '');

      // Get all children blocks
      const allBlocks = [];
      let cursor = undefined;
      do {
        const params = cursor ? `?start_cursor=${cursor}` : '';
        const data = await this.apiCall(`/blocks/${cleanId}/children${params}`);
        allBlocks.push(...(data.results || []));
        cursor = data.has_more ? data.next_cursor : null;
      } while (cursor);

      // Find the heading_1 block matching sectionHeading
      const headingNorm = sectionHeading.toLowerCase().trim();
      let startIdx = -1;
      for (let i = 0; i < allBlocks.length; i++) {
        const block = allBlocks[i];
        if (block.type === 'heading_1') {
          const text = (block.heading_1?.rich_text || []).map(t => t.plain_text).join('').toLowerCase().trim();
          if (text === headingNorm) {
            startIdx = i;
            break;
          }
        }
      }

      if (startIdx === -1) return { success: false };

      // Find the end of this section (next heading_1, divider before heading_1, or end of page)
      let endIdx = allBlocks.length;
      for (let i = startIdx + 1; i < allBlocks.length; i++) {
        const block = allBlocks[i];
        if (block.type === 'heading_1') {
          // Check if there's a divider right before this heading
          if (i > startIdx + 1 && allBlocks[i - 1].type === 'divider') {
            endIdx = i - 1; // Include divider in deletion
          } else {
            endIdx = i;
          }
          break;
        }
      }

      // Delete old section blocks
      const toDelete = allBlocks.slice(startIdx, endIdx);
      for (const block of toDelete) {
        await this.apiCall(`/blocks/${block.id}`, 'DELETE');
      }

      // Insert new blocks after the block preceding the deleted range
      const newBlocks = this.markdownToBlocks(markdownContent);
      const afterBlockId = startIdx > 0 ? allBlocks[startIdx - 1].id : null;

      for (let i = 0; i < newBlocks.length; i += 100) {
        const batch = newBlocks.slice(i, i + 100);
        const body = { children: batch };
        if (afterBlockId && i === 0) {
          body.after = afterBlockId;
        }
        await this.apiCall(`/blocks/${cleanId}/children`, 'PATCH', body);
      }

      return { success: true, blocksDeleted: toDelete.length, blocksCreated: newBlocks.length };
    } catch (err) {
      console.error(`[notion] Section replace failed: ${err.message}`);
      return { success: false };
    }
  }

  /**
   * Build index page markdown content with links to sub-pages.
   * @param {Array<{ path: string, topic: string, tags: string, updated: string }>} files
   * @param {Object} pageMapping - { filePath: notionPageId }
   * @param {string} [fullExportPageId] - Optional full export page ID
   * @returns {string} - Markdown content for the index page
   */
  buildIndexContent(files, pageMapping, fullExportPageId = null) {
    const now = new Date().toISOString();
    const lines = [
      `# PACK Memory Index`,
      '',
      `Last synced: ${now} | ${files.length} files`,
      '',
    ];

    if (fullExportPageId) {
      const cleanId = fullExportPageId.replace(/-/g, '');
      lines.push(`Full export: https://notion.so/${cleanId}`);
      lines.push('');
    }

    // Group by directory
    const dirs = {};
    for (const f of files) {
      const dir = f.path.includes('/') ? f.path.split('/')[0] + '/' : '/';
      if (!dirs[dir]) dirs[dir] = [];
      dirs[dir].push(f);
    }

    for (const [dir, dirFiles] of Object.entries(dirs).sort()) {
      lines.push(`## ${dir}`);
      for (const f of dirFiles.sort((a, b) => a.path.localeCompare(b.path))) {
        const pageId = pageMapping[f.path];
        const cleanId = pageId ? pageId.replace(/-/g, '') : null;
        const link = cleanId ? `https://notion.so/${cleanId}` : f.path;
        const tags = f.tags || '';
        lines.push(`- [${f.topic || f.path}](${link}) -- ${tags} | ${f.updated || 'unknown'}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ── Markdown conversion ─────────────────────────────────────────

  markdownToBlocks(markdown) {
    const lines = markdown.split('\n');
    const blocks = [];
    let inCode = false;
    let codeLang = '';
    let codeLines = [];

    for (const line of lines) {
      if (line.startsWith('```')) {
        if (inCode) {
          blocks.push(this._codeBlock(codeLines.join('\n'), codeLang));
          inCode = false;
          codeLines = [];
          codeLang = '';
        } else {
          inCode = true;
          codeLang = line.slice(3).trim() || 'plain text';
        }
        continue;
      }

      if (inCode) {
        codeLines.push(line);
        continue;
      }

      if (line.startsWith('### ')) {
        blocks.push(this._heading(3, line.slice(4)));
      } else if (line.startsWith('## ')) {
        blocks.push(this._heading(2, line.slice(3)));
      } else if (line.startsWith('# ')) {
        blocks.push(this._heading(1, line.slice(2)));
      } else if (/^[-*] /.test(line)) {
        blocks.push(this._bulletItem(line.slice(2)));
      } else if (/^\d+\. /.test(line)) {
        blocks.push(this._numberedItem(line.replace(/^\d+\. /, '')));
      } else if (line.trim() === '') {
        continue;
      } else {
        blocks.push(this._paragraph(line));
      }
    }

    if (inCode && codeLines.length) {
      blocks.push(this._codeBlock(codeLines.join('\n'), codeLang));
    }

    return blocks;
  }

  _richText(text) {
    const chunks = [];
    for (let i = 0; i < text.length; i += 2000) {
      chunks.push({ type: 'text', text: { content: text.slice(i, i + 2000) } });
    }
    return chunks.length ? chunks : [{ type: 'text', text: { content: '' } }];
  }

  _heading(level, text) {
    const key = `heading_${level}`;
    return { object: 'block', type: key, [key]: { rich_text: this._richText(text) } };
  }

  _paragraph(text) {
    return { object: 'block', type: 'paragraph', paragraph: { rich_text: this._richText(text) } };
  }

  _bulletItem(text) {
    return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: this._richText(text) } };
  }

  _numberedItem(text) {
    return { object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: this._richText(text) } };
  }

  _codeBlock(text, language = 'plain text') {
    return { object: 'block', type: 'code', code: { rich_text: this._richText(text), language } };
  }
}
