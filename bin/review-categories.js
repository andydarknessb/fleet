'use strict';
// #218 (spec #195): the weekly review-category notice. For the previous Monday-to-Sunday
// UTC week (bin/report-week.js) it reads every formal review recorded in the week
// (`review-recorded` events, kind `formal`; risk reviews are the IC's own and not counted),
// counts the categories of the findings each artifact recorded (every finding carries a
// kebab-case category, bin/review-policy.js), and writes the top three as ONE dated
// paragraph on the IC board, state/notices/ic.md, which hooks/session-start.ps1 already
// injects for an IC. The paragraph carries `[until YYYY-MM-DD]`, one week past the run,
// the expiry session start already honours; a rerun or the next week's run replaces it.
//
// A finding a re-review carried forward (`carriedFrom`) was counted when it was first
// found and is not counted again. Severity is not weighed: a category reviewers keep
// flagging as a nit is still a self-check item. Ties in count break by category name,
// alphabetically (plain code-unit order), so the same week always reads the same. A week
// with no finding removes the paragraph and writes none. Paragraphs other than its own
// (the ones starting with the marker below) are kept as they are. `--dry-run` computes
// the notice without touching the board. Scheduled weekly, Mondays, like the scorecard
// (bin/install-weekly-review-categories-task.ps1).

const fs = require('node:fs');
const path = require('node:path');
const workState = require('./work-state');
const { DAY_MS, inWeek, previousWeek } = require('./report-week');

class ReviewCategoriesError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReviewCategoriesError';
    this.code = code;
    Object.assign(this, details);
  }
}

const REVIEW_CATEGORY_FLAGS = ['root', 'now', 'dry-run'];
const TOP = 3;
const NOTICE_LIFE_DAYS = 7;
// What every notice this script writes starts with; it is how a rerun finds its own.
const MARKER = 'Review categories, week ';

function baseOf(root) { return path.resolve(root || path.join(__dirname, '..')); }
function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch { return fallback; }
}

// The findings of one week's formal reviews, as `{ category }` rows.
function weekFindings(base, week) {
  const findings = [];
  const errors = [];
  let reviews = 0;
  const seen = new Set();
  for (const event of workState.readEvents(base)) {
    if (event.type !== 'review-recorded' || event.changes?.kind !== 'formal' || !inWeek(week, event.at)) continue;
    const relative = String(event.changes.artifact || '');
    if (!relative || seen.has(relative)) continue;
    seen.add(relative);
    const artifact = readJson(path.join(base, relative), null);
    if (!artifact || !Array.isArray(artifact.findings)) { errors.push(`${relative}: artifact unreadable or has no findings list`); continue; }
    reviews += 1;
    for (const finding of artifact.findings) {
      if (finding && finding.carriedFrom) continue;
      if (!finding || typeof finding.category !== 'string' || !finding.category.trim()) continue;
      findings.push({ category: finding.category.trim() });
    }
  }
  return { findings, reviews, errors };
}

function topCategories(findings, top = TOP) {
  const counts = new Map();
  for (const { category } of findings) counts.set(category, (counts.get(category) || 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0))
    .slice(0, top);
}

function renderNotice(week, top, now) {
  const until = new Date(Date.parse(now) + NOTICE_LIFE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const list = top.map((t) => `${t.category} (${t.count})`).join(', ');
  return `${MARKER}${week.label} (fleet #218): the categories reviewers flagged most in formal reviews were ${list}. Check your own diff against these before you mark it ready. [until ${until}]`;
}

function noticePath(base) { return path.join(base, 'state', 'notices', 'ic.md'); }

// The board with this script's own paragraph replaced by `notice` (or dropped when null).
function replaceOwnParagraph(text, notice) {
  const kept = String(text || '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !p.startsWith(MARKER));
  if (notice) kept.push(notice);
  return kept.length ? `${kept.join('\n\n')}\n` : '';
}

function writeBoard(base, next) {
  const file = noticePath(base);
  if (!next && !fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, next, 'utf8');
  fs.renameSync(temp, file);
}

function writeReviewCategoryNotice({ root, now, dryRun = false } = {}) {
  const base = baseOf(root);
  const at = now || new Date().toISOString();
  const week = previousWeek(at);
  const { findings, reviews, errors } = weekFindings(base, week);
  const top = topCategories(findings);
  const board = noticePath(base);
  const existing = fs.existsSync(board) ? fs.readFileSync(board, 'utf8') : '';
  if (!top.length) {
    if (!dryRun) writeBoard(base, replaceOwnParagraph(existing, null));
    return { outcome: 'no-findings', week, reviews, top, errors, message: `no findings in ${week.label} across ${reviews} formal reviews; no notice written` };
  }
  const notice = renderNotice(week, top, at);
  if (dryRun) return { outcome: 'would-write', week, reviews, top, errors, notice };
  writeBoard(base, replaceOwnParagraph(existing, notice));
  return { outcome: 'written', week, reviews, top, errors, notice, file: board };
}

function cli(argv) {
  let args;
  try {
    args = workState.parseArgs(argv, REVIEW_CATEGORY_FLAGS);
  } catch (error) {
    if (error.code === 'USAGE') throw new ReviewCategoriesError('USAGE', error.message, { flag: error.flag, accepted: error.accepted });
    throw error;
  }
  return writeReviewCategoryNotice({ root: args.root, now: args.now, dryRun: args['dry-run'] === 'true' });
}

if (require.main === module) {
  try {
    const result = cli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ outcome: result.outcome, week: result.week.label, reviews: result.reviews, top: result.top, errors: result.errors, message: result.message || null })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: String(error.message || error) })}\n`);
    process.exitCode = error.code === 'USAGE' ? 2 : 1;
  }
}

module.exports = { MARKER, REVIEW_CATEGORY_FLAGS, ReviewCategoriesError, cli, renderNotice, topCategories, writeReviewCategoryNotice };
