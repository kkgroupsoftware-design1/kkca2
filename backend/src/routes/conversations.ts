import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth, type AuthedRequest } from '../middleware/auth';
import { HttpError } from '../middleware/error';
import { emitToUsers } from '../realtime';
import { sendToUser } from '../fcm';
import { findUserById } from '../services/users';
import {
  getConversation,
  isMember,
  memberIds,
  messageStatus,
  persistMessage,
  serializeConversation,
  serializeMessage,
  type ConversationRow,
  type MessageRow,
} from '../services/conversations';

const createSchema = z.object({
  type: z.enum(['direct', 'group']),
  memberIds: z.array(z.string().uuid()).min(1).max(9).optional(),
  member_ids: z.array(z.string().uuid()).min(1).max(9).optional(),
  name: z.string().trim().min(1).max(120).optional().nullable(),
});

export const messageSchema = z.object({
  type: z.enum(['text', 'image', 'document', 'voice']).default('text'),
  body: z.string().max(10000).optional().nullable(),
  fileUrl: z.string().max(1000).optional().nullable(),
  file_url: z.string().max(1000).optional().nullable(),
  fileName: z.string().max(300).optional().nullable(),
  file_name: z.string().max(300).optional().nullable(),
  durationSeconds: z.number().int().min(0).max(86400).optional().nullable(),
  duration_sec: z.number().int().min(0).max(86400).optional().nullable(),
});

export function normalizeMessageInput(body: z.infer<typeof messageSchema>) {
  return {
    type: body.type,
    body: body.body ?? null,
    fileUrl: body.fileUrl ?? body.file_url ?? null,
    fileName: body.fileName ?? body.file_name ?? null,
    durationSec: body.durationSeconds ?? body.duration_sec ?? null,
  };
}

async function assertAuthorizedMembers(ids: string[]): Promise<void> {
  for (const id of ids) {
    const u = await findUserById(id);
    if (!u || !u.is_active) throw new HttpError(400, 'Every member must be an authorized, active team member');
  }
}

export function conversationsRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/', async (req: AuthedRequest, res, next) => {
    try {
      const { rows } = await query<ConversationRow>(
        `SELECT c.* FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
         ORDER BY c.updated_at DESC`,
        [req.user!.id],
      );
      const out = [];
      for (const row of rows) out.push(await serializeConversation(row, req.user!.id));
      res.json(out);
    } catch (err) { next(err); }
  });

  r.post('/', async (req: AuthedRequest, res, next) => {
    try {
      const body = createSchema.parse(req.body ?? {});
      const rawIds = body.member_ids ?? body.memberIds ?? [];
      if (!rawIds.length) throw new HttpError(400, 'memberIds is required');
      const others = [...new Set(rawIds.filter((id) => id !== req.user!.id))];
      await assertAuthorizedMembers(others);
      if (body.type === 'direct') {
        if (others.length !== 1) throw new HttpError(400, 'A direct conversation needs exactly one other member');
        const { rows } = await query<ConversationRow>(
          `SELECT c.* FROM conversations c
           WHERE c.type = 'direct'
             AND (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) = 2
             AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = $1)
             AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = $2)
           LIMIT 1`,
          [req.user!.id, others[0]],
        );
        if (rows[0]) { res.json(await serializeConversation(rows[0], req.user!.id)); return; }
      } else if (others.length < 2) {
        throw new HttpError(400, 'A group conversation needs at least 2 other members (3 total)');
      }
      const { rows } = await query<ConversationRow>(
        'INSERT INTO conversations (type, name, created_by) VALUES ($1,$2,$3) RETURNING *',
        [body.type, body.type === 'group' ? (body.name ?? null) : null, req.user!.id],
      );
      const conv = rows[0];
      for (const uid of [req.user!.id, ...others]) {
        await query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)', [conv.id, uid]);
      }
      res.status(201).json(await serializeConversation(conv, req.user!.id));
    } catch (err) { next(err); }
  });

  r.get('/:id/messages', async (req: AuthedRequest, res, next) => {
    try {
      const conv = await getConversation(req.params.id);
      if (!conv) throw new HttpError(404, 'Conversation not found');
      if (!(await isMember(conv.id, req.user!.id))) throw new HttpError(403, 'You are not a member of this conversation');
      const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? '100'), 10) || 100));
      const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);
      const before = typeof req.query.before === 'string' ? req.query.before : null;
      const { rows } = before
        ? await query<MessageRow>(
            'SELECT * FROM messages WHERE conversation_id = $1 AND created_at < $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4',
            [conv.id, before, limit, offset])
        : await query<MessageRow>(
            'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
            [conv.id, limit, offset]);
      const ordered = [...rows].reverse();
      const out = [];
      for (const m of ordered) out.push({ ...serializeMessage(m), status: await messageStatus(m.id, m.sender_id) });
      res.json(out);
    } catch (err) { next(err); }
  });

  r.post('/:id/messages', async (req: AuthedRequest, res, next) => {
    try {
      const conv = await getConversation(req.params.id);
      if (!conv) throw new HttpError(404, 'Conversation not found');
      if (!(await isMember(conv.id, req.user!.id))) throw new HttpError(403, 'You are not a member of this conversation');
      const input = normalizeMessageInput(messageSchema.parse(req.body ?? {}));
      if (input.type === 'text' && !input.body) throw new HttpError(400, 'Text messages need a body');
      if (input.type !== 'text' && !input.fileUrl) throw new HttpError(400, 'Attachment messages need a fileUrl (upload first)');
      const message = await persistMessage({ conversationId: conv.id, senderId: req.user!.id, ...input });
      const payload = serializeMessage(message);
      const others = (await memberIds(conv.id)).filter((id) => id !== req.user!.id);
      emitToUsers(others, 'message:new', payload);
      for (const uid of others) {
        void sendToUser(uid, { type: 'message', conversationId: conv.id, messageId: message.id, senderId: req.user!.id });
      }
      res.status(201).json({ ...payload, status: 'sent' });
    } catch (err) { next(err); }
  });

  r.post('/:id/read', async (req: AuthedRequest, res, next) => {
    try {
      const conv = await getConversation(req.params.id);
      if (!conv) throw new HttpError(404, 'Conversation not found');
      if (!(await isMember(conv.id, req.user!.id))) throw new HttpError(403, 'You are not a member of this conversation');
      await query(
        'UPDATE conversation_members SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2',
        [conv.id, req.user!.id]);
      await query(
        `UPDATE message_receipts mr SET read_at = NOW()
         FROM messages m
         WHERE mr.message_id = m.id AND m.conversation_id = $1 AND mr.user_id = $2 AND mr.read_at IS NULL`,
        [conv.id, req.user!.id]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  return r;
}
