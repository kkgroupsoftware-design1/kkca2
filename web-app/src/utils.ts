import type { ConversationDto, MessageDto, UserDto } from './types';

/** 0 -> "0:00", 65 -> "1:05", 600 -> "10:00", 3661 -> "1:01:01" */
export function formatDuration(totalSeconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(totalSeconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export interface MessageTick {
  /** '✓' sent, '✓✓' delivered or read. */
  glyph: string;
  /** 'read' renders green, everything else muted. */
  kind: 'sent' | 'delivered' | 'read';
  label: string;
}

/**
 * Delivery/read ticks for MY messages, from the backend `status` field
 * (backend computes it from message_receipts: all recipients read => 'read',
 * receipts exist => 'delivered', otherwise 'sent').
 */
export function tickForStatus(status: string | undefined | null): MessageTick {
  switch (status) {
    case 'read':
      return { glyph: '✓✓', kind: 'read', label: 'Read' };
    case 'delivered':
      return { glyph: '✓✓', kind: 'delivered', label: 'Delivered' };
    default:
      return { glyph: '✓', kind: 'sent', label: 'Sent' };
  }
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function userName(user: UserDto | null | undefined, fallback = 'Team member'): string {
  if (!user) return fallback;
  return user.displayName || user.username || fallback;
}

/** Title shown for a conversation: group name, or the other member's name for direct chats. */
export function conversationTitle(conv: ConversationDto, meId: string): string {
  if (conv.type === 'group') {
    if (conv.name) return conv.name;
    const names = conv.members.filter((m) => m.id !== meId).map((m) => userName(m));
    return names.length ? names.join(', ') : 'Group';
  }
  const other = conv.members.find((m) => m.id !== meId) ?? conv.members[0];
  return userName(other, 'Direct chat');
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatListTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

/** Short preview line for the conversation list. */
export function messagePreview(message: MessageDto | null): string {
  if (!message) return 'No messages yet';
  switch (message.type) {
    case 'image':
      return '📷 Photo';
    case 'document':
      return `📄 ${message.fileName ?? 'Document'}`;
    case 'voice':
      return `🎤 Voice message (${formatDuration(message.durationSeconds)})`;
    default:
      return message.body ?? '';
  }
}
