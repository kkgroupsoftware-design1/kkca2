import { describe, expect, it } from 'vitest';
import { conversationTitle, formatDuration, initials, messagePreview, tickForStatus } from './utils';
import type { ConversationDto, MessageDto, UserDto } from './types';

describe('formatDuration', () => {
  it('formats seconds as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(600)).toBe('10:00');
  });
  it('formats hours as h:mm:ss', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
  });
  it('handles null/negative input', () => {
    expect(formatDuration(null)).toBe('0:00');
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('tickForStatus', () => {
  it('sent is a single tick', () => {
    expect(tickForStatus('sent')).toEqual({ glyph: '✓', kind: 'sent', label: 'Sent' });
  });
  it('delivered is a double tick, not green', () => {
    const t = tickForStatus('delivered');
    expect(t.glyph).toBe('✓✓');
    expect(t.kind).toBe('delivered');
  });
  it('read is a double green tick', () => {
    const t = tickForStatus('read');
    expect(t.glyph).toBe('✓✓');
    expect(t.kind).toBe('read');
  });
  it('unknown status falls back to sent', () => {
    expect(tickForStatus(undefined).kind).toBe('sent');
  });
});

const user = (id: string, displayName: string): UserDto => ({
  id,
  username: displayName.toLowerCase().replace(/\s/g, ''),
  displayName,
  avatarUrl: null,
  isOnline: false,
  isActive: true,
  lastSeen: null,
});

describe('conversationTitle / helpers', () => {
  it('uses the other member name for direct chats', () => {
    const conv: ConversationDto = {
      id: 'c1',
      type: 'direct',
      name: null,
      memberIds: ['me', 'u2'],
      members: [user('me', 'Malik One'), user('u2', 'Sara Ahmed')],
      lastMessage: null,
      unreadCount: 0,
      createdAt: '',
      updatedAt: '',
    };
    expect(conversationTitle(conv, 'me')).toBe('Sara Ahmed');
  });
  it('uses group name for groups', () => {
    const conv: ConversationDto = {
      id: 'c2',
      type: 'group',
      name: 'Team Alpha',
      memberIds: ['me', 'u2', 'u3'],
      members: [user('me', 'A'), user('u2', 'B'), user('u3', 'C')],
      lastMessage: null,
      unreadCount: 0,
      createdAt: '',
      updatedAt: '',
    };
    expect(conversationTitle(conv, 'me')).toBe('Team Alpha');
  });
  it('initials take first letters, capped sensibly', () => {
    expect(initials('Sara Ahmed')).toBe('SA');
    expect(initials('malik1')).toBe('MA');
    expect(initials('')).toBe('?');
  });
  it('previews voice messages with duration', () => {
    const m: MessageDto = {
      id: 'm1',
      conversationId: 'c1',
      senderId: 'u2',
      type: 'voice',
      body: null,
      fileUrl: '/api/files/x.webm',
      fileName: 'voice.webm',
      durationSeconds: 12,
      createdAt: new Date().toISOString(),
    };
    expect(messagePreview(m)).toContain('0:12');
  });
});
