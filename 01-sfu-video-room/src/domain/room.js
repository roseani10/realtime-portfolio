/**
 * Domain model. No mediasoup, no sockets, no Redis in this file — just the
 * shape of a room and the rules about who is in it. Everything media-related
 * hangs off ids so the media layer can be swapped or faked.
 */

export class Peer {
  /**
   * @param {string} id stable identity chosen by the client (survives reconnects)
   * @param {string} displayName
   */
  constructor(id, displayName) {
    this.id = id;
    this.displayName = displayName;
    /** @type {Set<string>} producer ids owned by this peer */
    this.producerIds = new Set();
    this.joinedAt = Date.now();
    this.connected = true;
    /** @type {NodeJS.Timeout | null} */
    this.disconnectTimer = null;
  }

  toPublic() {
    return { id: this.id, displayName: this.displayName, connected: this.connected };
  }
}

export class Room {
  /**
   * @param {string} id
   */
  constructor(id) {
    this.id = id;
    /** @type {Map<string, Peer>} */
    this.peers = new Map();
    this.createdAt = Date.now();
    this.activeSpeakerId = null;
  }

  addPeer(peer) {
    if (this.peers.has(peer.id)) {
      throw new Error(`peer ${peer.id} already in room ${this.id}`);
    }
    this.peers.set(peer.id, peer);
    return peer;
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    this.peers.delete(peerId);
    if (this.activeSpeakerId === peerId) this.activeSpeakerId = null;
    return peer ?? null;
  }

  getPeer(peerId) {
    return this.peers.get(peerId) ?? null;
  }

  /** Everyone except the given peer — the set a new joiner must consume. */
  othersThan(peerId) {
    return [...this.peers.values()].filter((p) => p.id !== peerId);
  }

  get isEmpty() {
    return this.peers.size === 0;
  }

  toPublic() {
    return {
      id: this.id,
      peers: [...this.peers.values()].map((p) => p.toPublic()),
      activeSpeakerId: this.activeSpeakerId,
    };
  }
}
