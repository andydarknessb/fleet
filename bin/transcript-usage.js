'use strict';
// #201 (spec #191): the one transcript-usage reader. Claude Code writes one transcript row
// per content block of a single model response (thinking, text, each tool_use), and every
// row repeats the response's usage and carries the same `message.id`. Adding usage row by
// row counts a response once per block, about 2x. This reader keeps ONE usage per response
// id, so the collector (measure-cycle.js) and the Rotation and Budget sum
// (rotation-policy.js sumTranscriptTokens, used by budget.js) share one counting rule.
//
// What the rows look like (checked against real transcripts, #201): in a main-session
// transcript every row of an id carries identical usage. In a subagent transcript a
// streamed response's earlier rows can carry a smaller output_tokens (input and cache
// fields identical), the last row the final figure. So the response's usage is the largest
// value seen per field, which is the final figure and does not depend on row order.
//
// A row with no `message.id` cannot be attributed to a response: it is counted as one
// response of its own, as before, and counted in `usageRowsWithoutId` so an unknown
// transcript shape is visible rather than silently mis-counted.

const fs = require('node:fs');
const readline = require('node:readline');

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// `claimed` is an optional Map shared by the readers of one session's files (its own
// transcript and its subagents'). A response id already claimed by another reader is
// counted there, once, and skipped here: a fork or a shared row copies a response into a
// second file with the same message id, and counting it per file counts it twice.
function createUsageReader({ claimed = null } = {}) {
  const byResponse = new Map();
  const unkeyed = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  let usageRowsWithoutId = 0;
  const reader = {
    // Takes one parsed transcript row; a row with no usage adds nothing.
    add(row) {
      const usage = row && row.message && row.message.usage;
      if (!usage || typeof usage !== 'object') return;
      const figures = {
        inputTokens: asNumber(usage.input_tokens),
        outputTokens: asNumber(usage.output_tokens),
        cacheCreationInputTokens: asNumber(usage.cache_creation_input_tokens),
        cacheReadInputTokens: asNumber(usage.cache_read_input_tokens),
      };
      const id = row.message.id;
      if (!id) {
        usageRowsWithoutId += 1;
        for (const key of Object.keys(unkeyed)) unkeyed[key] += figures[key];
        return;
      }
      const seen = byResponse.get(id);
      if (!seen) {
        if (claimed) {
          const owner = claimed.get(id);
          if (owner && owner !== reader) return;
          claimed.set(id, reader);
        }
        byResponse.set(id, figures);
        return;
      }
      for (const key of Object.keys(figures)) seen[key] = Math.max(seen[key], figures[key]);
    },
    totals() {
      const totals = { ...unkeyed };
      for (const figures of byResponse.values()) {
        for (const key of Object.keys(totals)) totals[key] += figures[key];
      }
      totals.usageResponses = byResponse.size + usageRowsWithoutId;
      totals.usageRowsWithoutId = usageRowsWithoutId;
      return totals;
    },
  };
  return reader;
}

// Streamed: a long-lived project lead's transcript runs to tens of MB.
async function readTranscriptUsage(file) {
  const usage = createUsageReader();
  const reader = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.includes('"usage"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    usage.add(row);
  }
  return usage.totals();
}

// The day the meter became honest. Figures written before it read about 2x, so the scorecard
// and the budget summary carry this one line; the date is config/cycle.json
// `meterChange.date`, this is the fallback.
const DEFAULT_METER_CHANGE_DATE = '2026-09-30';

function meterChange(cycleConfig) {
  const configured = cycleConfig && cycleConfig.meterChange && cycleConfig.meterChange.date;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(configured || '')) ? String(configured) : DEFAULT_METER_CHANGE_DATE;
  return { date, note: `Token figures before ${date} read about 2x: each model response was counted once per transcript row until then (fleet #191).` };
}

module.exports = { DEFAULT_METER_CHANGE_DATE, createUsageReader, meterChange, readTranscriptUsage };
