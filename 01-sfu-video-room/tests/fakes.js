import { EventEmitter } from 'node:events';

/**
 * Test doubles that implement the same ports as the mediasoup adapters.
 * They record calls so tests can assert on behaviour without a real worker.
 */

let seq = 0;
const nextId = (prefix) => `${prefix}-${++seq}`;

export class FakeMediaRoom extends EventEmitter {
  constructor(roomId) {
    super();
    this.roomId = roomId;
    this.rtpCapabilities = { codecs: ['fake-opus', 'fake-vp8'] };
    this.calls = [];
    this.closed = false;
    this.peers = new Map();
  }
  record(name, args) { this.calls.push({ name, ...args }); }
  state(peerId) {
    if (!this.peers.has(peerId)) this.peers.set(peerId, { transports: new Set(), producers: new Set(), consumers: new Set() });
    return this.peers.get(peerId);
  }
  async createTransport(peerId, direction) {
    const id = nextId('transport');
    this.state(peerId).transports.add(id);
    this.record('createTransport', { peerId, direction, id });
    return { id, iceParameters: {}, iceCandidates: [], dtlsParameters: {} };
  }
  async connectTransport(peerId, transportId, dtlsParameters) {
    if (!this.state(peerId).transports.has(transportId)) throw new Error('transport not found');
    this.record('connectTransport', { peerId, transportId, dtlsParameters });
  }
  async produce(peerId, transportId, kind) {
    const id = nextId('producer');
    this.state(peerId).producers.add(id);
    this.record('produce', { peerId, transportId, kind, id });
    return { id, kind };
  }
  async consume(peerId, producerId) {
    const id = nextId('consumer');
    this.state(peerId).consumers.add(id);
    this.record('consume', { peerId, producerId, id });
    return { id, producerId, kind: 'video', rtpParameters: {}, producerPaused: false };
  }
  async resumeConsumer(peerId, consumerId) { this.record('resumeConsumer', { peerId, consumerId }); }
  async setConsumerLayers(peerId, consumerId, spatialLayer) { this.record('setConsumerLayers', { peerId, consumerId, spatialLayer }); }
  async pauseProducer(peerId, producerId) { this.record('pauseProducer', { peerId, producerId }); }
  async resumeProducer(peerId, producerId) { this.record('resumeProducer', { peerId, producerId }); }
  closeProducer(peerId, producerId) { this.state(peerId).producers.delete(producerId); this.record('closeProducer', { peerId, producerId }); }
  removePeer(peerId) { this.peers.delete(peerId); this.record('removePeer', { peerId }); }
  close() { this.closed = true; this.record('close', {}); }

  /** Test helper: pretend the audio level observer fired. */
  speak(peerId) { this.emit('activeSpeaker', peerId); }
}

export class FakeRoomFactory {
  constructor() { this.created = []; }
  async create(roomId) {
    const room = new FakeMediaRoom(roomId);
    this.created.push(room);
    return room;
  }
  last() { return this.created[this.created.length - 1]; }
}

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

/** Manual timers so reconnect-grace behaviour is deterministic in tests. */
export class ManualTimers {
  constructor() { this.pending = new Map(); this.nextId = 1; }
  setTimeout = (fn, ms) => { const id = this.nextId++; this.pending.set(id, { fn, ms }); return id; };
  clearTimeout = (id) => { this.pending.delete(id); };
  fireAll() { for (const [id, { fn }] of [...this.pending]) { this.pending.delete(id); fn(); } }
}
