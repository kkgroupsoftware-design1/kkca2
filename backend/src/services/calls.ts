import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import { HttpError } from '../middleware/error';
import { emitToUser, emitToUsers } from '../realtime';
import { sendToUser } from '../fcm';
import { iceServers } from '../config';
import { findUserById, toPublicUser } from './users';
import { memberIds } from './conversations';

export interface CallRow {
  id: string;
  caller_id: string;
  callee_id: string | null;
  conversation_id: string | null;
  room_name: string;
  type: 'audio' | 'video' | 'group';
  status: string;
  started_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

export async function serializeCall(row: CallRow) {
  const caller = await findUserById(row.caller_id);
  const callee = row.callee_id ? await findUserById(row.callee_id) : null;
  const durationSeconds =
    row.answered_at && row.ended_at
      ? Math.max(0, Math.round((new Date(row.ended_at).getTime() - new Date(row.answered_at).getTime()) / 1000))
      : null;
  return {
    id: row.id,
    callerId: row.caller_id,
    caller_id: row.caller_id,
    calleeId: row.callee_id,
    callee_id: row.callee_id,
    conversationId: row.conversation_id,
    conversation_id: row.conversation_id,
    caller: caller ? toPublicUser(caller) : null,
    callee: callee ? toPublicUser(callee) : null,
    type: row.type,
    status: row.status,
    roomName: row.room_name,
    room_name: row.room_name,
    createdAt: iso(row.created_at) ?? '',
    created_at: iso(row.created_at) ?? '',
    startedAt: iso(row.started_at),
    answeredAt: iso(row.answered_at),
    endedAt: iso(row.ended_at),
    ended_at: iso(row.ended_at),
    durationSeconds,
    duration_seconds: durationSeconds,
  };
}

export async function getCall(id: string): Promise<CallRow | null> {
  const { rows } = await query<CallRow>('SELECT * FROM calls WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Everyone entitled to be in this call: caller, callee, or group-conversation members. */
export async function callParticipants(call: CallRow): Promise<string[]> {
  const ids = new Set<string>([call.caller_id]);
  if (call.callee_id) ids.add(call.callee_id);
  if (call.conversation_id) {
    for (const id of await memberIds(call.conversation_id)) ids.add(id);
  }
  return [...ids];
}

export async function assertParticipant(call: CallRow, userId: string): Promise<string[]> {
  const participants = await callParticipants(call);
  if (!participants.includes(userId)) throw new HttpError(403, 'You are not a participant of this call');
  return participants;
}

export async function createCallInvite(input: {
  callerId: string;
  calleeId?: string | null;
  conversationId?: string | null;
  type: 'audio' | 'video' | 'group';
}): Promise<{ call: CallRow; participants: string[] }> {
  const roomName = `mtc-${uuidv4()}`;
  const { rows } = await query<CallRow>(
    `INSERT INTO calls (caller_id, callee_id, conversation_id, room_name, type, status)
     VALUES ($1,$2,$3,$4,'ringing') RETURNING *`,
    [input.callerId, input.calleeId ?? null, input.conversationId ?? null, roomName, input.type],
  );
  const call = rows[0];
  const participants = await callParticipants(call);
  const payload = {
    callId: call.id,
    call: await serializeCall(call),
    iceServers: iceServers(),
    ice_servers: iceServers(),
  };
  const targets = participants.filter((id) => id !== input.callerId);
  emitToUsers(targets, 'call:incoming', payload);
  // Push wake-up for backgrounded / not-yet-connected devices (no-op if FCM off).
  const caller = await findUserById(input.callerId);
  for (const target of targets) {
    void sendToUser(
      target,
      {
        type: 'incoming_call',
        callId: call.id,
        callType: call.type,
        roomName: call.room_name,
        callerId: call.caller_id,
        callerName: caller?.display_name ?? caller?.username ?? 'Team member',
      },
      { title: 'Incoming call', body: `${caller?.display_name ?? caller?.username ?? 'A team member'} is calling` },
    );
  }
  return { call, participants };
}

type Transition = 'accept' | 'reject' | 'cancel' | 'end';

/**
 * Call state machine. Missed-call rule: a reject/cancel of a still-ringing
 * call is recorded as `missed` for the callee (the row keeps the acting event
 * in the socket payload so both clients render the right screen).
 */
export async function transitionCall(callId: string, actorId: string, action: Transition): Promise<CallRow> {
  const call = await getCall(callId);
  if (!call) throw new HttpError(404, 'Call not found');
  const participants = await assertParticipant(call, actorId);

  let status: string;
  let event: string;
  const now = new Date();
  if (action === 'accept') {
    if (call.status !== 'ringing') throw new HttpError(409, `Call is ${call.status}, cannot accept`);
    if (actorId === call.caller_id) throw new HttpError(403, 'Caller cannot accept their own call');
    status = 'accepted';
    event = 'call:accepted';
    await query('UPDATE calls SET status=$2, answered_at=$3 WHERE id=$1', [callId, status, now]);
  } else if (action === 'reject') {
    if (call.status !== 'ringing' && call.status !== 'accepted') throw new HttpError(409, `Call is ${call.status}`);
    status = call.status === 'ringing' ? 'missed' : 'ended';
    event = 'call:rejected';
    await query('UPDATE calls SET status=$2, ended_at=$3 WHERE id=$1', [callId, status, now]);
  } else if (action === 'cancel') {
    if (actorId !== call.caller_id && call.type !== 'group') throw new HttpError(403, 'Only the caller can cancel');
    if (call.status !== 'ringing') throw new HttpError(409, `Call is ${call.status}, cannot cancel`);
    status = 'missed';
    event = 'call:cancelled';
    await query('UPDATE calls SET status=$2, ended_at=$3 WHERE id=$1', [callId, status, now]);
  } else {
    // end
    if (call.status !== 'accepted' && call.status !== 'ringing') throw new HttpError(409, `Call is ${call.status}`);
    status = call.status === 'ringing' ? 'missed' : 'ended';
    event = 'call:ended';
    await query('UPDATE calls SET status=$2, ended_at=$3 WHERE id=$1', [callId, status, now]);
  }

  const updated = (await getCall(callId)) ?? call;
  const payload = {
    callId,
    action,
    status: updated.status,
    call: await serializeCall(updated),
  };
  emitToUsers(participants.filter((id) => id !== actorId), event, payload);
  return updated;
}
