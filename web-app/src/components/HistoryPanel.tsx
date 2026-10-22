import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CallDto, UserDto } from '../types';
import { formatDuration, formatListTime, userName } from '../utils';

interface Props {
  me: UserDto;
  refreshKey: number;
  onCall: (userId: string, type: 'audio' | 'video') => void;
  onJoinGroup: (roomName: string, callId: string) => void;
  onError: (msg: string) => void;
}

function statusLabel(call: CallDto, meId: string): { text: string; cls: string } {
  const incoming = call.callerId !== meId;
  switch (call.status) {
    case 'missed':
      return { text: incoming ? 'Missed call' : 'No answer', cls: 'missed' };
    case 'ended':
      return { text: incoming ? 'Incoming' : 'Outgoing', cls: 'ok' };
    case 'accepted':
      return { text: 'In progress', cls: 'ok' };
    case 'ringing':
      return { text: 'Ringing', cls: 'ok' };
    default:
      return { text: call.status, cls: '' };
  }
}

export default function HistoryPanel({ me, refreshKey, onCall, onJoinGroup, onError }: Props) {
  const [calls, setCalls] = useState<CallDto[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .callHistory()
      .then((list) => {
        if (alive) setCalls(list);
      })
      .catch(() => onError('Could not load call history'))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [refreshKey, onError]);

  if (loading) return <div className="empty-note">Loading call history…</div>;
  if (!calls.length) return <div className="empty-note">No calls yet.</div>;

  return (
    <div className="history-list">
      <h2>Call history</h2>
      {calls.map((call) => {
        const other = call.callerId === me.id ? call.callee : call.caller;
        const label = statusLabel(call, me.id);
        const otherId = call.callerId === me.id ? call.calleeId : call.callerId;
        return (
          <div key={call.id} className="history-row">
            <div className={`history-icon ${label.cls}`}>{call.type === 'video' || call.type === 'group' ? '📹' : '📞'}</div>
            <div className="history-main">
              <div className="history-name">
                {call.type === 'group' ? 'Group call' : userName(other)}
              </div>
              <div className="history-sub">
                <span className={label.cls === 'missed' ? 'text-missed' : ''}>{label.text}</span>
                {' · '}
                {formatListTime(call.createdAt)}
                {call.durationSeconds ? ` · ${formatDuration(call.durationSeconds)}` : ''}
              </div>
            </div>
            {call.type === 'group' && call.roomName ? (
              <button type="button" className="btn-small" onClick={() => onJoinGroup(call.roomName!, call.id)}>
                Join
              </button>
            ) : otherId ? (
              <>
                <button type="button" className="icon-btn" title="Audio call back" onClick={() => onCall(otherId, 'audio')}>
                  📞
                </button>
                <button type="button" className="icon-btn" title="Video call back" onClick={() => onCall(otherId, 'video')}>
                  📹
                </button>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
