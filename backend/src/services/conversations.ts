import { query } from '../db';
import { isOnline } from '../presence';
import { findUserById, toPublicUser, type PublicUser } from './users';

export interface ConversationRow {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  type: string;
  body: string | null;
  file_url: string | null;
  file_name: string | null;
  duration_sec: number | null;
  created_at: Date;
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

export function serializeMessage(m: MessageRow, status = 'sent') {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    conversation_id: m.conversation_id,
    senderId: m.sender_id,
    sender_id: m.sender_id,
    type: m.type,
    body: m.body,
    fileUrl: m.file_url,
    file_url: m.file_url,
    fileName: m.file_name,
    file_name: m.file_name,
    durationSeconds: m.duration_sec,
    duration_sec: m.duration_sec,
    durationSecondsAlt: m.duration_sec,
    createdAt: iso(m.created_at) ?? '',
    created_at: iso(m.created_at) ?? '',
    status,
  };
}

export async function isMember(conversationId: string, userId: string): Promise<boolean> {
  const { rows } = await query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId],
  );
  return rows.length > 0;
}

export async function memberIds(conversationId: string): Promise<string[]> {
  const { rows } = await query<{ user_id: string }>(
    'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
    [conversationId],
  );
  return rows.map((r) => r.user_id);
}

export async function getConversation(id: string): Promise<ConversationRow | null> {
  const { rows } = await query<ConversationRow>('SELECT * FROM conversations WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function serializeConversation(row: ConversationRow, viewerId: string) {
  const ids = await memberIds(row.id);
  const members: PublicUser[] = [];
  for (const id of ids) {
    const u = await findUserById(id);
    if (u) members.push(toPublicUser(u, isOnline(id)));
  }
  const { rows: lastRows } = await query<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1',
    [row.id],
  );
  const { rows: unreadRows } = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM messages m
     JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
     WHERE m.conversation_id = $1 AND m.sender_id <> $2
       AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)`,
    [row.id, viewerId],
  );
  const last = lastRows[0];
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    createdBy: row.created_by,
    created_by: row.created_by,
    memberIds: ids,
    member_ids: ids,
    members,
    lastMessage: last ? serializeMessage(last) : null,
    last_message: last ? serializeMessage(last) : null,
    unreadCount: Number.parseInt(unreadRows[0]?.count ?? '0', 10),
    unread_count: Number.parseInt(unreadRows[0]?.count ?? '0', 10),
    createdAt: iso(row.created_at) ?? '',
    updatedAt: iso(row.updated_at) ?? iso(row.created_at) ?? '',
    updated_at: iso(row.updated_at) ?? iso(row.created_at) ?? '',
  };
}

/** Persist a message + delivery receipts for the other members. Returns the row. */
export async function persistMessage(input: {
  conversationId: string;
  senderId: string;
  type: string;
  body?: string | null;
  fileUrl?: string | null;
  fileName?: string | null;
  durationSec?: number | null;
}): Promise<MessageRow> {
  const { rows } = await query<MessageRow>(
    `INSERT INTO messages (conversation_id, sender_id, type, body, file_url, file_name, duration_sec)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.conversationId,
      input.senderId,
      input.type,
      input.body ?? null,
      input.fileUrl ?? null,
      input.fileName ?? null,
      input.durationSec ?? null,
    ],
  );
  const message = rows[0];
  const others = (await memberIds(input.conversationId)).filter((id) => id !== input.senderId);
  for (const uid of others) {
    await query(
      `INSERT INTO message_receipts (message_id, user_id, delivered_at) VALUES ($1,$2,NOW())
       ON CONFLICT (message_id, user_id) DO NOTHING`,
      [message.id, uid],
    );
  }
  await query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [input.conversationId]);
  return message;
}

/** Delivery/read status of a message from the sender's point of view. */
export async function messageStatus(messageId: string, senderId: string): Promise<string> {
  const { rows } = await query<{ total: string; reads: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(read_at)::text AS reads
     FROM message_receipts WHERE message_id = $1 AND user_id <> $2`,
    [messageId, senderId],
  );
  const total = Number.parseInt(rows[0]?.total ?? '0', 10);
  const reads = Number.parseInt(rows[0]?.reads ?? '0', 10);
  if (total > 0 && reads >= total) return 'read';
  if (total > 0) return 'delivered';
  return 'sent';
}
