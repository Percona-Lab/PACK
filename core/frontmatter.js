/**
 * YAML frontmatter parser/serializer for memory files.
 * Minimal implementation — no external YAML dependency.
 * Handles the subset of YAML used in PACK frontmatter.
 */

/**
 * Parse a markdown file with YAML frontmatter.
 * @param {string} text - Full file content
 * @returns {{ frontmatter: object, body: string }}
 */
export function parse(text) {
  if (!text || !text.startsWith('---')) {
    return { frontmatter: {}, body: text || '' };
  }

  const endIndex = text.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: text };
  }

  const yamlBlock = text.slice(4, endIndex).trim();
  const body = text.slice(endIndex + 4).replace(/^\n/, '');
  const frontmatter = {};

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Array: [item1, item2]
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim());
    }
    // Boolean
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    // Null
    else if (value === 'null' || value === '') value = null;
    // Number (but not dates like 2026-03-13)
    else if (/^\d+$/.test(value)) value = parseInt(value, 10);

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

/**
 * Serialize frontmatter object + body into a markdown file.
 * @param {object} frontmatter
 * @param {string} body
 * @returns {string}
 */
export function serialize(frontmatter, body) {
  const lines = ['---'];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined) {
      lines.push(`${key}: null`);
    } else if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`);
    } else if (typeof value === 'boolean') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push('---');
  lines.push('');

  const content = body.startsWith('\n') ? body.slice(1) : body;
  return lines.join('\n') + content;
}
