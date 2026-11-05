/**
 * FIFO raw-import scheduler. ProjectRepository owns staged bytes and the durable journal.
 * ponytail: single-file staging only; batch/retry/parser workers and staging GC remain future work.
 */

const crypto = require('node:crypto');
const { ProjectStorageError } = require('../storage/projectRepository.cjs');

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const ACTIVE_STATUSES = new Set(['queued', 'running']);
// Renderer observation is deliberately bounded: it is not a journal/DB query API.
const MAX_LISTED_IMPORT_JOBS = 25;

const displayNameFor = job => {
  const candidate = typeof job.originalName === 'string'
    ? job.originalName
    : typeof job.draft?.metadata?.originalName === 'string'
      ? job.draft.metadata.originalName
      : job.assetId;
  // Do not surface a caller-provided native path as UI text.
  const basename = candidate.split(/[\\/]/).filter(Boolean).at(-1);
  return basename || job.assetId;
};

class ImportCancelledError extends Error {
  constructor() {
    super('import job cancelled');
    this.name = 'ImportCancelledError';
  }
}

const snapshot = job => ({
  id: job.id,
  assetId: job.assetId,
  displayName: displayNameFor(job),
  status: job.status,
  progress: job.progress,
  errorCode: job.errorCode || null,
  result: job.result ? {
    asset: { ...job.result.asset, locator: { ...job.result.asset.locator }, metadata: { ...job.result.asset.metadata } },
    contentHash: job.result.contentHash,
    byteSize: job.result.byteSize,
  } : null,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
});

const runtimeJob = record => ({
  id: record.id,
  assetId: record.assetId,
  draft: record.draft,
  originalName: record.originalName,
  status: record.status,
  progress: record.progress,
  errorCode: record.errorCode || null,
  result: record.result ? {
    asset: record.result.asset,
    contentHash: record.result.contentHash,
    byteSize: record.result.byteSize,
  } : null,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  cancelRequested: false,
});

class AssetImportController {
  constructor({ repository } = {}) {
    if (!repository) throw new ProjectStorageError('import controller requires a project repository');
    this.repository = repository;
    this.jobs = new Map();
    this.queue = [];
    this.activeJobId = null;
    this.draining = false;
    this.restored = false;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) throw new ProjectStorageError('import controller is closed');
  }

  /** Rehydrate durable intent; stale running work is reset in the repository before it is requeued. */
  restore() {
    this.#assertOpen();
    if (this.restored) return;
    for (const record of this.repository.recoverImportJobs()) {
      const job = runtimeJob(record);
      this.jobs.set(job.id, job);
      if (job.status === 'queued') this.queue.push(job.id);
    }
    this.restored = true;
    void this.#drain();
  }

  #persist(job) {
    const stored = this.repository.updateImportJob({
      id: job.id,
      status: job.status,
      progress: job.progress,
      errorCode: job.errorCode || null,
      result: job.result,
    });
    job.status = stored.status;
    job.progress = stored.progress;
    job.errorCode = stored.errorCode;
    job.result = stored.result;
    job.createdAt = stored.createdAt;
    job.updatedAt = stored.updatedAt;
  }

  /** A bounded, presentation-safe view; private draft/staging fields never leave this controller. */
  listJobs() {
    this.#assertOpen();
    this.restore();
    const active = [];
    const terminal = [];
    for (const job of this.jobs.values()) {
      if (ACTIVE_STATUSES.has(job.status)) active.push(job);
      else terminal.push(job);
    }
    // Active work retains durable FIFO order. Terminal history is newest-first only after active work.
    terminal.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
      || (b.createdAt ?? 0) - (a.createdAt ?? 0)
      || a.id.localeCompare(b.id));
    return [...active, ...terminal].slice(0, MAX_LISTED_IMPORT_JOBS).map(snapshot);
  }

  async requestImport({ asset, bytes, originalName } = {}) {
    this.#assertOpen();
    this.restore();
    const job = runtimeJob(await this.repository.stageImport({
      id: crypto.randomUUID(),
      asset,
      bytes,
      originalName,
    }));
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    void this.#drain();
    return snapshot(job);
  }

  getJob(jobId) {
    this.#assertOpen();
    this.restore();
    const job = this.jobs.get(jobId);
    return job ? snapshot(job) : null;
  }

  cancelJob(jobId) {
    this.#assertOpen();
    this.restore();
    const job = this.jobs.get(jobId);
    if (!job) throw new ProjectStorageError(`unknown import job: ${jobId}`);
    if (TERMINAL_STATUSES.has(job.status)) return snapshot(job);
    job.cancelRequested = true;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.errorCode = null;
      this.#persist(job);
    }
    // A running fs commit has no safe forced interruption point; #run checks before promotion.
    return snapshot(job);
  }

  async #run(job) {
    if (job.cancelRequested) throw new ImportCancelledError();
    if (this.closed) return;
    job.status = 'running';
    job.progress = 0.05;
    job.errorCode = null;
    this.#persist(job);
    const bytes = await this.repository.readImportJobBytes(job.id);
    if (job.cancelRequested) throw new ImportCancelledError();
    if (this.closed) return;
    const result = await this.repository.putAsset({
      asset: job.draft,
      bytes,
      originalName: job.originalName,
    });
    // Once putAsset returns, an original+metadata commit exists; report completion rather than fake cancellation.
    if (this.closed) return;
    job.result = result;
    job.status = 'completed';
    job.progress = 1;
    job.errorCode = null;
    this.#persist(job);
  }

  async #drain() {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        const job = this.jobs.get(this.queue.shift());
        if (!job || job.status === 'cancelled') continue;
        this.activeJobId = job.id;
        try {
          await this.#run(job);
        } catch (error) {
          // Closing is interruption, not user cancellation. Preserve journal state for project reopen.
          if (this.closed) {
            // no durable mutation
          } else if (error instanceof ImportCancelledError || job.cancelRequested) {
            job.status = 'cancelled';
            job.errorCode = null;
            this.#persist(job);
          } else {
            job.status = 'failed';
            job.errorCode = 'STORAGE_ERROR';
            this.#persist(job);
          }
        } finally {
          this.activeJobId = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    // Do not persist cancellation: queued/running records are intentionally recovered on next project open.
  }
}

module.exports = {
  AssetImportController,
  MAX_LISTED_IMPORT_JOBS,
};
