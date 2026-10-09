'use strict';
// Fleet PR C (ADR 0017, decision 7): the Arbiter suspends itself. An escaped defect traced to an
// endorsed ticket, or a send-back or escalation on one marked `criteria-defect`, writes
// state/flags/arbiter-suspended-<tenant> and pages the owner once. Only Cory removes the flag.
//
// Same evidence as the Bounded-authority scan (bin/bounded-authority.js), over endorsed tickets: an
// issue is endorsed when its triage ledger holds an `endorsed` or `endorsed-with-edits` row (the kinds
// bin/triage.js records). The criteria mark, the bug query, the page mechanism and the escape-line
// parsers are imported; the two evidence walks are bounded-authority's private functions, restated
// here over the endorsement time instead of a bounded ready.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WorkStateError, parseArgs, readEvents } = require('./work-state');
const { CRITERIA_MARK, queryEscapeBugs } = require('./bounded-authority');
const { parseEscapedFrom } = require('./weekly-scorecard');

const ENDORSED_KINDS = Object.freeze(['endorsed', 'endorsed-with-edits']);

function baseOf(root) { return path.resolve(root || path.resolve(__dirname, '..')); }
function triage() { return require('./triage'); }
function safeTenant(tenant) { return String(tenant || '').replace(/[^a-zA-Z0-9_.-]/g, '_'); }
function flagPath(root, tenant) { return path.join(baseOf(root), 'state', 'flags', `arbiter-suspended-${safeTenant(tenant)}`); }
// Evidence Cory has already ruled on by removing the flag: the same cause does not suspend twice. Under
// state/flags because the guard hook protects that directory from every session.
function ruledPath(root, tenant) { return path.join(baseOf(root), 'state', 'flags', `arbiter-ruled-${safeTenant(tenant)}.json`); }

function readJson(file, fallback) {
  try { const raw = fs.readFileSync(file, 'utf8'); return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch { return fallback; }
}

function isoOf(value) {
  const date = new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) throw new WorkStateError('TRIAGE_INVALID', 'now must be an ISO timestamp');
  return date.toISOString();
}

// issue number -> the ledger's earliest endorsement row for it.
function endorsedIssues(root, tenant) {
  const found = new Map();
  for (const entry of triage().readLedger(root, tenant)) {
    const number = Number(entry.issue);
    if (!ENDORSED_KINDS.includes(entry.kind) || !Number.isInteger(number) || found.has(number)) continue;
    found.set(number, entry);
  }
  return found;
}

function artifactHasCategory(root, relative, category) {
  if (!relative) return false;
  const base = path.resolve(root);
  const file = path.resolve(base, String(relative));
  if (file !== base && !file.startsWith(base + path.sep)) return false;
  const artifact = readJson(file, null);
  return Boolean(artifact && (artifact.findings || []).some((finding) => finding && finding.category === category));
}

// Escalations and send-backs after the endorsement, marked criteria-defect (the escalation reason, or
// a finding category in the review artifact the send-back followed). Free text is never read.
function criteriaEvidence({ root, tenant, endorsed, events }) {
  const found = [];
  for (const [issue, row] of endorsed) {
    const recordId = `${tenant}:issue-${issue}`;
    const since = new Date(row.at).getTime();
    const own = events.filter((event) => event.recordId === recordId && new Date(event.at).getTime() > since).sort((a, b) => a.sequence - b.sequence);
    let lastReview = null;
    for (const event of own) {
      if (event.type === 'review-recorded') lastReview = event;
      else if (event.type === 'state-escalated' && event.changes && event.changes.reason === CRITERIA_MARK) {
        found.push({ id: `escalation:${recordId}:${CRITERIA_MARK}`, at: event.at, issue, detail: `${recordId} escalated with reason ${CRITERIA_MARK}` });
      } else if (event.type === 'state-revision' && event.changes && event.changes.sendBack === true && lastReview && artifactHasCategory(root, lastReview.changes && lastReview.changes.artifact, CRITERIA_MARK)) {
        found.push({ id: `send-back:${recordId}:${lastReview.changes.artifact}`, at: event.at, issue, detail: `${recordId} sent back after a finding of category ${CRITERIA_MARK} in ${lastReview.changes.artifact}` });
      }
    }
  }
  return found;
}

// A bug's `Escaped from: #<PR>`: the form field first, else the newest proposal or Ruling's line.
function escapedPrOf(bug) {
  const form = parseEscapedFrom(bug.body);
  if (form !== null) return form;
  // bounded-authority.js's own reading (ruling M9): the newest proposal or Ruling's line, `(?:PR\s*)?#?(\d+)`.
  const headed = bug.comments.filter((comment) => /^\s*##\s*(?:Triage proposal|Ruling)\b/i.test(comment.body)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const newest = headed[headed.length - 1];
  const line = newest && /^Escaped from:[ \t]*(.*?)[ \t]*\r?$/im.exec(newest.body);
  const number = line && /(?:PR\s*)?#?(\d+)/i.exec(line[1]);
  return number ? Number(number[1]) : null;
}

function escapeEvidence({ tenant, endorsed, events, bugs }) {
  const prToIssue = new Map();
  for (const issue of endorsed.keys()) {
    for (const event of events) {
      const pr = event.recordId === `${tenant}:issue-${issue}` && event.changes && event.changes.prNumber;
      if (pr) prToIssue.set(Number(pr), issue);
    }
  }
  const oldest = Math.min(...[...endorsed.values()].map((row) => new Date(row.at).getTime()));
  const found = [];
  for (const bug of bugs) {
    if (!bug.labels.includes('bug') || Date.parse(bug.createdAt) < oldest) continue;
    const pr = escapedPrOf(bug);
    const issue = pr === null ? null : prToIssue.get(pr);
    if (!issue || issue === bug.number) continue;
    found.push({ id: `escape:${bug.number}:${pr}`, at: bug.createdAt, issue, detail: `bug #${bug.number} escaped from PR #${pr}, which delivered endorsed ticket #${issue}` });
  }
  return found;
}

function loadBugs({ tenantConfig, fixture, issues, runner }) {
  const { normalizeIssue } = triage();
  if (issues) return issues.map((entry) => normalizeIssue(entry));
  if (fixture) {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(fixture), 'utf8').replace(/^﻿/, ''));
    return (Array.isArray(parsed) ? parsed : parsed.issues || []).map((entry) => normalizeIssue(entry));
  }
  return queryEscapeBugs({ repo: tenantConfig.github, runner });
}

const messageOf = (error) => String((error && error.message) || error).split('\n')[0];

// Never throws on a failed read: what cannot be read is reported under issuesError and the rest is still scanned.
function arbiterScan({ root, tenant, tenantConfigPath, fixture, issues, now, runner = execFileSync, send } = {}) {
  if (!tenant) throw new WorkStateError('TRIAGE_INVALID', 'tenant is required');
  const at = isoOf(now);
  const errors = [];
  const attempt = (fallback, fn) => { try { return fn(); } catch (error) { errors.push(messageOf(error)); return fallback; } };
  const endorsed = attempt(new Map(), () => endorsedIssues(root, tenant));
  const note = () => (errors.length ? { issuesError: errors.join('; ') } : {});
  const result = { tenant, endorsed: endorsed.size, suspended: false, wrote: false, reason: null, issue: null };
  const file = flagPath(root, tenant);
  // A standing flag is the whole answer: nothing is written, nothing is paged, GitHub is not asked.
  if (fs.existsSync(file)) {
    const flag = readJson(file, {});
    return { ...result, suspended: true, reason: flag.reason || null, issue: flag.issue || null, ...note() };
  }
  if (!endorsed.size) return { ...result, ...note() };
  const tenantConfig = attempt(null, () => triage().readTenantConfig(root, tenant, tenantConfigPath));
  const events = attempt([], () => readEvents(baseOf(root)));
  const bugs = tenantConfig || issues || fixture ? attempt([], () => loadBugs({ tenantConfig, fixture, issues, runner })) : [];
  const ruled = new Set(readJson(ruledPath(root, tenant), []));
  const found = [
    ...attempt([], () => criteriaEvidence({ root: baseOf(root), tenant, endorsed, events })),
    ...attempt([], () => escapeEvidence({ tenant, endorsed, events, bugs })),
  ].filter((item) => !ruled.has(item.id)).sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
  if (!found.length) return { ...result, ...note() };

  const first = found[0];
  const url = tenantConfig && tenantConfig.github ? `https://github.com/${tenantConfig.github}/issues/${first.issue}` : undefined;
  // The flag first (fail closed), then the page, then the ruled-on ids; each step stands on its own.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, tenant, at, reason: first.detail, issue: first.issue, ...(url ? { url } : {}), evidenceIds: found.map((item) => item.id) }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return { ...result, suspended: true, reason: first.detail, issue: first.issue, ...note() };
    throw error;
  }
  const page = {
    kind: 'arbiter-suspended',
    title: `Fleet: ${tenant} Arbiter suspended`,
    body: `${first.detail}. The Arbiter posts no verdict until you remove state/flags/arbiter-suspended-${safeTenant(tenant)}; proposals wait for an Approval as before.`,
    priority: 'normal',
    ...(url ? { url } : {}),
  };
  let sent;
  try { sent = (send || require('./notify').pageSender({ root }))(page); } catch (error) { sent = { ok: false, detail: `send threw: ${messageOf(error)}` }; }
  try { fs.writeFileSync(ruledPath(root, tenant), `${JSON.stringify([...ruled, ...found.map((item) => item.id)])}
`, 'utf8'); } catch (error) { errors.push(`ruled-on ids not written: ${messageOf(error)}`); }
  const paged = Boolean(sent && sent.ok);
  return { ...result, suspended: true, wrote: true, reason: first.detail, issue: first.issue, paged, pageDetail: (sent && sent.detail) || null, ...note() };
}

// ------------------------------------------------------------------ CLI ----

const ARBITER_FLAGS = Object.freeze({ scan: ['root', 'tenant', 'tenant-config', 'fixture', 'now', 'json'] });
const ARBITER_USAGE = 'commands: scan (--tenant [--json])';

function cli(argv) {
  const [command, ...rest] = argv;
  const flags = ARBITER_FLAGS[command];
  if (!flags) throw new WorkStateError('USAGE', ARBITER_USAGE);
  const args = parseArgs(rest, flags);
  if (!args.tenant || args.tenant === 'true') throw new WorkStateError('USAGE', '--tenant is required');
  const fleetRoot = path.resolve(__dirname, '..');
  if ((args.fixture || args.now) && baseOf(args.root).toLowerCase() === fleetRoot.toLowerCase()) throw new WorkStateError('USAGE', '--fixture and --now are for a temp --root: on the fleet root a rehearsal would write a flag a live run honours');
  return arbiterScan({ root: args.root, tenant: args.tenant, tenantConfigPath: args['tenant-config'], fixture: args.fixture, now: args.now });
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: String(error.message || error) })}\n`);
    process.exitCode = error.code === 'USAGE' ? 2 : 1;
  }
}

module.exports = { ARBITER_FLAGS, ENDORSED_KINDS, arbiterScan, cli, flagPath };
