/**
 * Owns the mediasoup Workers (one C++ subprocess each) and decides which one
 * a new room lands on. Least-loaded by router count is good enough here; the
 * load-test harness (project 4) is where this decision gets measured.
 *
 * The pool takes a `createWorker` function instead of importing mediasoup
 * directly, so tests can hand it fakes and so the composition root controls
 * every external dependency in one place.
 */
export class WorkerPool {
  /**
   * @param {{ createWorker: (settings: object) => Promise<object>, size: number, settings?: object, logger?: Console }} opts
   */
  constructor({ createWorker, size, settings = {}, logger = console }) {
    if (size < 1) throw new Error('WorkerPool needs at least one worker');
    this.createWorker = createWorker;
    this.size = size;
    this.settings = settings;
    this.logger = logger;
    /** @type {{ worker: object, routers: number }[]} */
    this.slots = [];
  }

  async start() {
    for (let i = 0; i < this.size; i += 1) {
      const worker = await this.createWorker(this.settings);
      const slot = { worker, routers: 0 };
      // A dying worker takes every router on it down. In production you would
      // respawn and let clients ICE-restart; for this project we log loudly
      // and let the process supervisor restart us.
      worker.on?.('died', () => {
        this.logger.error(`mediasoup worker ${worker.pid} died — exiting for supervisor restart`);
        setTimeout(() => process.exit(1), 1000);
      });
      this.slots.push(slot);
    }
    return this;
  }

  /** Pick the worker with the fewest routers. Ties go to the earliest slot. */
  pick() {
    let best = this.slots[0];
    for (const slot of this.slots) {
      if (slot.routers < best.routers) best = slot;
    }
    return best;
  }

  /** Create a router on the least-loaded worker and track the placement. */
  async createRouter(routerOptions) {
    const slot = this.pick();
    const router = await slot.worker.createRouter(routerOptions);
    slot.routers += 1;
    router.observer?.once?.('close', () => {
      slot.routers = Math.max(0, slot.routers - 1);
    });
    return router;
  }

  async close() {
    for (const { worker } of this.slots) worker.close?.();
    this.slots = [];
  }

  get stats() {
    return this.slots.map((s, i) => ({ index: i, pid: s.worker.pid, routers: s.routers }));
  }
}
