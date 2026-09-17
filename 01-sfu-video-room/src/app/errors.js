/** Errors the signaling layer is allowed to show to clients, with stable codes. */
export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const errors = {
  roomNotFound: (roomId) => new AppError('ROOM_NOT_FOUND', `room ${roomId} does not exist`),
  peerNotFound: (peerId) => new AppError('PEER_NOT_FOUND', `peer ${peerId} is not in this room`),
  notJoined: () => new AppError('NOT_JOINED', 'join a room before doing that'),
  badRequest: (detail) => new AppError('BAD_REQUEST', detail),
};
