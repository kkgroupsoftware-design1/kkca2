import { io, type Socket } from 'socket.io-client';
import { runtimeConfig } from './config';
import { getToken } from './api';
import type {
  CallStatePayload,
  IncomingCallPayload,
  MessageDto,
  PresencePayload,
  SignalPayload,
  TypingPayload,
} from './types';

/**
 * Thin wrapper over the Socket.IO connection to the backend.
 * Contract: backend/src/socket.ts — the JWT goes in the handshake auth,
 * presence/message/call events are relayed by the server per user room.
 */
type Handler<T> = (payload: T) => void;

export class SocketManager {
  private socket: Socket | null = null;
  private handlers = new Map<string, Set<Handler<never>>>();

  connect(): void {
    if (this.socket) return;
    const token = getToken();
    if (!token) return;
    const socket = io(runtimeConfig.apiUrl || window.location.origin, {
      auth: { token },
      transports: ['websocket', 'polling'],
      autoConnect: true,
    });
    this.socket = socket;
    for (const [event, set] of this.handlers) {
      for (const handler of set) socket.on(event, handler as Handler<unknown>);
    }
    socket.on('connect_error', (err: Error) => {
      // Session expired/revoked — surface via a DOM event so App can log out.
      if (/revoked|expired|authorized|Authentication/i.test(err.message)) {
        window.dispatchEvent(new CustomEvent('mtc:session-expired'));
      }
    });
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  get connected(): boolean {
    return !!this.socket?.connected;
  }

  on<T>(event: string, handler: Handler<T>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    if (this.socket) this.socket.on(event, handler as Handler<unknown>);
    return () => {
      set.delete(handler as Handler<never>);
      this.socket?.off(event, handler as Handler<unknown>);
    };
  }

  onPresence(handler: Handler<PresencePayload>): () => void {
    return this.on('presence:update', handler);
  }
  onMessage(handler: Handler<MessageDto>): () => void {
    return this.on('message:new', handler);
  }
  onTyping(handler: Handler<TypingPayload>): () => void {
    return this.on('message:typing', handler);
  }
  onIncomingCall(handler: Handler<IncomingCallPayload>): () => void {
    return this.on('call:incoming', handler);
  }
  onCallState(event: 'call:accepted' | 'call:rejected' | 'call:cancelled' | 'call:ended', handler: Handler<CallStatePayload>): () => void {
    return this.on(event, handler);
  }
  onSignal(handler: Handler<SignalPayload>): () => void {
    return this.on('call:signal', handler);
  }

  emitTyping(conversationId: string, isTyping: boolean): void {
    this.socket?.emit('message:typing', { conversationId, isTyping });
  }

  emitSignal(payload: { callId: string; kind: string; data: unknown; toUserId?: string }): void {
    this.socket?.emit('call:signal', payload);
  }
}

export const socketManager = new SocketManager();
