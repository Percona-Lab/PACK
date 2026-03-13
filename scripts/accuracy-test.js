#!/usr/bin/env node

/**
 * PACK accuracy test — captures baseline metrics from v1 memory,
 * then verifies v2 migration preserved all content.
 *
 * Usage:
 *   node scripts/accuracy-test.js baseline    # Run before migration
 *   node scripts/accuracy-test.js verify      # Run after migration
 */

import { join } from 'path';
import { homedir } from 'os';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';
import { GitHubConnector } from '../connectors/github.js';
import { MemoryCore } from '../core/memory.js';
import { parse } from '../core/frontmatter.js';
import crypto from 'crypto';

dotenv.config({ path: join(homedir(), '.pack.env'), override: true });

const BASELINE_PATH = join(homedir(), '.pack-test-baseline.json');

const github = new GitHubConnector(
  process.env.GITHUB_TOKEN,
  process.env.GITHUB_OWNER,
  process.env.GITHUB_REPO,
  process.env.GITHUB_MEMORY_PATH || 'MEMORY.md'
);
const core = new MemoryCore(github);

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function extractHeadings(content) {
  return content.split('\n').filter(l => l.startsWith('## ')).map(l => l.slice(3).trim());
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function lineCount(text) {
  return text.split('\n').length;
}

async function baseline() {
  console.log('=== PACK Pre-Migration Baseline ===\n');

  const mode = await core.detectMode();
  console.log(`Mode: ${mode}`);

  const memory = await github.getMemory();
  const content = memory.content;

  const headings = extractHeadings(content);
  const words = wordCount(content);
  const lines = lineCount(content);
  const contentHash = hash(content);

  // Extract unique non-empty lines for content verification
  const significantLines = content.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 10)
    .filter(l => !l.startsWith('#'));

  const baselineData = {
    mode,
    timestamp: new Date().toISOString(),
    sha: memory.sha,
    contentHash,
    headings,
    headingCount: headings.length,
    wordCount: words,
    lineCount: lines,
    charCount: content.length,
    significantLineCount: significantLines.length,
    // Store a sample of lines to verify content presence
    sampleLines: significantLines.filter((_, i) => i % 5 === 0).slice(0, 50),
  };

  writeFileSync(BASELINE_PATH, JSON.stringify(baselineData, null, 2));

  console.log(`Headings:      ${headings.length}`);
  console.log(`Words:         ${words}`);
  console.log(`Lines:         ${lines}`);
  console.log(`Characters:    ${content.length}`);
  console.log(`Content SHA:   ${contentHash.slice(0, 16)}...`);
  console.log(`Sig. lines:    ${significantLines.length}`);
  console.log(`Sample lines:  ${baselineData.sampleLines.length}`);
  console.log(`\nHeadings:`);
  for (const h of headings) console.log(`  - ${h}`);
  console.log(`\nBaseline saved to ${BASELINE_PATH}`);
}

async function verify() {
  console.log('=== PACK Post-Migration Verification ===\n');

  if (!existsSync(BASELINE_PATH)) {
    console.error('No baseline found. Run: node scripts/accuracy-test.js baseline');
    process.exit(1);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  const mode = await core.detectMode();
  console.log(`Mode: ${mode} (was: ${baseline.mode})`);

  let passed = 0;
  let failed = 0;

  function check(name, condition, detail = '') {
    if (condition) {
      console.log(`  PASS: ${name}${detail ? ' — ' + detail : ''}`);
      passed++;
    } else {
      console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`);
      failed++;
    }
  }

  // Test 1: Mode should be v2 after migration
  check('Mode is v2', mode === 'v2');

  // Test 2: Legacy file preserved
  const legacy = await github.getContents('legacy/MEMORY.md');
  check('legacy/MEMORY.md exists', !!legacy);
  if (legacy) {
    check('Legacy content matches original', hash(legacy.content) === baseline.contentHash);
  }

  // Test 3: Index exists
  const index = await github.getContents('index.md');
  check('index.md exists', !!index);

  // Test 4: memory_list works
  const listResult = await core.list();
  check('memory_list returns content', listResult.content && listResult.content.length > 0);

  // Test 5: All headings became files
  const tree = await github.getTree();
  const mdFiles = tree.filter(f =>
    f.path.endsWith('.md') && f.path !== 'index.md' && !f.path.startsWith('legacy/') && f.path.includes('/')
  );
  check('File count matches heading count', mdFiles.length === baseline.headingCount,
    `${mdFiles.length} files vs ${baseline.headingCount} headings`);

  // Test 6: Concatenated view preserves content
  const concat = await core.get(); // no path = concatenated view
  const concatWords = wordCount(concat.content);
  const wordDiff = Math.abs(concatWords - baseline.wordCount);
  const wordThreshold = baseline.wordCount * 0.05; // 5% tolerance for section headers added
  check('Word count within 5% of original', wordDiff <= wordThreshold,
    `${concatWords} vs ${baseline.wordCount} (diff: ${wordDiff})`);

  // Test 7: Sample lines are present in v2 content
  const allContent = concat.content.toLowerCase();
  let sampleHits = 0;
  for (const line of baseline.sampleLines) {
    if (allContent.includes(line.toLowerCase())) sampleHits++;
  }
  const samplePct = Math.round((sampleHits / baseline.sampleLines.length) * 100);
  check('Sample lines present (>95%)', samplePct >= 95,
    `${sampleHits}/${baseline.sampleLines.length} (${samplePct}%)`);

  // Test 8: Search still works
  const searchResult = await core.search('PACK');
  check('Search returns results', searchResult.results.length > 0,
    `${searchResult.results.length} results for "PACK"`);

  // Test 9: Each file has valid frontmatter
  let fmValid = 0;
  for (const f of mdFiles) {
    const data = await github.getContents(f.path);
    if (data) {
      const { frontmatter } = parse(data.content);
      if (frontmatter.topic && frontmatter.created && frontmatter.updated) fmValid++;
    }
  }
  check('All files have valid frontmatter', fmValid === mdFiles.length,
    `${fmValid}/${mdFiles.length}`);

  // Test 10: Sync content works
  const syncContent = await core.getSyncContent();
  check('Sync content is non-empty', syncContent.length > 0, `${syncContent.length} chars`);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

const cmd = process.argv[2];
if (cmd === 'baseline') {
  baseline().catch(err => { console.error(err); process.exit(1); });
} else if (cmd === 'verify') {
  verify().catch(err => { console.error(err); process.exit(1); });
} else {
  console.log('Usage: node scripts/accuracy-test.js [baseline|verify]');
}
