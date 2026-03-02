import fetch from 'node-fetch';

/**
 * Minimal Notion connector — only the write methods needed for memory sync.
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
