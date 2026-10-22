import { api, ApiError } from './api';
import { socketManager } from './socket';
import type { CallDto, IceServerDto, SignalPayload } from './types';

/**
 * 1-to-1 WebRTC call engine for the browser client.
 *
 * Signalling follows the backend contract (backend/src/socket.ts):
 *  - Outgoing: POST /api/calls/invite (the server emits `call:incoming` to the
 *    callee and returns { call, iceServers }), then our SDP offer and ICE go
 *    over the `call:signal` socket event, kind 'offer' | 'ice'.
 *  - Incoming: `call:incoming` { callId, call, iceServers }. The caller's offer
 *    and ICE usually arrive BEFORE the user taps Accept, so they are buffered
 *    here and applied when the PeerConnection is created on accept.
 *  - State changes (accept/reject/cancel/end) go through the REST endpoints;
 *    the server relays `call:accepted` / `call:rejected` / `call:cancelled` /
 *    `call:ended` to the other side. A `call:signal` kind 'bye' is also sent
 *    on hang-up so the peer can tear down immediately.
 *
 * Group-type invites never create a PeerConnection here — Accept hands the
 * room to the LiveKit view via the onJoinGroup callback.
 */

export type CallPhase =
  | 'idle'
  | 'outgoing' // ringing, waiting for the callee
  | 'incoming' // ringing, waiting for me
  | 'connecting' // accepted, media negotiating
  | 'in-call'
  | 'reconnecting'
  | 'ended';

export interface CallState {
  phase: CallPhase;
  call: CallDto | null;
  direction: 'out' | 'in' | null;
  isVideo: boolean;
  muted: boolean;
  cameraOff: boolean;
  /** Seconds since the call was answered (0 while ringing). */
  durationSec: number;
  endReason: string | null; // e.g. 'Missed', 'Rejected', 'Call ended'
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
}

const INITIAL: CallState = {
  phase: 'idle',
  call: null,
  direction: null,
  isVideo: false,
  muted: false,
  cameraOff: false,
  durationSec: 0,
  endReason: null,
  localStream: null,
  remoteStream: null,
};

type Listener = (state: CallState) => void;

export class Ringtone {
  private ctx: AudioContext | null = null;
  private timer: number | null = null;
  private oscillators: OscillatorNode[] = [];

  start(): void {
    try {
      this.ctx = this.ctx ?? new AudioContext();
      void this.ctx.resume().catch(() => undefined);
      const ring = () => {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        // Classic two-tone ring: 440Hz + 480Hz bursts.
        for (const freq of [440, 480]) {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(0.08, t + 0.05);
          gain.gain.setValueAtTime(0.08, t + 1.1);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.25);
          osc.connect(gain).connect(this.ctx.destination);
          osc.start(t);
          osc.stop(t + 1.3);
          this.oscillators.push(osc);
        }
      };
      ring();
      this.timer = window.setInterval(ring, 3000);
    } catch {
      // Audio is best-effort; the on-screen overlay still shows.
    }
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    for (const osc of this.oscillators) {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
    }
    this.oscillators = [];
  }
}

export class CallManager {
  private state: CallState = { ...INITIAL };
  private listeners = new Set<Listener>();
  private ringtone = new Ringtone();

  private pc: RTCPeerConnection | null = null;
  private iceServers: IceServerDto[] = [];
  private peerUserId: string | null = null;

  // Signalling buffered while the callee has not accepted yet.
  private pendingOffer: RTCSessionDescriptionInit | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  private durationTimer: number | null = null;
  private answeredAtMs: number | null = null;
  private restartAttempts = 0;
  private restartTimer: number | null = null;
  private closed = false;

  /** Set by the App: join a group (LiveKit) room instead of a 1-1 call. */
  onJoinGroup: ((roomName: string, callId: string) => void) | null = null;
  /** Set by the App: show a toast, refresh history, browser notification... */
  onNotice: ((message: string) => void) | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  get snapshot(): CallState {
    return this.state;
  }

  private set(patch: Partial<CallState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Wire the socket listeners once (after login). Returns an unsubscribe. */
  attachSocket(): () => void {
    const offs = [
      socketManager.onIncomingCall((payload) => void this.handleIncoming(payload.call, payload.iceServers)),
      socketManager.onSignal((payload) => void this.handleSignal(payload)),
      socketManager.onCallState('call:accepted', (p) => this.handlePeerState(p.callId, 'accepted', p.status)),
      socketManager.onCallState('call:rejected', (p) => this.handlePeerState(p.callId, 'rejected', p.status)),
      socketManager.onCallState('call:cancelled', (p) => this.handlePeerState(p.callId, 'cancelled', p.status)),
      socketManager.onCallState('call:ended', (p) => this.handlePeerState(p.callId, 'ended', p.status)),
    ];
    return () => offs.forEach((off) => off());
  }

  // ── Outgoing ──────────────────────────────────────────────────────────────

  async startCall(calleeId: string, type: 'audio' | 'video'): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'ended') return;
    this.closed = false;
    try {
      let iceServers: IceServerDto[] = [];
      let call: CallDto;
      try {
        const invite = await api.inviteCall({ calleeId, type });
        call = invite.call;
        iceServers = invite.iceServers;
      } catch (err) {
        // Fallback: if the invite request itself failed there is no call; but
        // if ICE config is what we lack, the dedicated endpoint provides it.
        throw err;
      }
      if (!iceServers?.length) {
        try {
          iceServers = (await api.callConfig()).iceServers;
        } catch {
          iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
        }
      }
      this.iceServers = iceServers;
      this.peerUserId = calleeId;
      this.set({
        phase: 'outgoing',
        call,
        direction: 'out',
        isVideo: type === 'video',
        endReason: null,
        durationSec: 0,
        muted: false,
        cameraOff: false,
      });
      await this.openPeerConnection();
      const offer = await this.pc!.createOffer();
      await this.pc!.setLocalDescription(offer);
      this.signal('offer', offer);
    } catch (err) {
      this.finish(err instanceof Error ? err.message : 'Could not start the call', false);
    }
  }

  // ── Incoming ──────────────────────────────────────────────────────────────

  private async handleIncoming(call: CallDto, iceServers: IceServerDto[]): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'ended') {
      // Busy: politely reject so the caller is not left ringing forever.
      if (call.type !== 'group') {
        try {
          await api.callAction(call.id, 'reject');
        } catch {
          /* ignore */
        }
      }
      return;
    }
    this.closed = false;
    this.iceServers = iceServers?.length
      ? iceServers
      : [{ urls: ['stun:stun.l.google.com:19302'] }];
    this.peerUserId = call.callerId;
    this.pendingOffer = null;
    this.pendingIce = [];
    this.set({
      phase: 'incoming',
      call,
      direction: 'in',
      isVideo: call.type === 'video',
      endReason: null,
      durationSec: 0,
    });
    if (call.type !== 'group') this.ringtone.start();
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification('Incoming call', {
          body: `${call.caller?.displayName ?? call.caller?.username ?? 'A team member'} is calling (${call.type})`,
          icon: '/favicon.svg',
          tag: `mtc-call-${call.id}`,
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        /* notifications are best-effort */
      }
    }
  }

  async accept(): Promise<void> {
    const call = this.state.call;
    if (!call || this.state.phase !== 'incoming') return;
    this.ringtone.stop();
    if (call.type === 'group') {
      // Join the LiveKit room. Accepting marks the ringing call answered for
      // the first joiner; later joiners get a 409, which is fine.
      try {
        await api.callAction(call.id, 'accept');
      } catch {
        /* already accepted by another member */
      }
      const roomName = call.roomName ?? `group-${call.conversationId ?? call.id}`;
      this.reset(false);
      this.onJoinGroup?.(roomName, call.id);
      return;
    }
    try {
      await api.callAction(call.id, 'accept');
    } catch (err) {
      this.finish(err instanceof ApiError ? err.message : 'Could not accept the call', false);
      return;
    }
    this.set({ phase: 'connecting' });
    try {
      await this.openPeerConnection();
      if (this.pendingOffer) {
        await this.pc!.setRemoteDescription(new RTCSessionDescription(this.pendingOffer));
        this.remoteDescriptionSet = true;
        await this.flushPendingIce();
        const answer = await this.pc!.createAnswer();
        await this.pc!.setLocalDescription(answer);
        this.signal('answer', answer);
      }
      // If no offer has arrived yet, handleSignal() completes the handshake
      // when it lands (we are already in 'connecting' with a PC ready).
      this.startDurationTimer();
    } catch (err) {
      this.finish(err instanceof Error ? err.message : 'Media setup failed', true);
    }
  }

  async reject(): Promise<void> {
    const call = this.state.call;
    if (!call) return;
    this.ringtone.stop();
    try {
      await api.callAction(call.id, 'reject');
    } catch {
      /* call may already be gone */
    }
    this.finish('Call declined', false);
  }

  /** Caller cancels while ringing; either side ends an established call. */
  async hangUp(): Promise<void> {
    const call = this.state.call;
    if (!call) {
      this.reset(true);
      return;
    }
    this.ringtone.stop();
    this.signal('bye', null);
    try {
      if (this.state.phase === 'outgoing') await api.callAction(call.id, 'cancel');
      else if (this.state.phase !== 'incoming') await api.callAction(call.id, 'end');
    } catch {
      /* already transitioned by the peer */
    }
    this.finish(this.state.phase === 'outgoing' ? 'Call cancelled' : 'Call ended', false);
  }

  // ── Media controls ────────────────────────────────────────────────────────

  toggleMute(): void {
    const stream = this.state.localStream;
    if (!stream) return;
    const next = !this.state.muted;
    for (const track of stream.getAudioTracks()) track.enabled = !next;
    this.set({ muted: next });
  }

  async toggleCamera(): Promise<void> {
    const stream = this.state.localStream;
    if (!stream || !this.pc) return;
    const nextOff = !this.state.cameraOff;
    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length) {
      for (const track of videoTracks) track.enabled = !nextOff;
    } else if (!nextOff) {
      // Camera was never captured (audio call upgraded mid-call): grab it now.
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: true });
        for (const track of cam.getVideoTracks()) {
          stream.addTrack(track);
          this.pc.addTrack(track, stream);
        }
        this.set({ localStream: stream, isVideo: true });
        await this.renegotiate();
      } catch {
        this.onNotice?.('Camera is not available or permission was denied.');
        return;
      }
    }
    this.set({ cameraOff: nextOff });
  }

  private async renegotiate(): Promise<void> {
    if (!this.pc || this.state.direction !== 'out') {
      // Only the original offerer re-offers in this simple 1-1 design; the
      // callee asks the caller to renegotiate by sending a fresh request.
      this.signal('renegotiate', null);
      return;
    }
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signal('offer', offer);
  }

  // ── Signalling ────────────────────────────────────────────────────────────

  private signal(kind: string, data: unknown): void {
    const call = this.state.call;
    if (!call) return;
    socketManager.emitSignal({
      callId: call.id,
      kind,
      data,
      ...(this.peerUserId ? { toUserId: this.peerUserId } : {}),
    });
  }

  private async handleSignal(payload: SignalPayload): Promise<void> {
    // Signals can arrive for the ringing call before accept (buffered below)
    // or during an active call. Ignore anything for other calls.
    const activeId = this.state.call?.id;
    if (!activeId || payload.callId !== activeId) return;

    if (payload.kind === 'bye') {
      this.finish('Call ended', false);
      return;
    }
    if (payload.kind === 'renegotiate') {
      if (this.pc && this.state.direction === 'out') await this.renegotiate();
      return;
    }
    if (payload.kind === 'offer') {
      const offer = payload.data as RTCSessionDescriptionInit;
      if (this.state.phase === 'incoming') {
        this.pendingOffer = offer; // applied on Accept
        return;
      }
      if (!this.pc) return;
      // Mid-call re-offer (ICE restart or camera upgrade from the caller).
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
        this.remoteDescriptionSet = true;
        await this.flushPendingIce();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signal('answer', answer);
      } catch {
        /* glare / stale offer — ignore */
      }
      return;
    }
    if (payload.kind === 'answer') {
      if (!this.pc) return;
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(payload.data as RTCSessionDescriptionInit));
        this.remoteDescriptionSet = true;
        await this.flushPendingIce();
      } catch {
        /* duplicate answer */
      }
      return;
    }
    if (payload.kind === 'ice') {
      const candidate = payload.data as RTCIceCandidateInit;
      if (!this.pc || !this.remoteDescriptionSet) {
        this.pendingIce.push(candidate);
        return;
      }
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        /* stale candidate */
      }
    }
  }

  private handlePeerState(callId: string, action: 'accepted' | 'rejected' | 'cancelled' | 'ended', status: string): void {
    if (this.state.call?.id !== callId) return;
    if (action === 'accepted') {
      if (this.state.phase === 'outgoing') {
        this.set({ phase: 'connecting' });
        this.startDurationTimer();
      }
      return;
    }
    this.ringtone.stop();
    const reason =
      action === 'rejected'
        ? status === 'missed'
          ? 'Call declined'
          : 'Call rejected'
        : action === 'cancelled'
          ? this.state.direction === 'in'
            ? 'Missed call'
            : 'Call cancelled'
          : 'Call ended';
    this.finish(reason, false);
  }

  // ── PeerConnection plumbing ───────────────────────────────────────────────

  private async openPeerConnection(): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.remoteDescriptionSet = false;
    this.restartAttempts = 0;

    const remoteStream = new MediaStream();
    this.set({ remoteStream });

    pc.ontrack = (event) => {
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        if (!remoteStream.getTracks().includes(track)) remoteStream.addTrack(track);
      }
      this.set({ remoteStream });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) this.signal('ice', event.candidate.toJSON());
    };

    pc.onconnectionstatechange = () => {
      if (this.closed || this.pc !== pc) return;
      if (pc.connectionState === 'connected') {
        this.restartAttempts = 0;
        if (this.state.phase === 'connecting' || this.state.phase === 'reconnecting') {
          this.set({ phase: 'in-call' });
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.closed || this.pc !== pc) return;
      const s = pc.iceConnectionState;
      if (s === 'disconnected') {
        this.set({ phase: 'reconnecting' });
        this.scheduleIceRestart();
      } else if (s === 'failed') {
        this.scheduleIceRestart(true);
      } else if (s === 'connected' || s === 'completed') {
        this.restartAttempts = 0;
        if (this.restartTimer) window.clearTimeout(this.restartTimer);
        this.restartTimer = null;
        if (this.state.phase === 'reconnecting') this.set({ phase: 'in-call' });
      }
    };

    const wantVideo = this.state.isVideo;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: wantVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
    if (this.closed) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    this.set({ localStream: stream, cameraOff: !wantVideo });
  }

  /** ICE restart: one immediate attempt, then backoff (2s, 4s); only the caller re-offers. */
  private scheduleIceRestart(isFailed = false): void {
    if (this.restartTimer || this.closed) return;
    if (this.restartAttempts >= 3) {
      this.finish('Connection lost', true);
      return;
    }
    const delay = this.restartAttempts === 0 ? (isFailed ? 0 : 1500) : this.restartAttempts * 2000;
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      if (this.closed || !this.pc) return;
      this.restartAttempts += 1;
      if (this.state.direction === 'out' && typeof this.pc.restartIce === 'function') {
        try {
          this.pc.restartIce();
        } catch {
          /* older browser */
        }
        void this.renegotiate();
      }
      // The callee cannot restart on its own; it waits for the caller's fresh
      // offer (handled in handleSignal). If none arrives, 'failed' + the
      // attempt cap above ends the call cleanly.
      if (this.pc.iceConnectionState === 'disconnected' || this.pc.iceConnectionState === 'failed') {
        this.scheduleIceRestart();
      }
    }, delay);
  }

  private async flushPendingIce(): Promise<void> {
    if (!this.pc) return;
    const buffered = this.pendingIce;
    this.pendingIce = [];
    for (const candidate of buffered) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        /* stale candidate */
      }
    }
  }

  // ── Lifecycle helpers ─────────────────────────────────────────────────────

  private startDurationTimer(): void {
    if (this.durationTimer) return;
    this.answeredAtMs = Date.now();
    this.durationTimer = window.setInterval(() => {
      if (this.answeredAtMs) {
        this.set({ durationSec: Math.floor((Date.now() - this.answeredAtMs) / 1000) });
      }
    }, 500);
  }

  private finish(reason: string, notifyServer: boolean): void {
    const call = this.state.call;
    if (notifyServer && call) {
      void api.callAction(call.id, 'end').catch(() => undefined);
    }
    this.teardownMedia();
    this.set({ ...INITIAL, phase: 'ended', call, endReason: reason, durationSec: this.state.durationSec });
    if (reason) this.onNotice?.(reason);
  }

  /** Return to idle without showing the ended screen (e.g. joining a group). */
  reset(showEnded: boolean): void {
    this.teardownMedia();
    if (showEnded) {
      this.set({ ...INITIAL, phase: 'ended', endReason: 'Call ended' });
    } else {
      this.set({ ...INITIAL });
    }
  }

  dismissEnded(): void {
    if (this.state.phase === 'ended') this.set({ ...INITIAL });
  }

  private teardownMedia(): void {
    this.closed = true;
    this.ringtone.stop();
    if (this.durationTimer) window.clearInterval(this.durationTimer);
    this.durationTimer = null;
    if (this.restartTimer) window.clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.answeredAtMs = null;
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        /* already closed */
      }
      this.pc = null;
    }
    for (const stream of [this.state.localStream, this.state.remoteStream]) {
      if (stream) for (const track of stream.getTracks()) track.stop();
    }
    this.pendingOffer = null;
    this.pendingIce = [];
    this.peerUserId = null;
    this.remoteDescriptionSet = false;
  }
}

export const callManager = new CallManager();
