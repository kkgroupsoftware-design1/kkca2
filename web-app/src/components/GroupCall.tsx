import { useEffect, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  type AudioTrack,
  type Participant,
  type VideoTrack,
} from 'livekit-client';
import { api, ApiError } from '../api';
import { runtimeConfig } from '../config';
import { initials } from '../utils';

/**
 * Group audio/video conference on LiveKit.
 *
 * The backend mints a short-lived token (POST /api/livekit/token) after
 * checking this user is authorized for the room/call. If LiveKit is not
 * configured on the server the backend answers 503 and we show that exact
 * message — no fake connection is attempted.
 */

interface Tile {
  identity: string;
  name: string;
  isLocal: boolean;
  videoTrack: VideoTrack | null;
  audioTrack: AudioTrack | null;
  micOn: boolean;
  camOn: boolean;
  speaking: boolean;
}

function tileFor(participant: Participant): Tile {
  const videoPub = participant.getTrackPublication(Track.Source.Camera);
  const audioPub = participant.getTrackPublication(Track.Source.Microphone);
  return {
    identity: participant.identity,
    name: participant.name || participant.identity,
    isLocal: participant.isLocal,
    videoTrack: (videoPub?.track as VideoTrack | undefined) ?? null,
    audioTrack: (audioPub?.track as AudioTrack | undefined) ?? null,
    micOn: participant.isMicrophoneEnabled,
    camOn: participant.isCameraEnabled,
    speaking: participant.isSpeaking,
  };
}

function VideoTile({ tile }: { tile: Tile }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioSinkRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    const track = tile.videoTrack;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [tile.videoTrack]);

  useEffect(() => {
    // Remote audio: attach the track to a hidden <audio> element we own.
    if (tile.isLocal || !tile.audioTrack || !audioSinkRef.current) return;
    const el = tile.audioTrack.attach();
    el.autoplay = true;
    audioSinkRef.current.appendChild(el);
    return () => {
      tile.audioTrack?.detach(el);
      el.remove();
    };
  }, [tile.audioTrack, tile.isLocal]);

  return (
    <div className={`lk-tile ${tile.speaking ? 'speaking' : ''}`}>
      {tile.camOn && tile.videoTrack ? (
        <video ref={videoRef} autoPlay playsInline muted={tile.isLocal} />
      ) : (
        <div className="lk-avatar">{initials(tile.name)}</div>
      )}
      <span ref={audioSinkRef} className="hidden-media" />
      <div className="lk-tile-label">
        <span>{tile.isLocal ? `${tile.name} (You)` : tile.name}</span>
        <span className="lk-tile-icons">
          {tile.micOn ? '🎙️' : '🔇'} {tile.camOn ? '📷' : '🚫'}
        </span>
      </div>
    </div>
  );
}

interface Props {
  roomName: string;
  callId?: string;
  title: string;
  onLeave: () => void;
  onError: (msg: string) => void;
}

export default function GroupCall({ roomName, callId, title, onLeave, onError }: Props) {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [errorText, setErrorText] = useState('');
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const roomRef = useRef<Room | null>(null);

  useEffect(() => {
    let cancelled = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    const refresh = () => {
      if (cancelled) return;
      const list: Tile[] = [tileFor(room.localParticipant)];
      for (const p of room.remoteParticipants.values()) list.push(tileFor(p));
      setTiles(list);
      setMicOn(room.localParticipant.isMicrophoneEnabled);
      setCamOn(room.localParticipant.isCameraEnabled);
    };

    room.on(RoomEvent.ParticipantConnected, refresh);
    room.on(RoomEvent.ParticipantDisconnected, refresh);
    room.on(RoomEvent.TrackSubscribed, refresh);
    room.on(RoomEvent.TrackUnsubscribed, refresh);
    room.on(RoomEvent.TrackMuted, refresh);
    room.on(RoomEvent.TrackUnmuted, refresh);
    room.on(RoomEvent.LocalTrackPublished, refresh);
    room.on(RoomEvent.LocalTrackUnpublished, refresh);
    room.on(RoomEvent.ActiveSpeakersChanged, refresh);
    room.on(RoomEvent.Disconnected, () => {
      if (!cancelled) onLeave();
    });

    (async () => {
      try {
        let res;
        try {
          res = await api.livekitToken({ roomName, ...(callId ? { callId } : {}), isGroup: true });
        } catch (err) {
          if (cancelled) return;
          setStatus('error');
          // 503 from the backend = "LiveKit is not configured on the server…"
          setErrorText(err instanceof ApiError ? err.message : 'Could not get a room token');
          return;
        }
        const url = res.url || runtimeConfig.livekitUrl;
        await room.connect(url, res.token);
        if (cancelled) {
          await room.disconnect();
          return;
        }
        await room.localParticipant.setMicrophoneEnabled(true);
        await room.localParticipant.setCameraEnabled(true);
        if (cancelled) return;
        setStatus('connected');
        refresh();
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setErrorText(err instanceof Error ? err.message : 'Could not join the group call');
      }
    })();

    return () => {
      cancelled = true;
      room.removeAllListeners();
      void room.disconnect();
      roomRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomName, callId]);

  async function toggleMic() {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!micOn);
      setMicOn(!micOn);
    } catch {
      onError('Microphone could not be changed');
    }
  }

  async function toggleCam() {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setCameraEnabled(!camOn);
      setCamOn(!camOn);
    } catch {
      onError('Camera could not be changed');
    }
  }

  async function leave() {
    try {
      await roomRef.current?.disconnect();
    } catch {
      /* already gone */
    }
    onLeave();
  }

  return (
    <section className="group-call">
      <header className="chat-header">
        <div className="chat-header-text">
          <div className="chat-title">👥 {title}</div>
          <div className="chat-subtitle">
            {status === 'connecting' && 'Connecting to the group room…'}
            {status === 'connected' && `${tiles.length} participant${tiles.length === 1 ? '' : 's'} (max 10)`}
            {status === 'error' && 'Connection problem'}
          </div>
        </div>
        <button type="button" className="btn-decline" onClick={() => void leave()}>
          Leave
        </button>
      </header>

      {status === 'error' ? (
        <div className="group-error">
          <p>⚠ {errorText}</p>
          <button type="button" className="btn-primary" onClick={() => void leave()}>
            Back
          </button>
        </div>
      ) : (
        <>
          <div className="lk-grid">
            {tiles.map((tile) => (
              <VideoTile key={tile.identity} tile={tile} />
            ))}
            {status === 'connecting' && <div className="empty-note">Joining…</div>}
          </div>
          <div className="call-actions center">
            <button
              type="button"
              className={`btn-round ${micOn ? '' : 'off'}`}
              title={micOn ? 'Mute microphone' : 'Unmute microphone'}
              onClick={() => void toggleMic()}
            >
              {micOn ? '🎙️' : '🔇'}
            </button>
            <button
              type="button"
              className={`btn-round ${camOn ? '' : 'off'}`}
              title={camOn ? 'Turn camera off' : 'Turn camera on'}
              onClick={() => void toggleCam()}
            >
              {camOn ? '📷' : '🚫📷'}
            </button>
            <button type="button" className="btn-hangup" onClick={() => void leave()}>
              📞 Leave call
            </button>
          </div>
        </>
      )}
    </section>
  );
}
