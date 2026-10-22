import { useEffect, useRef, useState } from 'react';
import { callManager, type CallState } from '../callManager';
import { formatDuration, initials, userName } from '../utils';

/**
 * Renders whatever the CallManager is doing:
 *  - incoming: full-screen ringing overlay with Accept / Reject
 *  - outgoing / connecting / in-call / reconnecting: the active call panel
 *  - ended: a small dismissible notice (toasts also fire via onNotice)
 *
 * Speaker selection: browsers cannot switch the phone earpiece/speaker like a
 * native app. Where `HTMLMediaElement.setSinkId` exists (Chrome/Edge), we can
 * pick an audio OUTPUT device — that control only appears when supported.
 */
export default function CallPanel() {
  const [state, setState] = useState<CallState>(callManager.snapshot);
  const [sinkId, setSinkId] = useState<string>('');
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);

  useEffect(() => callManager.subscribe(setState), []);

  // Attach streams to the media elements whenever they change.
  useEffect(() => {
    if (localRef.current && localRef.current.srcObject !== state.localStream) {
      localRef.current.srcObject = state.localStream;
    }
  }, [state.localStream, state.phase]);
  useEffect(() => {
    if (remoteRef.current && remoteRef.current.srcObject !== state.remoteStream) {
      remoteRef.current.srcObject = state.remoteStream;
    }
  }, [state.remoteStream, state.phase]);

  // Enumerate audio outputs once a call is live (labels need mic permission,
  // which an active call already grants).
  useEffect(() => {
    if (state.phase !== 'in-call' && state.phase !== 'connecting') return;
    const el = document.createElement('video');
    if (!('setSinkId' in el)) return; // not supported in this browser
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => setOutputs(devices.filter((d) => d.kind === 'audiooutput')))
      .catch(() => undefined);
  }, [state.phase]);

  async function chooseOutput(deviceId: string) {
    setSinkId(deviceId);
    const el = remoteRef.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (el?.setSinkId) {
      try {
        await el.setSinkId(deviceId);
      } catch {
        /* device disappeared — ignore */
      }
    }
  }

  const { phase, call } = state;
  if (phase === 'idle' || !call) return null;

  const peer = state.direction === 'out' ? call.callee : call.caller;
  const peerName = userName(peer, 'Team member');

  if (phase === 'ended') {
    return (
      <div className="call-ended-toast" role="status">
        <span>{state.endReason ?? 'Call ended'}</span>
        {state.durationSec > 0 && <span className="call-ended-dur">{formatDuration(state.durationSec)}</span>}
        <button type="button" className="btn-small" onClick={() => callManager.dismissEnded()}>
          OK
        </button>
      </div>
    );
  }

  if (phase === 'incoming') {
    const isGroup = call.type === 'group';
    return (
      <div className="call-overlay incoming">
        <div className="avatar big">{initials(peerName)}</div>
        <h2>{peerName}</h2>
        <p>
          {isGroup ? 'invites you to a group call' : `Incoming ${call.type} call…`}
        </p>
        <div className="call-actions">
          <button type="button" className="btn-decline" onClick={() => void callManager.reject()}>
            ✕ {isGroup ? 'Ignore' : 'Reject'}
          </button>
          <button type="button" className="btn-accept" onClick={() => void callManager.accept()}>
            ✓ {isGroup ? 'Join' : 'Accept'}
          </button>
        </div>
      </div>
    );
  }

  const statusText =
    phase === 'outgoing'
      ? 'Ringing…'
      : phase === 'connecting'
        ? 'Connecting…'
        : phase === 'reconnecting'
          ? 'Reconnecting…'
          : formatDuration(state.durationSec);

  return (
    <div className="call-overlay active">
      <div className="call-stage">
        {state.isVideo ? (
          <>
            <video ref={remoteRef} className="remote-video" autoPlay playsInline />
            <video ref={localRef} className="local-video" autoPlay playsInline muted />
          </>
        ) : (
          <>
            {/* Audio still flows through the (hidden) media element. */}
            <video ref={remoteRef} className="hidden-media" autoPlay playsInline />
            <div className="avatar big">{initials(peerName)}</div>
          </>
        )}
      </div>
      <h2>{peerName}</h2>
      <p className={`call-status ${phase === 'reconnecting' ? 'warn' : ''}`}>{statusText}</p>
      <div className="call-actions">
        <button
          type="button"
          className={`btn-round ${state.muted ? 'off' : ''}`}
          title={state.muted ? 'Unmute microphone' : 'Mute microphone'}
          onClick={() => callManager.toggleMute()}
        >
          {state.muted ? '🔇' : '🎙️'}
        </button>
        <button
          type="button"
          className={`btn-round ${state.cameraOff ? 'off' : ''}`}
          title={state.cameraOff ? 'Turn camera on' : 'Turn camera off'}
          onClick={() => void callManager.toggleCamera()}
        >
          {state.cameraOff ? '🚫📷' : '📷'}
        </button>
        <button type="button" className="btn-hangup" title="End call" onClick={() => void callManager.hangUp()}>
          📞 End
        </button>
      </div>
      {outputs.length > 1 && (
        <label className="sink-select">
          🔊 Audio output
          <select value={sinkId} onChange={(e) => void chooseOutput(e.target.value)}>
            <option value="">Default</option>
            {outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Output device'}
              </option>
            ))}
          </select>
        </label>
      )}
      {outputs.length <= 1 && phase === 'in-call' && (
        <p className="call-note">Tip: use your device volume / Bluetooth controls for speaker output — browsers cannot force the phone loudspeaker.</p>
      )}
    </div>
  );
}
