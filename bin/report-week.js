'use strict';
// #131/#132: the reporting week. The weekly scorecard and the weekly second read both
// speak for the previous Monday-to-Sunday week, in UTC, relative to the moment they run:
// run on any day of week W, they report week W-1. The window is [start, end), `end` being
// the Monday that opens the current week; `label` names the Monday and the Sunday.

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function previousWeek(now) {
  const at = new Date(now || Date.now());
  if (Number.isNaN(at.getTime())) throw new Error(`previousWeek: unreadable time ${now}`);
  const daysSinceMonday = (at.getUTCDay() + 6) % 7;
  const thisMonday = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - daysSinceMonday);
  const start = thisMonday - 7 * DAY_MS;
  return {
    start: new Date(start).toISOString(),
    end: new Date(thisMonday).toISOString(),
    monday: isoDate(start),
    sunday: isoDate(thisMonday - DAY_MS),
    label: `${isoDate(start)}..${isoDate(thisMonday - DAY_MS)}`,
  };
}

function inWeek(week, timestamp) {
  const value = Date.parse(timestamp || '');
  return Number.isFinite(value) && value >= Date.parse(week.start) && value < Date.parse(week.end);
}

module.exports = { DAY_MS, inWeek, previousWeek };
