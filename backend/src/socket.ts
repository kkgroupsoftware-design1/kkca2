import type { Server as HttpServer } from 'http';
import { Server, type Socket } from 'socket.io';
import { config } from './config';
import { query } from './db';
import { verifyToken } from './auth-utils';
import { addPresence, removePresence, onlineUserIds } from './presence';
import { setIo, emitToUsers } from './realtime';
import { findUserById, isRevoked } from './services/users';
import { isMember, memberIds, persistMessage } from './services/conversations';
import { normalizeMessageInput, messageSchema } from './routes/conversations';
import { assertParticipant, createCallInvite, getCall, transitionCall } from './services/calls';

/**
 * Socket.IO event contract (client → server / server → client)
 * Auth: handshake auth { token: <JWT> } or Authorization: Bearer header.
 *
 * client → server:
 *   message:send    { conversationId, type?, body?, fileUrl?, fileName?, durationSeconds? } → ack(message)
 *   message:typing  { conversationId, isTyping }
 *   call:signal     { callId, kind: 'offer'|'answer'|'ice'|'bye'|string, data, toUserId? }
 *   call:invite     { calleeId?, conversationId?, type } → ack(call)
 *   call:accept | call:reject | call:cancel | call:end   { callId } → ack(call)
 *
 * server → client:
 *   presence:update { userId, isOnline, onlineUserIds }
 *   message:new     MessageDto
 *   message:typing  { conversationId, userId, isTyping }
 *   call:incoming   { callId, call, iceServers }
 *   call:accepted | call:rejected | call:cancelled | call:ended  { callId, action, status, call }
 *   call:signal     { callId, fromUserId, kind, data }
 */

interface AuthedSocket extends Socket {
  data: { userId?: string; username?: string };
}

export function attachSocket(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins, credentials: true },
  });
  setIo(io);

  io.use(async (socket: AuthedSocket, next) => {
    try {
      const raw =
        (socket.handshake.auth?.token as string | undefined) ||
        (socket.handshake.headers.authorization?.startsWith('Bearer ')
          ? socket.handshake.headers.authorization.slice(7)
          : undefined);
      if (!raw) return next(new Error('Authentication required'));
      const payload = verifyToken(raw);
      if (await isRevoked(payload.jti)) return next(new Error('Session revoked'));
      const user = await findUserById(payload.sub);
      if (!user || !user.is_active || user.token_version !== payload.tv) {
        return next(new Error('Account is not authorized'));
      }
      socket.data.userId = user.id;
      socket.data.username = user.username;
      next();
    } catch {
      next(new Error('Invalid or expired session'));
    }
  });

  io.on('connection', (socket: AuthedSocket) => {
    const userId = socket.data.userId!;
    void socket.join(`user:${userId}`);
    addPresence(userId, socket.id);
    io.emit('presence:update', { userId, isOnline: true, onlineUserIds: onlineUserIds() });
    socket.emit('presence:update', { userId, isOnline: true, onlineUserIds: onlineUserIds() });

    socket.on('message:send', async (raw: unknown, ack?: (resp: unknown) => void) => {
      try {
        const data = (raw ?? {}) as Record<string, unknown>;
        const conversationId = String(data.conversationId ?? data.conversation_id ?? '');
        if (!conversationId || !(await isMember(conversationId, userId))) {
          ack?.({ error: 'Not a member of this conversation' });
          return;
        }
        const input = normalizeMessageInput(messageSchema.parse(data));
        const message = await persistMessage({ conversationId, senderId: userId, ...input });
        const { serializeMessage } = await import('./services/conversations');
        const payload = serializeMessage(message);
        const others = (await memberIds(conversationId)).filter((id) => id !== userId);
        emitToUsers(others, 'message:new', payload);
        ack?.(payload);
      } catch (err) {
        ack?.({ error: (err as Error).message });
      }
    });

    socket.on('message:typing', async (raw: unknown) => {
      const data = (raw ?? {}) as Record<string, unknown>;
      const conversationId = String(data.conversationId ?? '');
      if (!conversationId || !(await isMember(conversationId, userId).catch(() => false))) return;
      const others = (await memberIds(conversationId)).filter((id) => id !== userId);
      emitToUsers(others, 'message:typing', {
        conversationId,
        userId,
        isTyping: Boolean(data.isTyping ?? data.is_typing ?? true),
      });
    });

    socket.on('call:signal', async (raw: unknown) => {
      const data = (raw ?? {}) as Record<string, unknown>;
      const callId = String(data.callId ?? data.call_id ?? '');
      const kind = String(data.kind ?? data.signalType ?? data.type ?? '');
      if (!callId || !kind) return;
      const call = await getCall(callId).catch(() => null);
      if (!call) return;
      const participants = await assertParticipant(call, userId).catch(() => null);
      if (!participants) return;
      const toUserId = typeof data.toUserId === 'string' ? data.toUserId : null;
      const targets = toUserId
        ? participants.filter((id) => id === toUserId && id !== userId)
        : participants.filter((id) => id !== userId);
      emitToUsers(targets, 'call:signal', {
        callId,
        fromUserId: userId,
        kind,
        data: data.data ?? data.payload ?? null,
      });
    });

    socket.on('call:invite', async (raw: unknown, ack?: (resp: unknown) => void) => {
      try {
        const data = (raw ?? {}) as Record<string, unknown>;
        const type = (String(data.type ?? 'audio') as 'audio' | 'video' | 'group');
        const { call } = await createCallInvite({
          callerId: userId,
          calleeId: typeof data.calleeId === 'string' ? data.calleeId : null,
          conversationId: typeof data.conversationId === 'string' ? data.conversationId : null,
          type,
        });
        const { serializeCall } = await import('./services/calls');
        ack?.(await serializeCall(call));
      } catch (err) {
        ack?.({ error: (err as Error).message });
      }
    });

    const relay = (event: 'accept' | 'reject' | 'cancel' | 'end') => async (raw: unknown, ack?: (resp: unknown) => void) => {
      try {
        const data = (raw ?? {}) as Record<string, unknown>;
        const callId = String(data.callId ?? data.call_id ?? data.id ?? '');
        const updated = await transitionCall(callId, userId, event);
        const { serializeCall } = await import('./services/calls');
        ack?.(await serializeCall(updated));
      } catch (err) {
        ack?.({ error: (err as Error).message });
      }
    };
    socket.on('call:accept', relay('accept'));
    socket.on('call:reject', relay('reject'));
    socket.on('call:cancel', relay('cancel'));
    socket.on('call:end', relay('end'));

    socket.on('disconnect', () => {
      const fullyOffline = removePresence(userId, socket.id);
      if (fullyOffline) {
        void query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]).catch(() => undefined);
        io.emit('presence:update', { userId, isOnline: false, onlineUserIds: onlineUserIds() });
      }
    });
  });

  return io;
}
