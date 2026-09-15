import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRoomRegistry } from '../src/domain/roomRegistry.js';
import { RedisRoomRegistry } from '../src/infra/redisRoomRegistry.js';

/** Minimal in-process stand-in for the handful of ioredis calls we use. */
class FakeRedis {
  constructor() { this.hashes = new Map(); }
  multi() {
    const ops = [];
    const chain = {
      hset: (k, f, v) => { ops.push(() => this.hset(k, f, v)); return chain; },
      expire: () => chain,
      exec: async () => { for (const op of ops) await op(); },
    };
    return chain;
  }
  async hset(k, f, v) { if (!this.hashes.has(k)) this.hashes.set(k, new Map()); this.hashes.get(k).set(f, v); }
  async hdel(k, f) { this.hashes.get(k)?.delete(f); if (this.hashes.get(k)?.size === 0) this.hashes.delete(k); }
  async hgetall(k) { return Object.fromEntries(this.hashes.get(k) ?? []); }
  async exists(k) { return this.hashes.has(k) ? 1 : 0; }
  async quit() {}
}

for (const [name, make] of [
  ['InMemoryRoomRegistry', () => new InMemoryRoomRegistry()],
  ['RedisRoomRegistry', () => new RedisRoomRegistry('redis://fake', { client: new FakeRedis() })],
]) {
  test(`${name}: add, list, remove, and room existence`, async () => {
    const reg = make();
    assert.equal(await reg.roomExists('r1'), false);
    await reg.addMember('r1', 'a', 'Ana');
    await reg.addMember('r1', 'b', 'Ben');
    assert.equal(await reg.roomExists('r1'), true);
    const members = (await reg.listMembers('r1')).sort((x, y) => x.peerId.localeCompare(y.peerId));
    assert.deepEqual(members, [{ peerId: 'a', displayName: 'Ana' }, { peerId: 'b', displayName: 'Ben' }]);
    await reg.removeMember('r1', 'a');
    await reg.removeMember('r1', 'b');
    assert.equal(await reg.roomExists('r1'), false);
  });
}
