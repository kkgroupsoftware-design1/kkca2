import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, clearSession, getStoredUser, getToken } from './api';
import { callManager } from './callManager';
import { socketManager } from './socket';
import type { ConversationDto, UserDto } from './types';
import { conversationTitle, formatListTime, initials, messagePreview, userName } from './utils';
import CallPanel from './components/CallPanel';
import ChatView from './components/ChatView';
import GroupCall from './components/GroupCall';
import HistoryPanel from './components/HistoryPanel';
import Login from './components/Login';

interface Toast {
  id: number;
  text: string;
}

interface GroupSession {
  roomName: string;
  callId?: string;
  title: string;
}

export default function App() {
  const [me, setMe] = useState<UserDto | null>(() => (getToken() ? getStoredUser() : null));
  const [users, setUsers] = useState<UserDto[]>([]);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<'chats' | 'history'>('chats');
  const [groupSession, setGroupSession] = useState<GroupSession | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [historyKey, setHistoryKey] = useState(0);

  // Group creation dialog
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupMembers, setGroupMembers] = useState<Set<string>>(new Set());

  const toastId = useRef(0);
  const notify = useCallback((text: string) => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev, { id, text }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
  }, []);

  const usersById = useMemo(() => {
    const map = new Map<string, UserDto>();
    for (const u of users) map.set(u.id, { ...u, isOnline: onlineIds.has(u.id) || u.isOnline });
    if (me && !map.has(me.id)) map.set(me.id, me);
    return map;
  }, [users, onlineIds, me]);

  const refreshConversations = useCallback(() => {
    api
      .conversations()
      .then(setConversations)
      .catch(() => undefined);
  }, []);

  const refreshUsers = useCallback(() => {
    api
      .users()
      .then((list) => {
        setUsers(list);
        setOnlineIds(new Set(list.filter((u) => u.isOnline).map((u) => u.id)));
      })
      .catch(() => undefined);
  }, []);

  // ── Session lifecycle ──────────────────────────────────────────────────────
  const handleLoggedIn = useCallback(
    (user: UserDto) => {
      setMe(user);
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* token may already be gone server-side */
    }
    callManager.reset(false);
    socketManager.disconnect();
    clearSession();
    setMe(null);
    setUsers([]);
    setConversations([]);
    setSelectedId(null);
    setGroupSession(null);
  }, []);

  useEffect(() => {
    if (!me) return;
    socketManager.connect();
    const detachCalls = callManager.attachSocket();
    callManager.onNotice = (msg) => {
      notify(msg);
      setHistoryKey((k) => k + 1);
    };
    callManager.onJoinGroup = (roomName, callId) => {
      setGroupSession({ roomName, callId, title: 'Group call' });
    };
    refreshUsers();
    refreshConversations();

    // Ask for browser-notification permission once, after login, so an
    // incoming call can pop a notification when this tab is in the background.
    // (Notifications can only appear while the browser is running — there is
    // no Web Push in this app.)
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined);
    }

    const offPresence = socketManager.onPresence((payload) => {
      setOnlineIds(new Set(payload.onlineUserIds));
    });
    const offMessage = socketManager.onMessage(() => {
      refreshConversations();
    });
    const onExpired = () => {
      notify('Your session has expired. Please sign in again.');
      socketManager.disconnect();
      clearSession();
      setMe(null);
    };
    window.addEventListener('mtc:session-expired', onExpired);
    return () => {
      offPresence();
      offMessage();
      detachCalls();
      window.removeEventListener('mtc:session-expired', onExpired);
    };
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ────────────────────────────────────────────────────────────────
  async function openDirectChat(user: UserDto) {
    try {
      const conv = await api.createConversation({ type: 'direct', memberIds: [user.id] });
      refreshConversations();
      setView('chats');
      setSelectedId(conv.id);
    } catch {
      notify('Could not open the chat');
    }
  }

  async function createGroup() {
    if (!groupName.trim() || groupMembers.size < 2) {
      notify('Give the group a name and pick at least 2 members');
      return;
    }
    try {
      const conv = await api.createConversation({
        type: 'group',
        name: groupName.trim(),
        memberIds: [...groupMembers],
      });
      setGroupOpen(false);
      setGroupName('');
      setGroupMembers(new Set());
      refreshConversations();
      setView('chats');
      setSelectedId(conv.id);
    } catch {
      notify('Group could not be created');
    }
  }

  async function startGroupCall(conv: ConversationDto) {
    try {
      // Creates a ringing group call on the server; members get an
      // "incoming call" invitation they can Join. We join our own room here.
      const { call } = await api.inviteCall({ conversationId: conv.id, type: 'group' });
      setGroupSession({
        roomName: call.roomName ?? `group-${conv.id}`,
        callId: call.id,
        title: conversationTitle(conv, me!.id),
      });
    } catch {
      notify('Could not start the group call');
    }
  }

  function joinGroupRoom(roomName: string, callId: string) {
    setGroupSession({ roomName, callId, title: 'Group call' });
  }

  const selected = conversations.find((c) => c.id === selectedId) ?? null;
  const teamOthers = users.filter((u) => u.id !== me?.id);

  if (!me) {
    return <Login onLoggedIn={handleLoggedIn} />;
  }

  return (
    <div className={`app-shell ${selectedId ? 'show-main' : ''}`}>
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside className="sidebar">
        <header className="side-header">
          <div className="avatar">{initials(userName(me))}</div>
          <div className="side-me">
            <div className="side-me-name">{userName(me)}</div>
            <div className="side-me-sub">@{me.username}</div>
          </div>
          <button type="button" className="btn-small" onClick={() => void logout()} title="Sign out">
            Logout
          </button>
        </header>

        <nav className="side-nav">
          <button type="button" className={view === 'chats' ? 'active' : ''} onClick={() => setView('chats')}>
            💬 Chats
          </button>
          <button type="button" className={view === 'history' ? 'active' : ''} onClick={() => { setView('history'); setHistoryKey((k) => k + 1); }}>
            🕘 History
          </button>
          <button type="button" onClick={() => setGroupOpen(true)}>
            👥 New group
          </button>
        </nav>

        <div className="side-section-title">Team ({teamOthers.length + 1} members)</div>
        <ul className="team-list">
          {teamOthers.map((u) => {
            const online = onlineIds.has(u.id) || u.isOnline;
            return (
              <li key={u.id} className="team-row">
                <span className="avatar-wrap">
                  <span className="avatar">{initials(userName(u))}</span>
                  <span className={`dot ${online ? 'on' : 'off'}`} />
                </span>
                <span className="team-name">
                  {userName(u)}
                  <small>@{u.username}</small>
                </span>
                <button type="button" className="icon-btn" title="Chat" onClick={() => void openDirectChat(u)}>💬</button>
                <button type="button" className="icon-btn" title="Audio call" onClick={() => void callManager.startCall(u.id, 'audio')}>📞</button>
                <button type="button" className="icon-btn" title="Video call" onClick={() => void callManager.startCall(u.id, 'video')}>📹</button>
              </li>
            );
          })}
        </ul>

        <div className="side-section-title">Conversations</div>
        <ul className="conv-list">
          {conversations.map((conv) => {
            const title = conversationTitle(conv, me.id);
            const other = conv.type === 'direct' ? conv.members.find((m) => m.id !== me.id) : undefined;
            const online = other ? onlineIds.has(other.id) || other.isOnline : false;
            return (
              <li key={conv.id}>
                <button
                  type="button"
                  className={`conv-row ${conv.id === selectedId && view === 'chats' ? 'active' : ''}`}
                  onClick={() => {
                    setView('chats');
                    setSelectedId(conv.id);
                  }}
                >
                  <span className="avatar-wrap">
                    <span className="avatar">{conv.type === 'group' ? '👥' : initials(title)}</span>
                    {conv.type === 'direct' && <span className={`dot ${online ? 'on' : 'off'}`} />}
                  </span>
                  <span className="conv-main">
                    <span className="conv-top">
                      <span className="conv-name">{title}</span>
                      <span className="conv-time">{formatListTime(conv.lastMessage?.createdAt ?? conv.updatedAt)}</span>
                    </span>
                    <span className="conv-bottom">
                      <span className="conv-preview">{messagePreview(conv.lastMessage)}</span>
                      {conv.unreadCount > 0 && <span className="badge">{conv.unreadCount}</span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {conversations.length === 0 && <li className="empty-note">No conversations yet — tap a team member to start.</li>}
        </ul>
      </aside>

      {/* ── Main pane ───────────────────────────────────────── */}
      <main className="main-pane">
        {groupSession ? (
          <GroupCall
            roomName={groupSession.roomName}
            callId={groupSession.callId}
            title={groupSession.title}
            onLeave={() => setGroupSession(null)}
            onError={notify}
          />
        ) : view === 'history' ? (
          <HistoryPanel
            me={me}
            refreshKey={historyKey}
            onCall={(userId, type) => void callManager.startCall(userId, type)}
            onJoinGroup={joinGroupRoom}
            onError={notify}
          />
        ) : selected ? (
          <ChatView
            key={selected.id}
            conversation={selected}
            me={me}
            usersById={usersById}
            onBack={() => setSelectedId(null)}
            onActivity={refreshConversations}
            onStartGroupCall={(conv) => void startGroupCall(conv)}
            onError={notify}
          />
        ) : (
          <div className="welcome">
            <div className="login-logo">M</div>
            <h2>Malik Team Connect</h2>
            <p>Select a conversation, or tap a team member on the left to chat or call.</p>
            <p className="welcome-note">
              Calls ring only while this browser tab is open — keep it open (or pinned) to receive calls.
            </p>
          </div>
        )}
      </main>

      {/* ── Group creation dialog ───────────────────────────── */}
      {groupOpen && (
        <div className="modal-backdrop" onClick={() => setGroupOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Create group</h3>
            <label>
              Group name
              <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="e.g. Team Alpha" />
            </label>
            <div className="member-pick">
              {teamOthers.map((u) => (
                <label key={u.id} className="member-pick-row">
                  <input
                    type="checkbox"
                    checked={groupMembers.has(u.id)}
                    onChange={(e) => {
                      setGroupMembers((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(u.id);
                        else next.delete(u.id);
                        return next;
                      });
                    }}
                  />
                  {userName(u)} <small>@{u.username}</small>
                </label>
              ))}
            </div>
            <p className="modal-note">Pick at least 2 members (3 people total including you). Max team size is 10.</p>
            <div className="modal-actions">
              <button type="button" className="btn-small" onClick={() => setGroupOpen(false)}>Cancel</button>
              <button type="button" className="btn-green" onClick={() => void createGroup()}>Create group</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Overlays + toasts ───────────────────────────────── */}
      <CallPanel />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast">{t.text}</div>
        ))}
      </div>
    </div>
  );
}
