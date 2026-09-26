import { AsyncLocalStorage } from 'node:async_hooks';
import { estimateCost } from './models.mjs';

// Attributes every model and voice call to the run that caused it, for per-run cost reporting.
// A step calls enterUsage({ ownerId, kind, id }) once; provider calls below it record themselves.
const context = new AsyncLocalStorage();
let sink = null;

export function enterUsage(ref) { if (ref?.ownerId) context.enterWith(ref); }
export function currentUsage() { return context.getStore() || null; }
export function setUsageSink(fn) { sink = fn; }

const count = value => Number(value?.total ?? value) || 0;

export function recordUsage(entry) {
  const ref = currentUsage();
  if (!ref || !sink) return;
  const row = { ...ref, feature: entry.feature || '', model: entry.model || '', inputTokens: count(entry.inputTokens), outputTokens: count(entry.outputTokens), characters: count(entry.characters) };
  row.costUsd = estimateCost(row);
  Promise.resolve(sink(row)).catch(() => {});
}
