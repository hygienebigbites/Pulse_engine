/**
 * In-memory job registry: one entry per /api/process request.
 *
 * Purpose:
 *  - give every processing request a job ID the caller can cancel,
 *  - refuse a second concurrent job for the same recording (duplicate guard,
 *    e.g. when Apps Script times out and a user clicks Process again while
 *    the first request is still running here),
 *  - cap how many jobs run at once (protects small/free hosting plans).
 *
 * State is deliberately in memory: jobs are short-lived (minutes) and the
 * Google Sheet is the durable record. A restart simply drops running jobs,
 * and their rows stay Pending/Error in the sheet for a re-run.
 */

const config = require('../config');

const jobs = new Map();          // jobId -> job
const cancelledEarly = new Map(); // jobId -> timestamp (cancel arrived before start)
const KEEP_FINISHED_MS = 60 * 60 * 1000;

class JobError extends Error {
  constructor(message, errorType, httpStatus) {
    super(message);
    this.errorType = errorType;
    this.httpStatus = httpStatus;
  }
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > KEEP_FINISHED_MS) jobs.delete(id);
  }
  for (const [id, ts] of cancelledEarly) {
    if (now - ts > KEEP_FINISHED_MS) cancelledEarly.delete(id);
  }
}

function runningJobs() {
  return [...jobs.values()].filter(j => !j.finishedAt);
}

function start(jobId, recordingUrl) {
  sweep();

  const duplicate = runningJobs().find(j => j.recordingUrl && j.recordingUrl === recordingUrl);
  if (duplicate) {
    throw new JobError(
      `This recording is already being processed (job ${duplicate.id}). Wait for it to finish or cancel it first.`,
      'duplicate',
      409
    );
  }
  if (runningJobs().length >= config.maxConcurrentJobs) {
    throw new JobError(
      `The backend is busy with ${config.maxConcurrentJobs} other job(s). Try again in a minute.`,
      'busy',
      429
    );
  }

  const controller = new AbortController();
  const job = {
    id: jobId,
    recordingUrl,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    controller,
  };
  jobs.set(jobId, job);

  if (cancelledEarly.has(jobId)) {
    cancelledEarly.delete(jobId);
    job.status = 'cancelling';
    controller.abort();
  }
  return job;
}

function finish(jobId, status) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = status;
  job.finishedAt = Date.now();
}

/**
 * Requests cancellation. Safe to call for unknown/finished jobs.
 * Returns { found, status }.
 */
function cancel(jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    cancelledEarly.set(jobId, Date.now());
    return { found: false, status: 'unknown (will be cancelled if it starts)' };
  }
  if (job.finishedAt) return { found: true, status: job.status };
  job.status = 'cancelling';
  job.controller.abort();
  return { found: true, status: 'cancelling' };
}

function get(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
  };
}

function stats() {
  return { running: runningJobs().length, maxConcurrent: config.maxConcurrentJobs };
}

module.exports = { start, finish, cancel, get, stats, JobError };
