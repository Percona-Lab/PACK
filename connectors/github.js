import fetch from 'node-fetch';

export class GitHubConnector {
  constructor(token, owner, repo, memoryPath = 'MEMORY.md') {
    if (!token) throw new Error('GITHUB_TOKEN is required');
    if (!owner) throw new Error('GITHUB_OWNER is required');
    if (!repo) throw new Error('GITHUB_REPO is required');
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.memoryPath = memoryPath;
    this.baseUrl = 'https://api.github.com';
  }

  async apiCall(endpoint, method = 'GET', body = null) {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : null,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  // ── v1 legacy methods (preserved for backward compat) ──────────

  async getMemory() {
    const data = await this.apiCall(
      `/repos/${this.owner}/${this.repo}/contents/${this.memoryPath}`
    );

    if (!data) {
      return { content: '', sha: null, last_modified: null };
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return {
      content,
      sha: data.sha,
      last_modified: data.last_modified || null,
    };
  }

  async updateMemory(content, message = 'Update memory') {
    const current = await this.getMemory();

    const body = {
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
    };

    if (current.sha) {
      body.sha = current.sha;
    }

    const data = await this.apiCall(
      `/repos/${this.owner}/${this.repo}/contents/${this.memoryPath}`,
      'PUT',
      body
    );

    return {
      sha: data.content?.sha,
      commit_url: data.commit?.html_url,
    };
  }

  // ── v2 connector interface (Contract C5) ───────────────────────

  /**
   * Read any single file by path.
   * @param {string} path - Relative file path
   * @returns {{ content: string, sha: string, last_modified: string } | null}
   */
  async getContents(path) {
    const data = await this.apiCall(
      `/repos/${this.owner}/${this.repo}/contents/${path}`
    );

    if (!data) return null;

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return {
      content,
      sha: data.sha,
      last_modified: data.last_modified || null,
    };
  }

  /**
   * Write any single file with custom commit message.
   * @param {string} path
   * @param {string} content
   * @param {string|null} sha - Current SHA for updates; null for new files
   * @param {string} message - Git commit message
   * @returns {{ sha: string, commit_url: string }}
   */
  async putContents(path, content, sha = null, message = 'Update file') {
    const body = {
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
    };

    if (sha) {
      body.sha = sha;
    }

    const data = await this.apiCall(
      `/repos/${this.owner}/${this.repo}/contents/${path}`,
      'PUT',
      body
    );

    return {
      sha: data.content?.sha,
      commit_url: data.commit?.html_url,
    };
  }

  /**
   * List directory contents (recursive via Trees API for efficiency).
   * @param {string} [dirPath] - Optional directory prefix to filter
   * @returns {Array<{ name: string, path: string, type: string, sha: string }>}
   */
  async listDir(dirPath = '') {
    const tree = await this.getTree();
    const items = tree.filter(f => {
      if (!dirPath) return true;
      return f.path.startsWith(dirPath);
    });
    return items;
  }

  /**
   * Delete a file.
   * @param {string} path
   * @param {string} sha - Current SHA (required by GitHub API)
   */
  async deleteFile(path, sha) {
    await this.apiCall(
      `/repos/${this.owner}/${this.repo}/contents/${path}`,
      'DELETE',
      { message: `Delete ${path}`, sha }
    );
  }

  /**
   * Get full repo tree (all files, recursive).
   * Uses Git Trees API for single-request efficiency.
   * @returns {Array<{ path: string, type: string, sha: string }>}
   */
  async getTree() {
    const data = await this.apiCall(
      `/repos/${this.owner}/${this.repo}/git/trees/HEAD?recursive=1`
    );

    if (!data || !data.tree) return [];

    return data.tree
      .filter(item => item.type === 'blob')
      .map(item => ({
        path: item.path,
        type: 'file',
        sha: item.sha,
      }));
  }
}
