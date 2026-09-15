import Redis from 'ioredis';

/**
 * Redis-backed RoomRegistry. Membership lives in one hash per room:
 *   room:{roomId}:members  peerId -> displayName
 *
 * Deliberately minimal: presence only. Anything that needs the mediasoup
 * router (producers, consumers, transports) has to be answered by the node
 * that owns that router, so we do not pretend Redis knows about it.
 */
export class RedisRoomRegistry {
  /**
   * @param {string} url redis connection string
   * @param {{ ttlSeconds?: number, client?: Redis }} [opts]
   */
  constructor(url, opts = {}) {
    this.client = opts.client ?? new Redis(url);
    // A room hash that nobody touches for this long simply disappears —
    // cheap protection against leaks when a node dies mid-session.
    this.ttlSeconds = opts.ttlSeconds ?? 60 * 60 * 6;
  }

  key(roomId) {
    return `room:${roomId}:members`;
  }

  async addMember(roomId, peerId, displayName) {
    const k = this.key(roomId);
    await this.client.multi().hset(k, peerId, displayName).expire(k, this.ttlSeconds).exec();
  }

  async removeMember(roomId, peerId) {
    await this.client.hdel(this.key(roomId), peerId);
  }

  async listMembers(roomId) {
    const hash = await this.client.hgetall(this.key(roomId));
    return Object.entries(hash).map(([peerId, displayName]) => ({ peerId, displayName }));
  }

  async roomExists(roomId) {
    return (await this.client.exists(this.key(roomId))) === 1;
  }

  async close() {
    await this.client.quit();
  }
}
