/**
 * RoomRegistry is the port through which the application finds out which
 * peers are in which room. The in-memory version is enough for one process;
 * the Redis version (src/infra/redisRoomRegistry.js) lets several signaling
 * nodes agree on membership. Media objects never go through here — they are
 * process-bound and stay pinned to the worker that owns the router.
 *
 * Interface (duck-typed):
 *   async addMember(roomId, peerId, displayName)
 *   async removeMember(roomId, peerId)
 *   async listMembers(roomId) -> [{ peerId, displayName }]
 *   async roomExists(roomId) -> boolean
 */

export class InMemoryRoomRegistry {
  constructor() {
    /** @type {Map<string, Map<string, {peerId: string, displayName: string}>>} */
    this.rooms = new Map();
  }

  async addMember(roomId, peerId, displayName) {
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Map());
    this.rooms.get(roomId).set(peerId, { peerId, displayName });
  }

  async removeMember(roomId, peerId) {
    const members = this.rooms.get(roomId);
    if (!members) return;
    members.delete(peerId);
    if (members.size === 0) this.rooms.delete(roomId);
  }

  async listMembers(roomId) {
    return [...(this.rooms.get(roomId)?.values() ?? [])];
  }

  async roomExists(roomId) {
    return this.rooms.has(roomId);
  }
}
