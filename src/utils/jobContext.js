/**
 * Per-job context (cooperative cancellation).
 *
 * A job's AbortController signal is stored in AsyncLocalStorage, so every
 * outbound HTTP call made while processing that job (SlashRTC, Deepgram,
 * Groq...) can be aborted by passing `signal: jobContext.signal()` to axios,
 * WITHOUT changing the signatures of the existing service functions (this
 * keeps the existing business logic untouched).
 */

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

class CancelledError extends Error {
  constructor(message = 'Job was cancelled.') {
    super(message);
    this.name = 'CancelledError';
    this.code = 'CANCELLED';
  }
}

function run(ctx, fn) {
  return storage.run(ctx, fn);
}

function current() {
  return storage.getStore() || null;
}

/** AbortSignal for the current job, or undefined outside a job. */
function signal() {
  const ctx = current();
  return ctx ? ctx.controller.signal : undefined;
}

function isCancelled() {
  const ctx = current();
  return Boolean(ctx && ctx.controller.signal.aborted);
}

/** Checkpoint: call between pipeline stages. */
function throwIfCancelled() {
  if (isCancelled()) throw new CancelledError();
}

/** Records WHICH step the job is on, so a timeout can say exactly where it hung. */
function setStage(label) {
  const ctx = current();
  if (ctx) ctx.stage = label;
}

function stage() {
  const ctx = current();
  return (ctx && ctx.stage) || null;
}

module.exports = { setStage, stage, run, current, signal, isCancelled, throwIfCancelled, CancelledError };
