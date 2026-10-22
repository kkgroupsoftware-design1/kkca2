// DTOs — these mirror the backend serializers exactly
// (backend/src/services/users.ts, conversations.ts, calls.ts).
// The backend sends camelCase fields (plus snake_case aliases, which we ignore).

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isOnline: boolean;
  isActive: boolean;
  lastSeen: string | null;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: UserDto;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  type: 'text' | 'image' | 'document' | 'voice' | string;
  body: string | null;
  fileUrl: string | null;
  fileName: string | null;
  durationSeconds: number | null;
  createdAt: string;
  /** Only present on REST message lists / send responses: 'sent' | 'delivered' | 'read' (sender's view). */
  status?: string;
}

export interface ConversationDto {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  memberIds: string[];
  members: UserDto[];
  lastMessage: MessageDto | null;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UploadResponse {
  url: string; // e.g. "/api/files/<stored-name>"
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface IceServerDto {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface CallDto {
  id: string;
  callerId: string;
  calleeId: string | null;
  conversationId: string | null;
  caller: UserDto | null;
  callee: UserDto | null;
  type: 'audio' | 'video' | 'group';
  status: string; // ringing | accepted | missed | ended | rejected | cancelled...
  roomName: string | null;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
}

export interface InviteResponse {
  call: CallDto;
  iceServers: IceServerDto[];
}

export interface CallConfigResponse {
  iceServers: IceServerDto[];
  livekitUrl: string | null;
  maxGroupParticipants?: number;
}

export interface LiveKitTokenResponse {
  token: string;
  url: string;
  roomName: string;
  expiresInSeconds: number;
}

// ── Socket.IO payloads (backend/src/socket.ts contract) ─────────────────────

export interface PresencePayload {
  userId: string;
  isOnline: boolean;
  onlineUserIds: string[];
}

export interface TypingPayload {
  conversationId: string;
  userId: string;
  isTyping: boolean;
}

export interface IncomingCallPayload {
  callId: string;
  call: CallDto;
  iceServers: IceServerDto[];
}

export interface CallStatePayload {
  callId: string;
  action: string;
  status: string;
  call: CallDto;
}

export interface SignalPayload {
  callId: string;
  fromUserId: string;
  kind: string; // 'offer' | 'answer' | 'ice' | 'bye' | ...
  data: unknown;
}
