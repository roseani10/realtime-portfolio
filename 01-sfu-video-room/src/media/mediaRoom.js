import { EventEmitter } from 'node:events';

/**
 * MediaRoom is the only class that speaks mediasoup. It wraps one Router and
 * everything hanging off it: per-peer transports, producers and consumers.
 * RoomService talks to it through a small surface (the "port"):
 *
 *   rtpCapabilities
 *   createTransport(peerId, direction) -> transport params for the client
 *   connectTransport(peerId, transportId, dtlsParameters)
 *   produce(peerId, transportId, kind, rtpParameters, appData) -> { id, kind }
 *   consume(peerId, producerId, rtpCapabilities) -> consumer params
 *   resumeConsumer(peerId, consumerId)
 *   setConsumerLayers(peerId, consumerId, spatialLayer)
 *   pauseProducer / resumeProducer / closeProducer
 *   removePeer(peerId)
 *   close()
 *   events: 'activeSpeaker' (peerId | null), 'consumerClosed'
 *
 * tests/fakes.js implements the same surface without mediasoup.
 */
export class MediasoupMediaRoom extends EventEmitter {
  /**
   * @param {object} router mediasoup Router
   * @param {object} audioLevelObserver mediasoup AudioLevelObserver
   * @param {{ announcedIp: string, initialBitrate?: number }} transportOptions
   */
  constructor(router, audioLevelObserver, transportOptions) {
    super();
    this.router = router;
    this.observer = audioLevelObserver;
    this.transportOptions = transportOptions;
    /** peerId -> { transports: Map, producers: Map, consumers: Map } */
    this.peers = new Map();
    /** producerId -> peerId, so active-speaker events can be mapped back */
    this.producerOwner = new Map();

    this.observer.on('volumes', (volumes) => {
      const loudest = volumes[0]; // maxEntries is 1
      const peerId = this.producerOwner.get(loudest.producer.id) ?? null;
      this.emit('activeSpeaker', peerId);
    });
    this.observer.on('silence', () => this.emit('activeSpeaker', null));
  }

  get rtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  state(peerId) {
    if (!this.peers.has(peerId)) {
      this.peers.set(peerId, { transports: new Map(), producers: new Map(), consumers: new Map() });
    }
    return this.peers.get(peerId);
  }

  async createTransport(peerId, direction) {
    const transport = await this.router.createWebRtcTransport({
      listenInfos: [
        { protocol: 'udp', ip: '0.0.0.0', announcedAddress: this.transportOptions.announcedIp },
        { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: this.transportOptions.announcedIp },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: this.transportOptions.initialBitrate ?? 1_000_000,
      appData: { peerId, direction },
    });

    transport.on('dtlsstatechange', (s) => {
      if (s === 'failed' || s === 'closed') transport.close();
    });

    this.state(peerId).transports.set(transport.id, transport);

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport(peerId, transportId, dtlsParameters) {
    const transport = this.state(peerId).transports.get(transportId);
    if (!transport) throw new Error(`transport ${transportId} not found for ${peerId}`);
    await transport.connect({ dtlsParameters });
  }

  async produce(peerId, transportId, kind, rtpParameters, appData = {}) {
    const transport = this.state(peerId).transports.get(transportId);
    if (!transport) throw new Error(`transport ${transportId} not found for ${peerId}`);

    const producer = await transport.produce({ kind, rtpParameters, appData: { ...appData, peerId } });
    this.state(peerId).producers.set(producer.id, producer);
    this.producerOwner.set(producer.id, peerId);

    if (kind === 'audio') {
      // The observer only needs to know the producer exists; nothing waits on this.
      this.observer.addProducer({ producerId: producer.id }).catch(() => {});
    }

    producer.on('transportclose', () => this.forgetProducer(peerId, producer.id));
    return { id: producer.id, kind };
  }

  async consume(peerId, producerId, rtpCapabilities) {
    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error(`peer ${peerId} cannot consume producer ${producerId}`);
    }
    const recv = [...this.state(peerId).transports.values()].find((t) => t.appData.direction === 'recv');
    if (!recv) throw new Error(`peer ${peerId} has no recv transport`);

    // Start paused; the client resumes once its consumer object exists.
    // Otherwise the first keyframe races the client and you get a black tile.
    const consumer = await recv.consume({ producerId, rtpCapabilities, paused: true });
    this.state(peerId).consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => this.state(peerId).consumers.delete(consumer.id));
    consumer.on('producerclose', () => {
      this.state(peerId).consumers.delete(consumer.id);
      this.emit('consumerClosed', { peerId, consumerId: consumer.id });
    });

    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      producerPaused: consumer.producerPaused,
    };
  }

  async resumeConsumer(peerId, consumerId) {
    await this.state(peerId).consumers.get(consumerId)?.resume();
  }

  async setConsumerLayers(peerId, consumerId, spatialLayer) {
    const consumer = this.state(peerId).consumers.get(consumerId);
    if (consumer?.kind === 'video') {
      await consumer.setPreferredLayers({ spatialLayer, temporalLayer: 2 });
    }
  }

  async pauseProducer(peerId, producerId) {
    await this.state(peerId).producers.get(producerId)?.pause();
  }

  async resumeProducer(peerId, producerId) {
    await this.state(peerId).producers.get(producerId)?.resume();
  }

  closeProducer(peerId, producerId) {
    this.state(peerId).producers.get(producerId)?.close();
    this.forgetProducer(peerId, producerId);
  }

  forgetProducer(peerId, producerId) {
    this.state(peerId).producers.delete(producerId);
    this.producerOwner.delete(producerId);
  }

  removePeer(peerId) {
    const st = this.peers.get(peerId);
    if (!st) return;
    // Closing a transport closes every producer/consumer on it.
    for (const t of st.transports.values()) t.close();
    for (const id of st.producers.keys()) this.producerOwner.delete(id);
    this.peers.delete(peerId);
  }

  close() {
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    this.observer.close();
    this.router.close();
    this.removeAllListeners();
  }
}

/**
 * Factory: RoomService asks for a media room by id and gets back the port
 * above. Keeping construction here means RoomService never imports mediasoup.
 */
export class MediasoupRoomFactory {
  /**
   * @param {{ workerPool: import('./workerPool.js').WorkerPool, mediaCodecs: object[], announcedIp: string }} deps
   */
  constructor({ workerPool, mediaCodecs, announcedIp }) {
    this.workerPool = workerPool;
    this.mediaCodecs = mediaCodecs;
    this.announcedIp = announcedIp;
  }

  async create(roomId) {
    const router = await this.workerPool.createRouter({ mediaCodecs: this.mediaCodecs, appData: { roomId } });
    const observer = await router.createAudioLevelObserver({ maxEntries: 1, threshold: -70, interval: 800 });
    return new MediasoupMediaRoom(router, observer, { announcedIp: this.announcedIp });
  }
}
