/**
 * Frontmatter validation for memory files.
 */

const REQUIRED_FIELDS = ['topic', 'created', 'updated'];

/**
 * Validate frontmatter against the PACK schema.
 * @param {object} frontmatter
 * @param {string} path - File path (for error messages)
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validate(frontmatter, path) {
  const errors = [];
  const warnings = [];

  for (const field of REQUIRED_FIELDS) {
    if (!frontmatter[field]) {
      errors.push(`${path}: missing required field "${field}"`);
    }
  }

  if (frontmatter.tags && !Array.isArray(frontmatter.tags)) {
    errors.push(`${path}: "tags" must be an array`);
  }

  if (!frontmatter.tags || (Array.isArray(frontmatter.tags) && frontmatter.tags.length === 0)) {
    warnings.push(`${path}: missing tags`);
  }

  if (frontmatter.sync !== undefined && typeof frontmatter.sync !== 'boolean') {
    errors.push(`${path}: "sync" must be a boolean`);
  }

  // Check TTL expiry
  if (frontmatter.ttl && frontmatter.updated) {
    const expired = isTTLExpired(frontmatter.ttl, frontmatter.updated);
    if (expired) {
      warnings.push(`${path}: EXPIRED (ttl: ${frontmatter.ttl}, last updated ${frontmatter.updated})`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Check if a TTL has expired relative to the updated date.
 * @param {string} ttl - e.g., "90d" or "2026-06-30"
 * @param {string} updated - ISO date string
 * @returns {boolean}
 */
export function isTTLExpired(ttl, updated) {
  const now = new Date();

  // Absolute date: "2026-06-30"
  if (/^\d{4}-\d{2}-\d{2}$/.test(ttl)) {
    return now > new Date(ttl);
  }

  // Relative days: "90d"
  const match = ttl.match(/^(\d+)d$/);
  if (match) {
    const days = parseInt(match[1], 10);
    const updatedDate = new Date(updated);
    const expiryDate = new Date(updatedDate.getTime() + days * 86400000);
    return now > expiryDate;
  }

  return false;
}
