import { Router } from 'express';
import { z } from 'zod';
import { config, iceServers } from '../config';
import { query } from '../db';
import { requireAuth, type AuthedRequest } from '../middleware/auth';
import { HttpError } from '../middleware/error';
import { AccessToken } from 'livekit-server-sdk';
import { getConversation, isMember } from '../services/conversations';
import { findUserById } from '../services/users';
import {
  createCallInvite,
  getCall,
  serializeCall,
  transitionCall,
  type CallRow,
} from '../services/calls';

const inviteSchema = z.object({
  calleeId: z.string().uuid().optional().nullable(),
  callee_id: z.string().uuid().optional().nullable(),
  conversationId: z.string().uuid().optional().nullable(),
  conversation_id: z.string().uuid().optional().nullable(),
  type: z.enum(['audio', 'video', 'group']).default('audio'),
});

const livekitSchema = z.object({
  roomName: z.string().trim().min(1).max(200),
  room_name: z.string().trim().min(1).max(200).optional(),
  callId: z.string().uuid().optional().nullable(),
  call_id: z.string().uuid().optional().nullable(),
  isGroup: z.boolean().optional(),
});

export function callsRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  // GET /api/calls/config — also mounted at /api/config/calls in app.ts
  r.get('/config', (_req: AuthedRequest, res) => {
    res.json({
      iceServers: iceServers(),
      ice_servers: iceServers(),
      livekitUrl: config.livekit.url || null,
      livekit_url: config.livekit.url || null,
      maxGroupParticipants: config.maxUsers,
    });
  });

  r.get('/history', async (req: AuthedRequest, res, next) => {
    try {
      const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? '100'), 10) || 100));
      const { rows } = await query<CallRow>(
        `SELECT DISTINCT c.* FROM calls c
         LEFT JOIN conversation_members cm ON cm.conversation_id = c.conversation_id AND cm.user_id = $1
         WHERE c.caller_id = $1 OR c.callee_id = $1 OR cm.user_id IS NOT NULL
         ORDER BY c.created_at DESC LIMIT $2`,
        [req.user!.id, limit],
      );
      const out = [];
      for (const row of rows) out.push(await serializeCall(row));
      res.json(out);
    } catch (err) { next(err); }
  });

  r.post('/invite', async (req: AuthedRequest, res, next) => {
    try {
      const body = inviteSchema.parse(req.body ?? {});
      const calleeId = body.calleeId ?? body.callee_id ?? null;
      const conversationId = body.conversationId ?? body.conversation_id ?? null;

      if (body.type === 'group' || conversationId) {
        if (!conversationId) throw new HttpError(400, 'Group calls need a conversationId (group conversation)');
        const conv = await getConversation(conversationId);
        if (!conv) throw new HttpError(404, 'Conversation not found');
        if (!(await isMember(conv.id, req.user!.id))) throw new HttpError(403, 'You are not a member of this conversation');
        const { call } = await createCallInvite({ callerId: req.user!.id, conversationId: conv.id, type: 'group' });
        res.status(201).json({ call: await serializeCall(call), iceServers: iceServers(), ice_servers: iceServers() });
        return;
      }

      if (!calleeId) throw new HttpError(400, 'calleeId is required for one-to-one calls');
      if (calleeId === req.user!.id) throw new HttpError(400, 'You cannot call yourself');
      const callee = await findUserById(calleeId);
      if (!callee || !callee.is_active) throw new HttpError(400, 'Callee is not an authorized, active team member');
      const { call } = await createCallInvite({ callerId: req.user!.id, calleeId, type: body.type });
      res.status(201).json({ call: await serializeCall(call), iceServers: iceServers(), ice_servers: iceServers() });
    } catch (err) { next(err); }
  });

  for (const action of ['accept', 'reject', 'cancel', 'end'] as const) {
    r.post(`/:id/${action}`, async (req: AuthedRequest, res, next) => {
      try {
        const updated = await transitionCall(req.params.id, req.user!.id, action);
        res.json(await serializeCall(updated));
      } catch (err) { next(err); }
    });
  }

  return r;
}

export function livekitRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.post('/token', async (req: AuthedRequest, res, next) => {
    try {
      if (!config.livekit.configured) {
        res.status(503).json({
          error: 'LiveKit is not configured on the server. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.',
        });
        return;
      }
      const body = livekitSchema.parse(req.body ?? {});
      const roomName = body.room_name ?? body.roomName;

      // Authorization: caller must be a participant of the referenced call,
      // a member of the referenced conversation, or — for ad-hoc team rooms —
      // an active authorized team member (the team is a closed set of 10).
      if (body.callId ?? body.call_id) {
        const call = await getCall((body.callId ?? body.call_id)!);
        if (!call) throw new HttpError(404, 'Call not found');
        const { assertParticipant } = await import('../services/calls');
        await assertParticipant(call, req.user!.id);
        if (call.room_name !== roomName) throw new HttpError(403, 'Room does not match this call');
      } else {
        const { rows } = await query<CallRow>('SELECT * FROM calls WHERE room_name = $1 LIMIT 1', [roomName]);
        if (rows[0]) {
          const { assertParticipant } = await import('../services/calls');
          await assertParticipant(rows[0], req.user!.id);
        } else {
          const conv = await getConversation(roomName).catch(() => null);
          if (conv && !(await isMember(conv.id, req.user!.id))) {
            throw new HttpError(403, 'You are not a member of this conversation');
          }
          // Otherwise: ad-hoc room for the authorized team (active user check
          // already happened in requireAuth).
        }
      }

      const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
        identity: req.user!.id,
        name: req.user!.display_name ?? req.user!.username,
        ttl: '1h',
      });
      at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
      const token = await at.toJwt();
      res.json({ token, url: config.livekit.url, roomName, expiresInSeconds: 3600 });
    } catch (err) { next(err); }
  });

  return r;
}
