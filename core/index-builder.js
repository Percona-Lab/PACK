/**
 * Generates index.md from the current repo state.
 */

import { parse } from './frontmatter.js';

/**
 * Build index.md content from a list of memory files.
 * @param {Array<{ path: string, content: string }>} files - All memory files with content
 * @param {string[]} [existingSyncOrder] - Preserve existing sync order if available
 * @returns {string} - Complete index.md content
 */
export function buildIndex(files, existingSyncOrder = null) {
  const entries = [];

  for (const file of files) {
    if (file.path === 'index.md' || file.path.startsWith('legacy/')) continue;

    const { frontmatter } = parse(file.content);
    entries.push({
      path: file.path,
      topic: frontmatter.topic || file.path.replace(/\.md$/, '').split('/').pop(),
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.join(', ') : '',
      updated: frontmatter.updated || 'unknown',
      sync: frontmatter.sync !== false,
    });
  }

  // Build sync_order: preserve existing order, append new files alphabetically
  let syncOrder;
  if (existingSyncOrder) {
    const existing = existingSyncOrder.filter(p => entries.some(e => e.path === p));
    const newFiles = entries.filter(e => !existingSyncOrder.includes(e.path)).map(e => e.path).sort();
    syncOrder = [...existing, ...newFiles];
  } else {
    // Default order: context, projects, profiles, contacts, then alphabetical within each
    const dirOrder = ['context/', 'projects/', 'profiles/', 'contacts/'];
    syncOrder = [];
    for (const dir of dirOrder) {
      syncOrder.push(...entries.filter(e => e.path.startsWith(dir)).map(e => e.path).sort());
    }
    // Remaining files not in known directories
    const listed = new Set(syncOrder);
    syncOrder.push(...entries.filter(e => !listed.has(e.path)).map(e => e.path).sort());
  }

  // Build frontmatter
  const frontmatter = [
    '---',
    'version: 2',
    `file_count: ${entries.length}`,
    `last_updated: ${new Date().toISOString()}`,
    'sync_order:',
    ...syncOrder.map(p => `  - ${p}`),
    '---',
  ];

  // Group entries by directory
  const dirs = {};
  for (const entry of entries) {
    const dir = entry.path.includes('/') ? entry.path.split('/')[0] + '/' : '/';
    if (!dirs[dir]) dirs[dir] = [];
    dirs[dir].push(entry);
  }

  // Build markdown tables
  const sections = ['\n# Memory Index\n'];

  for (const [dir, dirEntries] of Object.entries(dirs).sort()) {
    sections.push(`## ${dir}\n`);
    sections.push('| File | Topic | Tags | Updated |');
    sections.push('|------|-------|------|---------|');

    for (const entry of dirEntries.sort((a, b) => a.path.localeCompare(b.path))) {
      const fileName = entry.path.split('/').pop();
      sections.push(`| ${fileName} | ${entry.topic} | ${entry.tags} | ${entry.updated} |`);
    }
    sections.push('');
  }

  return frontmatter.join('\n') + sections.join('\n');
}

/**
 * Parse sync_order from existing index.md content.
 * @param {string} indexContent
 * @returns {string[]}
 */
export function parseSyncOrder(indexContent) {
  const { frontmatter } = parse(indexContent);
  return frontmatter.sync_order || [];
}
