import { apiFileUrl, runtimeConfig } from './config';
import type {
  CallConfigResponse,
  CallDto,
  ConversationDto,
  InviteResponse,
  LiveKitTokenResponse,
  LoginResponse,
  MessageDto,
  UploadResponse,
  UserDto,
} from './types';

const TOKEN_KEY = 'mtc_token';
const USER_KEY = 'mtc_user';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): UserDto | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as UserDto) : null;
  } catch {
    return null;
  }
}

export function storeSession(token: string, user: UserDto): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let res: Response;
  try {
    res = await fetch(`${runtimeConfig.apiUrl}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your internet connection and try again.');
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const message =
      (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
});

export const api = {
  login: (username: string, password: string) =>
    request<LoginResponse>('/api/auth/login', json({ username, password })),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<UserDto>('/api/auth/me'),
  users: () => request<UserDto[]>('/api/users'),
  conversations: () => request<ConversationDto[]>('/api/conversations'),
  createConversation: (body: { type: 'direct' | 'group'; memberIds: string[]; name?: string }) =>
    request<ConversationDto>('/api/conversations', json(body)),
  messages: (conversationId: string, limit = 100) =>
    request<MessageDto[]>(`/api/conversations/${conversationId}/messages?limit=${limit}`),
  sendMessage: (
    conversationId: string,
    body: {
      type: string;
      body?: string | null;
      fileUrl?: string | null;
      fileName?: string | null;
      durationSeconds?: number | null;
    },
  ) => request<MessageDto>(`/api/conversations/${conversationId}/messages`, json(body)),
  markRead: (conversationId: string) =>
    request<{ ok: boolean }>(`/api/conversations/${conversationId}/read`, { method: 'POST' }),
  upload: async (file: File | Blob, fileName: string): Promise<UploadResponse> => {
    const form = new FormData();
    const asFile = file instanceof File ? file : new File([file], fileName, { type: file.type || 'application/octet-stream' });
    form.append('file', asFile);
    return request<UploadResponse>('/api/upload', { method: 'POST', body: form });
  },
  inviteCall: (body: { calleeId?: string; conversationId?: string; type: 'audio' | 'video' | 'group' }) =>
    request<InviteResponse>('/api/calls/invite', json(body)),
  callAction: (callId: string, action: 'accept' | 'reject' | 'cancel' | 'end') =>
    request<CallDto>(`/api/calls/${callId}/${action}`, { method: 'POST' }),
  callHistory: () => request<CallDto[]>('/api/calls/history'),
  callConfig: () => request<CallConfigResponse>('/api/calls/config'),
  livekitToken: (body: { roomName: string; callId?: string; isGroup?: boolean }) =>
    request<LiveKitTokenResponse>('/api/livekit/token', json(body)),
};

const blobUrlCache = new Map<string, string>();

/**
 * Files on the backend require an Authorization header (GET /api/files/:name),
 * so a plain <img src> or <a href> cannot load them. Fetch the file as a blob
 * with the token applied and hand back an object URL the element can use.
 */
export async function fetchAuthedBlobUrl(fileUrl: string): Promise<string> {
  const cached = blobUrlCache.get(fileUrl);
  if (cached) return cached;
  const token = getToken();
  const res = await fetch(apiFileUrl(fileUrl), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new ApiError(res.status, 'Could not load the file');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(fileUrl, url);
  return url;
}

/** Download/open an authenticated file in a new tab. */
export async function openAuthedFile(fileUrl: string): Promise<void> {
  const url = await fetchAuthedBlobUrl(fileUrl);
  window.open(url, '_blank', 'noopener');
}
