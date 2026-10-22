import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fetchAuthedBlobUrl, openAuthedFile } from '../api';
import { socketManager } from '../socket';
import type { ConversationDto, MessageDto, UserDto } from '../types';
import { conversationTitle, formatDuration, formatTime, initials, tickForStatus, userName } from '../utils';

/** Image / voice / document rendering for files that need an auth header. */
function AuthedMedia({ message, onError }: { message: MessageDto; onError: (msg: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!message.fileUrl) return;
    fetchAuthedBlobUrl(message.fileUrl)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [message.fileUrl]);

  if (!message.fileUrl) return null;
  if (failed) return <div className="media-failed">⚠ File unavailable</div>;
  if (!url) return <div className="media-loading">Loading…</div>;

  if (message.type === 'image') {
    return <img className="chat-image" src={url} alt={message.fileName ?? 'Shared photo'} loading="lazy" />;
  }
  if (message.type === 'voice') {
    return (
      <span className="voice-msg">
        <audio controls src={url} preload="metadata" />
        <span className="voice-dur">{formatDuration(message.durationSeconds)}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="doc-msg"
      onClick={() => void openAuthedFile(message.fileUrl!).catch(() => onError('Could not open the file'))}
    >
      📄 <span>{message.fileName ?? 'Document'}</span>
    </button>
  );
}

interface Props {
  conversation: ConversationDto;
  me: UserDto;
  usersById: Map<string, UserDto>;
  onBack: () => void;
  onActivity: () => void; // refresh the conversation list (unread, last message)
  onStartGroupCall: (conversation: ConversationDto) => void;
  onError: (msg: string) => void;
}

export default function ChatView({ conversation, me, usersById, onBack, onActivity, onStartGroupCall, onError }: Props) {
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<number | null>(null);
  const recStartRef = useRef(0);
  const typingTimeoutRef = useRef<number | null>(null);
  const lastTypingSentRef = useRef(0);
  const convId = conversation.id;

  const appendMessage = useCallback((msg: MessageDto) => {
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
  }, []);

  // Load history + mark read whenever the open conversation changes.
  useEffect(() => {
    let alive = true;
    setMessages([]);
    api
      .messages(convId)
      .then((list) => {
        if (alive) setMessages(list);
      })
      .catch(() => onError('Could not load messages'));
    void api.markRead(convId).then(() => onActivity()).catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);

  // Live messages + typing for this conversation.
  useEffect(() => {
    const offMsg = socketManager.onMessage((msg) => {
      if (msg.conversationId !== convId) return;
      appendMessage(msg);
      void api.markRead(convId).catch(() => undefined);
      onActivity();
    });
    const offTyping = socketManager.onTyping((payload) => {
      if (payload.conversationId !== convId || payload.userId === me.id) return;
      const name = userName(usersById.get(payload.userId), 'Someone');
      setTypingNames((prev) => {
        const without = prev.filter((n) => n !== name);
        return payload.isTyping ? [...without, name] : without;
      });
      if (payload.isTyping) {
        window.setTimeout(() => {
          setTypingNames((prev) => prev.filter((n) => n !== name));
        }, 4000);
      }
    });
    return () => {
      offMsg();
      offTyping();
    };
  }, [convId, me.id, usersById, appendMessage, onActivity]);

  // Keep the latest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, typingNames.length]);

  function emitTyping(isTyping: boolean) {
    socketManager.emitTyping(convId, isTyping);
  }

  function handleDraftChange(value: string) {
    setDraft(value);
    const now = Date.now();
    if (value && now - lastTypingSentRef.current > 2500) {
      lastTypingSentRef.current = now;
      emitTyping(true);
    }
    if (typingTimeoutRef.current) window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => emitTyping(false), 3000);
  }

  async function sendText(e?: React.FormEvent) {
    e?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const msg = await api.sendMessage(convId, { type: 'text', body });
      appendMessage({ ...msg, status: 'delivered' });
      setDraft('');
      emitTyping(false);
      onActivity();
    } catch {
      onError('Message could not be sent');
    } finally {
      setSending(false);
    }
  }

  async function handleFileChosen(file: File | null) {
    if (!file) return;
    setSending(true);
    try {
      const uploaded = await api.upload(file, file.name);
      const type = file.type.startsWith('image/') ? 'image' : 'document';
      const msg = await api.sendMessage(convId, {
        type,
        fileUrl: uploaded.url,
        fileName: uploaded.name || file.name,
      });
      appendMessage({ ...msg, status: 'delivered' });
      onActivity();
    } catch {
      onError('File could not be sent (25 MB max, common document/image types only)');
    } finally {
      setSending(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size) recChunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        for (const t of stream.getTracks()) t.stop();
        if (recTimerRef.current) window.clearInterval(recTimerRef.current);
        setRecording(false);
        const duration = Math.max(1, Math.round((Date.now() - recStartRef.current) / 1000));
        const blob = new Blob(recChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const ext = blob.type.includes('ogg') ? 'ogg' : 'webm';
        const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type });
        void (async () => {
          setSending(true);
          try {
            const uploaded = await api.upload(file, file.name);
            const msg = await api.sendMessage(convId, {
              type: 'voice',
              fileUrl: uploaded.url,
              fileName: uploaded.name || file.name,
              durationSeconds: duration,
            });
            appendMessage({ ...msg, status: 'delivered' });
            onActivity();
          } catch {
            onError('Voice message could not be sent');
          } finally {
            setSending(false);
          }
        })();
      };
      recStartRef.current = Date.now();
      setRecSeconds(0);
      recTimerRef.current = window.setInterval(() => {
        setRecSeconds(Math.floor((Date.now() - recStartRef.current) / 1000));
      }, 250);
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      onError('Microphone is not available or permission was denied');
    }
  }

  const title = conversationTitle(conversation, me.id);
  const others = conversation.members.filter((m) => m.id !== me.id);
  const subtitle =
    conversation.type === 'group'
      ? `${conversation.members.length} members: ${conversation.members.map((m) => userName(m)).join(', ')}`
      : others[0]?.isOnline
        ? 'Online'
        : others[0]?.lastSeen
          ? `Last seen ${new Date(others[0].lastSeen).toLocaleString()}`
          : 'Offline';

  return (
    <section className="chat-pane">
      <header className="chat-header">
        <button type="button" className="icon-btn back-btn" onClick={onBack} aria-label="Back">←</button>
        <div className="avatar">{initials(title)}</div>
        <div className="chat-header-text">
          <div className="chat-title">{title}</div>
          <div className="chat-subtitle">
            {typingNames.length ? `${typingNames.join(', ')} typing…` : subtitle}
          </div>
        </div>
        {conversation.type === 'group' && (
          <button type="button" className="btn-green" onClick={() => onStartGroupCall(conversation)}>
            📹 Start Group Call
          </button>
        )}
      </header>

      <div className="messages" ref={scrollRef}>
        {messages.map((msg) => {
          const mine = msg.senderId === me.id;
          const sender = usersById.get(msg.senderId);
          const tick = tickForStatus(msg.status);
          return (
            <div key={msg.id} className={`msg-row ${mine ? 'mine' : 'theirs'}`}>
              <div className="bubble">
                {!mine && conversation.type === 'group' && (
                  <div className="sender-label">{userName(sender, msg.senderId.slice(0, 6))}</div>
                )}
                {msg.type === 'text' ? (
                  <div className="msg-body">{msg.body}</div>
                ) : (
                  <AuthedMedia message={msg} onError={onError} />
                )}
                {msg.type !== 'text' && msg.body && <div className="msg-body">{msg.body}</div>}
                <div className="msg-meta">
                  <span>{formatTime(msg.createdAt)}</span>
                  {mine && (
                    <span className={`tick tick-${tick.kind}`} title={tick.label}>
                      {tick.glyph}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {messages.length === 0 && <div className="empty-note">No messages yet. Say hello 👋</div>}
      </div>

      <footer className="composer">
        <input
          ref={fileInputRef}
          type="file"
          hidden
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip"
          onChange={(e) => void handleFileChosen(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          className="icon-btn"
          title="Attach image or document"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending}
        >
          📎
        </button>
        <button
          type="button"
          className={`icon-btn ${recording ? 'recording' : ''}`}
          title={recording ? 'Stop and send voice message' : 'Record a voice message'}
          onClick={() => void toggleRecording()}
        >
          {recording ? `⏹ ${formatDuration(recSeconds)}` : '🎤'}
        </button>
        <form className="composer-form" onSubmit={(e) => void sendText(e)}>
          <input
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            placeholder="Type a message"
            aria-label="Type a message"
          />
          <button type="submit" className="btn-send" disabled={sending || !draft.trim()}>
            Send
          </button>
        </form>
      </footer>
    </section>
  );
}
