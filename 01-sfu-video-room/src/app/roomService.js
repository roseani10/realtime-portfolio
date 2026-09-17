import { EventEmitter } from 'node:events';
import { Room, Peer } from '../domain/room.js';
import { errors } from './errors.js';

/**
 * Application service: the use cases (join, leave, publish, subscribe,
 * reconnect) expressed without any transport or media-engine detail.
 *
 * Dependencies come in through the constructor:
 *   - registry:   RoomRegistry port (membership shared across nodes)
 *   - mediaRooms: factory with create(roomId) -> MediaRoom port
 *   - timers are injectable for the reconnect grace tests
 *
 * It emits events the signaling layer forwards to clients:
 *   peerJoined, peerLeft, peerDisconnected, peerReconnected, newProducer,
 *   producerClosed, producerPaused, activeSpeaker, consumerClosed, roomClosed
 */
export class RoomService extends EventEmitter {
  constructor({ registry, mediaRooms, reconnectGraceMs = 30_000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, logger = console }) {
    super();
    this.registry = registry;
    this.mediaRooms = mediaRooms;
    this.reconnectGraceMs = reconnectGraceMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.logger = logger;
    /** roomId -> Room (domain) */
    this.rooms = new Map();
    /** roomId -> MediaRoom (port) */
    this.media = new Map();
  }

  // ---- room lifecycle -----------------------------------------------------

  async getOrCreateRoom(roomId) {
    if (this.rooms.has(roomId)) return this.rooms.get(roomId);

    const room = new Room(roomId);
    const media = await this.mediaRooms.create(roomId);
    media.on('activeSpeaker', (peerId) => {
      room.activeSpeakerId = peerId;
      this.emit('activeSpeaker', { roomId, peerId });
    });
    media.on('consumerClosed', (payload) => this.emit('consumerClosed', { roomId, ...payload }));

    this.rooms.set(roomId, room);
    this.media.set(roomId, media);
    return room;
  }

  requireRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) throw errors.roomNotFound(roomId);
    return room;
  }

  requirePeer(roomId, peerId) {
    const peer = this.requireRoom(roomId).getPeer(peerId);
    if (!peer) throw errors.peerNotFound(peerId);
    return peer;
  }

  closeRoomIfEmpty(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || !room.isEmpty) return;
    this.media.get(roomId)?.close();
    this.media.delete(roomId);
    this.rooms.delete(roomId);
    this.emit('roomClosed', { roomId });
  }

  // ---- join / leave / reconnect ----------------------------------------------

  /**
   * Join or re-join. If a peer with this id is inside its reconnect grace
   * window we restore it instead of creating a new seat — that is what makes
   * a page refresh survivable.
   */
  async join({ roomId, peerId, displayName }) {
    const room = await this.getOrCreateRoom(roomId);
    const existing = room.getPeer(peerId);

    if (existing && !existing.connected) {
      this.clearTimeoutFn(existing.disconnectTimer);
      existing.disconnectTimer = null;
      existing.connected = true;
      existing.displayName = displayName || existing.displayName;
      // Media objects from before the drop are stale (new socket, new DTLS),
      // so we drop them and let the client re-negotiate from scratch.
      this.media.get(roomId).removePeer(peerId);
      for (const producerId of existing.producerIds) {
        this.emit('producerClosed', { roomId, peerId, producerId });
      }
      existing.producerIds.clear();
      this.emit('peerReconnected', { roomId, peer: existing.toPublic() });
      return this.snapshot(roomId, peerId);
    }

    if (existing) throw errors.badRequest(`peer ${peerId} is already connected`);

    const peer = room.addPeer(new Peer(peerId, displayName));
    await this.registry.addMember(roomId, peerId, displayName);
    this.emit('peerJoined', { roomId, peer: peer.toPublic() });
    return this.snapshot(roomId, peerId);
  }

  /** What a joining client needs: router caps + everyone already here. */
  snapshot(roomId, peerId) {
    const room = this.requireRoom(roomId);
    const media = this.media.get(roomId);
    const others = room.othersThan(peerId).map((p) => ({
      ...p.toPublic(),
      producerIds: [...p.producerIds],
    }));
    return {
      rtpCapabilities: media.rtpCapabilities,
      peers: others,
      activeSpeakerId: room.activeSpeakerId,
    };
  }

  /** Socket dropped. Keep the seat for a while; clean up if nobody comes back. */
  disconnect({ roomId, peerId }) {
    const room = this.rooms.get(roomId);
    const peer = room?.getPeer(peerId);
    if (!peer) return;
    peer.connected = false;
    this.emit('peerDisconnected', { roomId, peerId });
    peer.disconnectTimer = this.setTimeoutFn(() => this.leave({ roomId, peerId }), this.reconnectGraceMs);
  }

  async leave({ roomId, peerId }) {
    const room = this.rooms.get(roomId);
    const peer = room?.removePeer(peerId);
    if (!peer) return;
    if (peer.disconnectTimer) this.clearTimeoutFn(peer.disconnectTimer);
    this.media.get(roomId)?.removePeer(peerId);
    await this.registry.removeMember(roomId, peerId);
    this.emit('peerLeft', { roomId, peerId });
    this.closeRoomIfEmpty(roomId);
  }

  // ---- media use cases -----------------------------------------------------

  async createTransport({ roomId, peerId, direction }) {
    this.requirePeer(roomId, peerId);
    return this.media.get(roomId).createTransport(peerId, direction);
  }

  async connectTransport({ roomId, peerId, transportId, dtlsParameters }) {
    this.requirePeer(roomId, peerId);
    await this.media.get(roomId).connectTransport(peerId, transportId, dtlsParameters);
  }

  async produce({ roomId, peerId, transportId, kind, rtpParameters, appData }) {
    const peer = this.requirePeer(roomId, peerId);
    const { id } = await this.media.get(roomId).produce(peerId, transportId, kind, rtpParameters, appData);
    peer.producerIds.add(id);
    this.emit('newProducer', { roomId, peerId, producerId: id, kind });
    return { id };
  }

  async closeProducer({ roomId, peerId, producerId }) {
    const peer = this.requirePeer(roomId, peerId);
    this.media.get(roomId).closeProducer(peerId, producerId);
    peer.producerIds.delete(producerId);
    this.emit('producerClosed', { roomId, peerId, producerId });
  }

  async setProducerPaused({ roomId, peerId, producerId, paused }) {
    this.requirePeer(roomId, peerId);
    const media = this.media.get(roomId);
    if (paused) await media.pauseProducer(peerId, producerId);
    else await media.resumeProducer(peerId, producerId);
    this.emit('producerPaused', { roomId, peerId, producerId, paused });
  }

  async consume({ roomId, peerId, producerId, rtpCapabilities }) {
    this.requirePeer(roomId, peerId);
    return this.media.get(roomId).consume(peerId, producerId, rtpCapabilities);
  }

  async resumeConsumer({ roomId, peerId, consumerId }) {
    this.requirePeer(roomId, peerId);
    await this.media.get(roomId).resumeConsumer(peerId, consumerId);
  }

  /** Simulcast layer selection: 0 = thumbnail, 2 = full. */
  async setConsumerLayers({ roomId, peerId, consumerId, spatialLayer }) {
    this.requirePeer(roomId, peerId);
    await this.media.get(roomId).setConsumerLayers(peerId, consumerId, spatialLayer);
  }

  // ---- introspection -------------------------------------------------------

  listRooms() {
    return [...this.rooms.values()].map((r) => r.toPublic());
  }
}
