/**
 * FIFO one-worker derivative controller. ProjectRepository owns the durable job journal.
 * ponytail: queued/running intent survives restart; retry policy, priority and multi-worker scheduling remain future work.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ProjectStorageError } = require('../storage/projectRepository.cjs');

const PREVIEW_RECIPE = 'preview-card-v1';
const PREVIEW_MIME_TYPE = 'image/svg+xml';
const MAX_PREVIEW_INPUT_BYTES = 64 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);

class JobCancelledError extends Error {
  constructor() {
    super('preview job cancelled');
    this.name = 'JobCancelledError';
  }
}

const snapshot = job => ({
  id: job.id,
  assetId: job.assetId,
  recipe: job.recipe,
  status: job.status,
  progress: job.progress,
  errorCode: job.errorCode || null,
  derivative: job.derivative ? { ...job.derivative } : null,
});

const runtimeJob = record => ({
  id: record.id,
  assetId: record.assetId,
  recipe: record.recipe,
  status: record.status,
  progress: record.progress,
  errorCode: record.errorCode || null,
  derivative: record.derivative ? { ...record.derivative } : null,
  cancelRequested: false,
});

class AssetDerivativeController {
  constructor({ repository, workerPath = path.join(__dirname, '../workers/assetPreviewWorker.cjs'), maxInputBytes = MAX_PREVIEW_INPUT_BYTES } = {}) {
    if (!repository) throw new ProjectStorageError('derivative controller requires a project repository');
    this.repository = repository;
    this.workerPath = workerPath;
    this.maxInputBytes = maxInputBytes;
    this.jobs = new Map();
    this.queue = [];
    this.activeJobId = null;
    this.activeWorker = null;
    this.draining = false;
    this.restored = false;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) throw new ProjectStorageError('derivative controller is closed');
  }

  /** Rehydrate every durable record; stale running work becomes queued in the repository first. */
  restore() {
    this.#assertOpen();
    if (this.restored) return;
    for (const record of this.repository.recoverDerivativeJobs()) {
      const job = runtimeJob(record);
      this.jobs.set(job.id, job);
      if (job.status === 'queued') this.queue.push(job.id);
    }
    this.restored = true;
    void this.#drain();
  }

  #persist(job) {
    const blobCreated = job.derivative?.blobCreated;
    const stored = this.repository.updateDerivativeJob({
      id: job.id,
      status: job.status,
      progress: job.progress,
      errorCode: job.errorCode || null,
      derivative: job.derivative,
    });
    job.status = stored.status;
    job.progress = stored.progress;
    job.errorCode = stored.errorCode;
    job.derivative = stored.derivative
      ? { ...stored.derivative, ...(blobCreated === undefined ? {} : { blobCreated }) }
      : null;
  }

  requestPreview(assetId) {
    this.#assertOpen();
    this.restore();
    if (!this.repository.getAsset(assetId)) throw new ProjectStorageError(`unknown asset id: ${assetId}`);
    const job = runtimeJob(this.repository.createDerivativeJob({
      id: crypto.randomUUID(),
      assetId,
      recipe: PREVIEW_RECIPE,
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
    if (!job) throw new ProjectStorageError(`unknown derivative job: ${jobId}`);
    if (TERMINAL_STATUSES.has(job.status)) return snapshot(job);
    job.cancelRequested = true;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.errorCode = null;
      this.#persist(job);
    }
    if (job.status === 'running' && this.activeJobId === job.id) {
      this.activeWorker?.postMessage({ type: 'cancel', jobId: job.id });
    }
    return snapshot(job);
  }

  getPreviewDerivative(assetId) {
    this.#assertOpen();
    return this.repository.getDerivative(assetId, PREVIEW_RECIPE);
  }

  async #runWorker(job, asset, bytes) {
    const worker = new Worker(this.workerPath);
    this.activeWorker = worker;
    const transferred = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (callback, value) => {
          if (settled) return;
          settled = true;
          callback(value);
        };
        worker.on('message', message => {
          if (!message || message.jobId !== job.id) return;
          if (message.type === 'progress' && !TERMINAL_STATUSES.has(job.status)) {
            job.progress = Math.max(job.progress, Math.min(0.9, Number(message.progress) || 0));
            if (!this.closed) {
              try {
                this.#persist(job);
              } catch (error) {
                settle(reject, error);
              }
            }
          } else if (message.type === 'complete' && message.bytes instanceof ArrayBuffer) {
            settle(resolve, Buffer.from(message.bytes));
          } else if (message.type === 'cancelled') {
            settle(reject, new JobCancelledError());
          } else if (message.type === 'failed') {
            settle(reject, new Error(message.error || 'preview worker failed'));
          }
        });
        worker.once('error', error => settle(reject, error));
        worker.once('exit', code => {
          if (!settled && code !== 0) settle(reject, new Error(`preview worker exited with code ${code}`));
        });
        worker.postMessage({
          type: 'derive',
          jobId: job.id,
          asset: {
            id: asset.asset.id,
            kind: asset.asset.kind,
            mimeType: asset.asset.locator.mimeType,
            byteSize: bytes.byteLength,
          },
          bytes: transferred,
        }, [transferred]);
      });
    } finally {
      this.activeWorker = null;
      await worker.terminate();
    }
  }

  async #run(job) {
    if (job.cancelRequested) throw new JobCancelledError();
    if (this.closed) return;
    job.status = 'running';
    job.progress = 0.01;
    job.errorCode = null;
    this.#persist(job);
    const asset = this.repository.getAsset(job.assetId);
    if (!asset) throw new ProjectStorageError(`asset disappeared before derivative work: ${job.assetId}`);
    if (asset.byteSize > this.maxInputBytes) {
      throw new ProjectStorageError(`preview input exceeds the ${this.maxInputBytes} byte worker limit`);
    }
    const bytes = await this.repository.readAssetBytes(job.assetId);
    // Re-check the bytes read so a corrupt/changed source can never bypass the worker bound.
    if (bytes.byteLength > this.maxInputBytes) {
      throw new ProjectStorageError(`preview input exceeds the ${this.maxInputBytes} byte worker limit`);
    }
    if (job.cancelRequested) throw new JobCancelledError();
    if (this.closed) return;
    const derivativeBytes = await this.#runWorker(job, asset, bytes);
    if (job.cancelRequested) throw new JobCancelledError();
    if (this.closed) return;
    const derivative = await this.repository.putDerivative({
      assetId: job.assetId,
      recipe: job.recipe,
      bytes: derivativeBytes,
      mimeType: PREVIEW_MIME_TYPE,
    });
    if (this.closed) return;
    job.derivative = derivative;
    job.progress = 1;
    job.status = 'completed';
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
          // Closing is interruption, not user cancellation. Leave journal state for next-open recovery.
          if (this.closed) {
            // no durable mutation
          } else if (error instanceof JobCancelledError || job.cancelRequested) {
            job.status = 'cancelled';
            job.errorCode = null;
            this.#persist(job);
          } else {
            job.status = 'failed';
            job.errorCode = error instanceof ProjectStorageError ? 'STORAGE_ERROR' : 'WORKER_ERROR';
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
    this.activeWorker?.postMessage({ type: 'cancel', jobId: this.activeJobId });
    void this.activeWorker?.terminate();
  }
}

module.exports = {
  AssetDerivativeController,
  MAX_PREVIEW_INPUT_BYTES,
  PREVIEW_MIME_TYPE,
  PREVIEW_RECIPE,
};
