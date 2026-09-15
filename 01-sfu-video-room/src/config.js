import os from 'node:os';
import 'dotenv/config';

/**
 * All runtime configuration is read once here and passed down explicitly.
 * Nothing else in the codebase touches process.env, which keeps the rest
 * testable with plain objects.
 */
export function loadConfig(env = process.env) {
  const numWorkers = Number(env.NUM_WORKERS) || os.cpus().length;

  const turn = env.TURN_URL
    ? [{ urls: env.TURN_URL, username: env.TURN_USER, credential: env.TURN_PASS }]
    : [];

  return {
    port: Number(env.PORT) || 3000,
    announcedIp: env.ANNOUNCED_IP || '127.0.0.1',
    rtcMinPort: Number(env.RTC_MIN_PORT) || 40000,
    rtcMaxPort: Number(env.RTC_MAX_PORT) || 49999,
    numWorkers,
    redisUrl: env.REDIS_URL || null,
    mediasoupLogLevel: env.MEDIASOUP_LOG_LEVEL || 'warn',
    // STUN is free and always useful; TURN only if the operator configured one.
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...turn],
    // How long a peer keeps its seat after the socket drops before we clean up.
    reconnectGraceMs: Number(env.RECONNECT_GRACE_MS) || 30_000,
  };
}
