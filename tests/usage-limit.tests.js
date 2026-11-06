'use strict';
// #388 (spec #382, ruling 6): the Usage limit reading. The claude CLI's stream carries the
// account-wide five-hour and weekly windows in a rate_limit_event line; bin/usage-limit.js turns
// that line into a reading, decides when the hourly probe is due and when a weekly window pages
// Cory, and keeps the readings. Red-tell: before bin/usage-limit.js nothing reads that line.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./temp-dir');
const { parseUsageReading, probeDue, pageDue, pageRecordAfter, loadLatestReading, loadUsageLimit, usageThrottle, cli, PAGE_AT } = require('../bin/usage-limit');

// The rate_limit_event captured 2026-11-06.
const SAMPLE = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793995200,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.05,"resetsAt":1793995200,"status":"allowed"},"seven_day":{"utilization":0.32,"resetsAt":1794290400,"status":"allowed"}}}}';
const AT = '2026-11-06T12:00:00.000Z';
const WEEK_A = 1794290400; // the sample's weekly resetsAt
const WEEK_B = 1794895200; // seven days later

// A reading as parseUsageReading returns it.
const reading = (utilization, resetsAt = WEEK_A, at = AT) => ({ fiveHour: { utilization: 0.05, resetsAt: 1793995200 }, weekly: { utilization, resetsAt }, status: 'allowed', at });
const withWeekly = (utilization) => SAMPLE.replace('"utilization":0.32', `"utilization":${utilization}`);

test('#388: the sample rate_limit_event reads as the five-hour and weekly windows, stamped with the probe time', () => {
  assert.deepEqual(parseUsageReading(SAMPLE, AT), {
    fiveHour: { utilization: 0.05, resetsAt: 1793995200 },
    weekly: { utilization: 0.32, resetsAt: 1794290400 },
    status: 'allowed',
    at: AT,
  });
});

test('#388: the parser takes the last complete rate_limit_event, skips lines that are not JSON, and reads CRLF streams', () => {
  const stream = ['{"type":"system","subtype":"init"}', 'warning: not json', withWeekly(0.1), '{"type":"assistant","message":{}}', '{"truncated":', SAMPLE, '{"type":"result","is_error":false}'].join('\r\n');
  assert.equal(parseUsageReading(stream, AT).weekly.utilization, 0.32);
});

test('#388: a later rate_limit_event missing seven_day does not hide the complete one before it', () => {
  const partial = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.07,"resetsAt":1793995200}}}}';
  const got = parseUsageReading([SAMPLE, partial].join('\n'), AT);
  assert.equal(got.weekly.utilization, 0.32);
  assert.equal(got.fiveHour.utilization, 0.05, 'the complete event, not the partial one after it');
});

test('#388: a stream with no rate_limit_event is a clear error, malformed lines included', () => {
  for (const stream of ['{"type":"result","is_error":false}\n{"type":"assistant"}', 'not json\n{"broken":', '']) {
    assert.throws(() => parseUsageReading(stream, AT), (error) => error.code === 'NO_RATE_LIMIT_EVENT' && /no rate_limit_event/.test(error.message));
  }
});

test('#388: an event without both windows, or with a window that is not a number, is an error and not a reading', () => {
  const fiveOnly = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.05,"resetsAt":1793995200}}}}';
  const textual = SAMPLE.replace('"utilization":0.32', '"utilization":"0.32"');
  for (const stream of [fiveOnly, textual]) {
    assert.throws(() => parseUsageReading(stream, AT), { code: 'NO_WINDOWS' });
  }
});

test('#388: the probe is due with no reading, at 55 minutes or more, or when the reading is unreadable or ahead of the clock', () => {
  const ago = (minutes) => ({ at: new Date(Date.parse(AT) - minutes * 60000).toISOString() });
  assert.equal(probeDue(null, AT), true);
  assert.equal(probeDue(ago(54), AT), false);
  assert.equal(probeDue(ago(55), AT), true);
  assert.equal(probeDue(ago(130), AT), true);
  assert.equal(probeDue({ at: 'yesterday' }, AT), true);
  assert.equal(probeDue({ at: new Date(Date.parse(AT) + 60000).toISOString() }, AT), true);
});

test('#388: a weekly window at 80% or more pages; a window below 80% never does', () => {
  assert.equal(PAGE_AT, 0.8);
  assert.equal(pageDue(reading(0.79), null), false);
  assert.equal(pageDue(reading(0.8), null), true);
  assert.equal(pageDue(null, null), false);
});

test('#388: a paged window does not page again, a new weekly window does, and an undelivered page is retried up to three attempts', () => {
  const paged = { weeklyResetsAt: WEEK_A, delivered: true, attempts: 1, at: AT };
  assert.equal(pageDue(reading(0.95), paged), false);
  assert.equal(pageDue(reading(0.82, WEEK_B), paged), true);
  const undelivered = { weeklyResetsAt: WEEK_A, delivered: false, attempts: 2, at: AT };
  assert.equal(pageDue(reading(0.85), undelivered), true);
  assert.equal(pageDue(reading(0.85), { ...undelivered, attempts: 3 }), false);
});

test('#388: across hourly readings each weekly window pages exactly once', () => {
  const pages = [];
  let record = null;
  for (const [resetsAt, utilization] of [[WEEK_A, 0.79], [WEEK_A, 0.82], [WEEK_A, 0.85], [WEEK_A, 0.9], [WEEK_B, 0.1], [WEEK_B, 0.81], [WEEK_B, 0.84]]) {
    const next = reading(utilization, resetsAt);
    if (pageDue(next, record)) {
      pages.push(resetsAt);
      record = pageRecordAfter(record, next, true, AT);
    }
  }
  assert.deepEqual(pages, [WEEK_A, WEEK_B]);
});

test('#388: a page attempt counts against its own weekly window and records whether it was delivered', () => {
  const first = pageRecordAfter(null, reading(0.85), false, AT);
  assert.deepEqual(first, { weeklyResetsAt: WEEK_A, delivered: false, attempts: 1, at: AT });
  const second = pageRecordAfter(first, reading(0.86), true, AT);
  assert.deepEqual(second, { weeklyResetsAt: WEEK_A, delivered: true, attempts: 2, at: AT });
  assert.equal(pageRecordAfter(second, reading(0.82, WEEK_B), false, AT).attempts, 1, 'a new window starts its count at one');
});

test('#388: the loader returns the latest reading, or null when there is none or the file is torn', () => {
  const root = makeTempDir('fleet-usage-');
  assert.equal(loadLatestReading(root), null);
  fs.mkdirSync(path.join(root, 'state', 'usage'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'usage', 'latest.json'), '{"weekly":');
  assert.equal(loadLatestReading(root), null, 'a torn file is no reading');
  fs.writeFileSync(path.join(root, 'state', 'usage', 'latest.json'), JSON.stringify(reading(0.32)));
  assert.deepEqual(loadLatestReading(root), reading(0.32));
});

test('#388: record stores the reading as latest and in the history, and says whether its window pages', () => {
  const root = makeTempDir('fleet-usage-');
  const history = path.join(root, 'state', 'usage', 'readings.jsonl');
  const first = cli(['record', root, AT], () => withWeekly(0.84));
  assert.equal(first.reading.weekly.utilization, 0.84);
  assert.equal(first.pageDue, true);
  assert.deepEqual(loadLatestReading(root), first.reading);
  assert.equal(fs.readFileSync(history, 'utf8').trim().split('\n').length, 1);
  assert.equal(cli(['page-attempt', root, 'true', AT]).delivered, true);
  const later = cli(['record', root, '2026-11-06T13:00:00.000Z'], () => withWeekly(0.86));
  assert.equal(later.pageDue, false, 'the window that paged does not page again');
  assert.equal(fs.readFileSync(history, 'utf8').trim().split('\n').length, 2);
  assert.throws(() => cli(['nope', root]), { code: 'USAGE' });
});

test('#388: a stream without the event stores nothing, and due follows the latest reading', () => {
  const root = makeTempDir('fleet-usage-');
  assert.throws(() => cli(['record', root, AT], () => 'no event here'), { code: 'NO_RATE_LIMIT_EVENT' });
  assert.equal(loadLatestReading(root), null);
  assert.deepEqual(cli(['due', root, AT]), { due: true });
  cli(['record', root, AT], () => SAMPLE);
  assert.deepEqual(cli(['due', root, '2026-11-06T12:54:00.000Z']), { due: false });
  assert.deepEqual(cli(['due', root, '2026-11-06T12:55:00.000Z']), { due: true });
});

test('#388: a failed probe counts as an attempt, so the next probe waits the hour from it', () => {
  const root = makeTempDir('fleet-usage-');
  cli(['record', root, '2026-11-06T10:00:00.000Z'], () => SAMPLE); // a reading two hours old
  cli(['attempt', root, AT]); // the probe that failed, at 12:00
  assert.deepEqual(cli(['due', root, '2026-11-06T12:54:00.000Z']), { due: false });
  assert.deepEqual(cli(['due', root, '2026-11-06T12:55:00.000Z']), { due: true });
});

// #389 (spec #382, ruling 6, ADR 0018): the weekly hold on new IC launches, by Tenant order. The limit is
// the ruling's; the readings are the recorded sample at a set utilization and reset.
const LIMIT = { tenantOrder: ['statelite', 'endzone', 'nidus'], lowerTenantsAt: 0.85, allTenantsAt: 0.9 };

test('#389: below 85% weekly no Tenant is held', () => {
  for (const tenant of ['statelite', 'endzone', 'nidus']) {
    assert.equal(usageThrottle({ reading: reading(0.84), tenant, limit: LIMIT, now: AT }), null, tenant);
  }
});

test('#389: at 85% weekly every Tenant but the first in the order is held, and the reason names the threshold and the reading', () => {
  assert.equal(usageThrottle({ reading: reading(0.85), tenant: 'statelite', limit: LIMIT, now: AT }), null);
  for (const tenant of ['endzone', 'nidus', 'test']) {
    const hold = usageThrottle({ reading: reading(0.85), tenant, limit: LIMIT, now: AT });
    assert.equal(hold.code, 'usage-throttle', tenant);
    assert.equal(hold.threshold, 0.85, tenant);
    assert.match(hold.reason, /weekly utilization 0\.85 is at or above the 85% threshold for every Tenant but statelite; new IC launches are held until the weekly reset at 2026-11-10T06:00:00\.000Z/, tenant);
  }
});

test('#389: at 90% weekly every Tenant is held, the first included', () => {
  for (const tenant of ['statelite', 'endzone', 'nidus']) {
    const hold = usageThrottle({ reading: reading(0.9), tenant, limit: LIMIT, now: AT });
    assert.equal(hold.threshold, 0.9, tenant);
    assert.match(hold.reason, /90% threshold for every Tenant;/, tenant);
  }
});

test('#389: a reading whose weekly window has reset is stale and holds nothing, and the reset instant lifts a hold', () => {
  assert.equal(usageThrottle({ reading: reading(0.95, 1793000000), tenant: 'nidus', limit: LIMIT, now: AT }), null);
  assert.equal(usageThrottle({ reading: reading(0.95, WEEK_A), tenant: 'nidus', limit: LIMIT, now: '2026-11-10T06:00:00.000Z' }), null);
  assert.ok(usageThrottle({ reading: reading(0.95, WEEK_A), tenant: 'nidus', limit: LIMIT, now: '2026-11-10T05:59:59.000Z' }));
});

test('#389: a weekly reset more than 8 days out holds nothing: a millisecond-scale resetsAt, or a reset 30 days out', () => {
  assert.equal(usageThrottle({ reading: reading(0.95, 1794290400000), tenant: 'nidus', limit: LIMIT, now: AT }), null, 'a millisecond-scale resetsAt');
  assert.equal(usageThrottle({ reading: reading(0.95, Date.parse(AT) / 1000 + 30 * 86400), tenant: 'nidus', limit: LIMIT, now: AT }), null, 'a reset 30 days out');
  assert.ok(usageThrottle({ reading: reading(0.95, Date.parse(AT) / 1000 + 8 * 86400), tenant: 'nidus', limit: LIMIT, now: AT }), 'a reset exactly 8 days out still holds');
});

test('#389: no reading, a reading that cannot be read, no limit, no first Tenant or no clock holds nothing (fail open)', () => {
  assert.equal(usageThrottle({ reading: null, tenant: 'nidus', limit: LIMIT, now: AT }), null);
  assert.equal(usageThrottle({ reading: { weekly: { utilization: 'high', resetsAt: WEEK_A } }, tenant: 'nidus', limit: LIMIT, now: AT }), null);
  assert.equal(usageThrottle({ reading: { weekly: { utilization: 0.95 } }, tenant: 'nidus', limit: LIMIT, now: AT }), null, 'no reset time: the reading cannot be shown live');
  assert.equal(usageThrottle({ reading: reading(0.95), tenant: 'nidus', limit: null, now: AT }), null);
  assert.equal(usageThrottle({ reading: reading(0.95), tenant: 'nidus', limit: { ...LIMIT, tenantOrder: [] }, now: AT }), null, 'no first Tenant to exempt: nothing is held');
  assert.equal(usageThrottle({ reading: reading(0.95), tenant: 'nidus', limit: LIMIT, now: 'not a time' }), null);
});

test('#389: the throttle command answers the door with the hold or null, and loadUsageLimit reads config/cycle.json', () => {
  const root = makeTempDir('fleet-usage-');
  assert.equal(loadUsageLimit(root), null);
  assert.deepEqual(cli(['throttle', root, 'nidus', AT]), { throttle: null }, 'no reading, no hold');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'cycle.json'), JSON.stringify({ usageLimit: LIMIT }));
  cli(['record', root, AT], () => withWeekly(0.9));
  assert.deepEqual(loadUsageLimit(root), LIMIT);
  const answer = cli(['throttle', root, 'nidus', AT]);
  assert.equal(answer.throttle.threshold, 0.9);
  assert.match(answer.throttle.reason, /weekly utilization 0\.9 is at or above the 90% threshold/);
  assert.equal(cli(['throttle', root, 'statelite', AT]).throttle.threshold, 0.9, 'at 90% the first Tenant is held too');
});

test('#389: the shipped config carries the ruling: statelite, then endzone, then nidus; 85% for all but the first, 90% for all', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'cycle.json'), 'utf8'));
  assert.deepEqual(shipped.usageLimit, LIMIT);
});
