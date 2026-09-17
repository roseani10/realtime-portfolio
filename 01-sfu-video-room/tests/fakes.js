import { EventEmitter } from 'node:events';

/**
 * Test doubles that implement the same ports as the mediasoup adapters.
 * They record calls so tests can assert on behaviour without a real worker.
 */

/** Fake mediasoup worker for WorkerPool tests. */
export class FakeWorker extends EventEmitter {
  constructor(pid) { super(); this.pid = pid; this.routers = []; this.closed = false; }
  async createRouter(opts) {
    const router = new EventEmitter();
    router.worker = this;
    router.observer = new EventEmitter();
    router.opts = opts;
    router.close = () => router.observer.emit('close');
    this.routers.push(router);
    return router;
  }
  close() { this.closed = true; }
}
