import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomService } from '../src/app/roomService.js';
import { InMemoryRoomRegistry } from '../src/domain/roomRegistry.js';
import { FakeRoomFactory, ManualTimers } from './fakes.js';

function build() {
  const timers = new ManualTimers();
  const mediaRooms = new FakeRoomFactory();
  const registry = new InMemoryRoomRegistry();
  const service = new RoomService({
    registry,
    mediaRooms,
    reconnectGraceMs: 1000,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    logger: { error() {}, log() {} },
  });
  const events = [];
  for (const e of ['peerJoined', 'peerLeft', 'peerDisconnected', 'peerReconnected', 'newProducer', 'producerClosed', 'activeSpeaker', 'roomClosed']) {
    service.on(e, (p) => events.push({ e, ...p }));
  }
  return { service, registry, mediaRooms, timers, events };
}

test('first join creates the room, returns router caps and an empty peer list', async () => {
  const { service, mediaRooms, registry } = build();
  const snap = await service.join({ roomId: 'r1', peerId: 'a', displayName: 'Ana' });

  assert.equal(mediaRooms.created.length, 1);
  assert.deepEqual(snap.rtpCapabilities, mediaRooms.last().rtpCapabilities);
  assert.deepEqual(snap.peers, []);
  assert.deepEqual(await registry.listMembers('r1'), [{ peerId: 'a', displayName: 'Ana' }]);
});

test('late joiner sees existing peers and their producers', async () => {
  const { service } = build();
  await service.join({ roomId: 'r1', peerId: 'a', displayName: 'Ana' });
  const t = await service.createTransport({ roomId: 'r1', peerId: 'a', direction: 'send' });
  const { id: producerId } = await service.produce({ roomId: 'r1', peerId: 'a', transportId: t.id, kind: 'video', rtpParameters: {} });

  const snap = await service.join({ roomId: 'r1', peerId: 'b', displayName: 'Ben' });
  assert.equal(snap.peers.length, 1);
  assert.equal(snap.peers[0].id, 'a');
  assert.deepEqual(snap.peers[0].producerIds, [producerId]);
});

test('produce emits newProducer to the room; closing emits producerClosed', async () => {
  const { service, events } = build();
  await service.join({ roomId: 'r1', peerId: 'a', displayName: 'Ana' });
  const t = await service.createTransport({ roomId: 'r1', peerId: 'a', direction: 'send' });
  const { id } = await service.produce({ roomId: 'r1', peerId: 'a', transportId: t.id, kind: 'audio', rtpParameters: {} });

  assert.ok(events.find((x) => x.e === 'newProducer' && x.producerId === id && x.kind === 'audio'));
  await service.closeProducer({ roomId: 'r1', peerId: 'a', producerId: id });
  assert.ok(events.find((x) => x.e === 'producerClosed' && x.producerId === id));
  assert.equal(service.rooms.get('r1').getPeer('a').producerIds.size, 0);
});

test('consume delegates to the media port and returns consumer params', async () => {
  const { service, mediaRooms } = build();
  await service.join({ roomId: 'r1', peerId: 'a', displayName: 'Ana' });
  await service.join({ roomId: 'r1', peerId: 'b', displayName: 'Ben' });
  const params = await service.consume({ roomId: 'r1', peerId: 'b', producerId: 'producer-x', rtpCapabilities: {} });
  assert.equal(params.producerId, 'producer-x');
  assert.equal(mediaRooms.last().calls.filter((c) => c.name === 'consume').length, 1);
});

test('disconnect keeps the seat during the grace window and reconnect restores it', async () => {
  const { service, timers, events, registry } = build();
  await service.join({ roomId: 'r1', peerId: 'a', displayName: 'Ana' });
  service.disconnect({ roomId: 'r1', peerId: 'a' });

  assert.equal(service.rooms.get('r1').getPeer('a').connected, false);
  assert.equal(timers.pending.size, 1);
  assert.deepEqual(await registry.listMembers('r1'), [{ peerId: 'a', displayName: 'Ana' }]);

  const snap = await service.join({ roomId: 'r1', peerId: 'a', displayName: 'Ana' });
  assert.equal(service.rooms.get('r1').getPeer('a').connected, true);
  assert.equal(timers.pending.size, 0, 'grace timer cleared on reconnect');
  assert.ok(events.find((x) => x.e === 'peerReconnected'));
  assert.deepEqual(snap.peers, []);
});

test('grace window expiry removes the peer and closes an empty room', async () => {
  const { service, timers, events, mediaRooms } = build();
  await service.join({ roomId: 'r1', peerId: 'a', displayName: 'Ana' });
  service.disconnect({ roomId: 'r1', peerId: 'a' });
  timers.fireAll();
  await new Promise((r) => setImmediate(r));

  assert.equal(service.rooms.has('r1'), false);
  assert.equal(mediaRooms.last().closed, true);
  assert.ok(events.find((x) => x.e === 'peerLeft' && x.peerId === 'a'));
  assert.ok(events.find((x) => x.e === 'roomClosed'));
});

test('double join with a connected peer id is rejected', async () => {
  const { service } = build();
  await service.join({ roomId: 'r1', peerId: 'a', displayName: 'Ana' });
  await assert.rejects(service.join({ roomId: 'r1', peerId: 'a', displayName: 'Ana' }), /already connected/);
});

test('active speaker events from the media port are re-emitted with the room id', async () => {
  const { service, events, mediaRooms } = build();
  await service.join({ roomId: 'r1', peerId: 'a', displayName: 'Ana' });
  mediaRooms.last().speak('a');
  assert.ok(events.find((x) => x.e === 'activeSpeaker' && x.roomId === 'r1' && x.peerId === 'a'));
  assert.equal(service.rooms.get('r1').activeSpeakerId, 'a');
});

test('media calls for an unknown peer or room fail with stable error codes', async () => {
  const { service } = build();
  await service.join({ roomId: 'r1', peerId: 'a', displayName: 'Ana' });
  await assert.rejects(service.createTransport({ roomId: 'r1', peerId: 'ghost', direction: 'send' }), (err) => err.code === 'PEER_NOT_FOUND');
  await assert.rejects(service.createTransport({ roomId: 'nope', peerId: 'a', direction: 'send' }), (err) => err.code === 'ROOM_NOT_FOUND');
});
