'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Hera Voice — Unified Client (app.js)
// Merges Canvas animation, state machine, text messaging, and LiveKit voice
// into a single codebase. No livekit.js, no button cloning, no guard flags.
// ═══════════════════════════════════════════════════════════════════════════

// ── Canvas Animation ────────────────────────────────────────────────────────
const canvas = document.querySelector('#orb');
const ctx = canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let state = 'idle', audioLevel = 0, simulated = false, smoothLevel = 0;
let remoteAudioLevel = 0, localAudioLevel = 0;
let width = 350, height = 300, frame = 0;

function resize() {
  const rect = canvas.getBoundingClientRect();
  width = rect.width; height = rect.height;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = width * dpr; canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe(canvas);

function draw(time) {
  const t = reducedMotion.matches ? 4 : time / 1000;
  // Audio level comes from either remote analyser or local mic analyser
  // (set by LiveKit monitoring functions below). If neither is active and
  // we're in a simulated/preview state, generate a synthetic level.
  if (!livekitAnalyserActive && simulated && ['listening', 'speaking'].includes(state)) {
    audioLevel = .18 + Math.abs(Math.sin(t * 4.3) * Math.cos(t * 2.7)) * .65;
  } else if (livekitAnalyserActive) {
    audioLevel = currentAudioLevel();
  }
  updateUserSpeaking(audioLevel);
  // Fast attack, slow release so the orb visibly snaps to your voice and settles gently.
  const ease = audioLevel > smoothLevel ? .22 : .06;
  smoothLevel += (audioLevel - smoothLevel) * ease;
  const energy = smoothLevel;
  const muted = state === 'muted', thinking = state === 'thinking';
  const radius = Math.min(width, height) * .30;
  const cx = width / 2, cy = height / 2;
  ctx.clearRect(0, 0, width, height);
  const halo = ctx.createRadialGradient(cx, cy, radius * .6, cx, cy, radius * 1.7);
  halo.addColorStop(0, 'rgba(25,35,120,0)');
  halo.addColorStop(.5, `rgba(55,55,220,${muted ? .035 : .12 + energy * .1})`);
  halo.addColorStop(1, 'rgba(20,30,110,0)');
  ctx.fillStyle = halo; ctx.fillRect(0, 0, width, height);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 22; k++) {
    const offset = k / 22;
    ctx.beginPath();
    for (let j = 0; j <= 200; j++) {
      const a = j / 200 * Math.PI * 2;
      const drift = t * (thinking ? 1.15 : .35);
      const wobble = Math.sin(a * 3 + drift + offset * 3) * (3 + energy * 11) + Math.cos(a * 2 - drift * .8 + offset * 4) * 4;
      const ribbon = Math.sin(a + drift + offset * 2) * 17 * Math.sin(offset * Math.PI);
      const r = radius + wobble + ribbon + Math.sin(t * .7) * 2;
      const x = cx + Math.cos(a) * r * (1 + .025 * Math.sin(offset * 4 + t * .3));
      const y = cy + Math.sin(a) * r * (1.06 + .015 * Math.cos(t * .4));
      j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    if (state !== 'connecting') ctx.closePath();
    const gradient = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
    const alpha = muted ? .10 : .23;
    const level = userSpeaking ? Math.min(1, energy * 2.2) : 0;
    const alphaBoost = userSpeaking ? energy * .2 : 0;
    gradient.addColorStop(0, `rgba(${71 + level * 60},${106 - level * 30},${255},${alpha + alphaBoost})`);
    gradient.addColorStop(.32, `rgba(${157 + level * 70},${161 + level * 40},255,${alpha + .10 + alphaBoost})`);
    gradient.addColorStop(.55, `rgba(${56 + level * 80},${110 + level * 60},255,${alpha + alphaBoost})`);
    gradient.addColorStop(.77, `rgba(${176 + level * 60},${146 + level * 70},255,${alpha + .15 + alphaBoost})`);
    gradient.addColorStop(1, `rgba(${96 + level * 80},${209 + level * 40},255,${alpha + alphaBoost})`);
    ctx.strokeStyle = gradient; ctx.lineWidth = k % 5 === 0 ? 1.5 : .7;
    ctx.shadowColor = state === 'error' ? '#ae73b9' : (userSpeakingNow ? '#7db6ff' : '#5769ff');
    ctx.shadowBlur = k % 4 === 0 ? 21 : 5;
    ctx.globalAlpha = state === 'connecting' ? .4 + .3 * Math.sin(t * 3 + offset * 2) : 1;
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  for (let i = 0; i < 85; i++) {
    const a = i * 2.39996 + t * .025;
    const orbit = radius * (1.14 + ((i * 37) % 89) / 89 * .43);
    const pulse = .1 + .14 * Math.sin(t * .7 + i);
    ctx.fillStyle = `rgba(126,147,255,${muted ? .025 : pulse})`;
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * orbit, cy + Math.sin(a) * orbit, .5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  if (!document.hidden) frame = requestAnimationFrame(draw);
}

// ── DOM Helpers ─────────────────────────────────────────────────────────────
const $ = selector => document.querySelector(selector);
const labels = { idle: 'Here with you', connecting: 'Connecting…', listening: 'I\'m listening', thinking: 'A moment to think', speaking: 'Speaking', muted: 'Microphone paused', error: 'Let\'s try that again' };
const stateNames = { idle: 'Idle', connecting: 'Connecting', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', muted: 'Muted', error: 'Error' };

// ── State Machine ───────────────────────────────────────────────────────────
function setState(next, preview = false) {
  if (!(next in labels)) throw new Error('Unknown voice state');
  state = next; simulated = preview; if (!livekitAnalyserActive) audioLevel = 0;
  document.body.dataset.state = next;
  $('#status-text').textContent = labels[next] + (preview ? ' · Preview' : '');
  for (const button of $('#state-grid').children) button.setAttribute('aria-pressed', String(button.dataset.state === next));
  updateVoiceButtonAria();
}

function updateVoiceButtonAria() {
  const btn = $('#voice');
  if (livekitConnected) {
    btn.setAttribute('aria-pressed', 'true');
    btn.setAttribute('aria-label', state === 'speaking' ? 'Interrupt response' : 'Stop voice session');
  } else {
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Start microphone');
  }
}

let noticeTimer = null;
function notice(text = '', autoHideMs = 0) {
  clearTimeout(noticeTimer);
  noticeTimer = null;
  $('#notice').textContent = text;
  $('#notice').hidden = !text;
  if (text && autoHideMs > 0) {
    noticeTimer = setTimeout(() => notice(), autoHideMs);
  }
}

// ── Transcript / Messages ───────────────────────────────────────────────────
let transcript = [];

function cleanTranscriptText(text) {
  return String(text)
    .replace(/\[\[tts:([\s\S]*?)\]\]/g, '$1')
    .replace(/\[\/?\[?tts[^\]]*\]\]?/gi, '')
    .trim();
}

function addMessage(role, text) {
  text = cleanTranscriptText(text);
  if (!text) return;
  transcript.push({ role, text });
  const entry = document.createElement('article'); entry.className = 'message ' + role;
  const speaker = document.createElement('span'); speaker.className = 'speaker'; speaker.textContent = role === 'user' ? 'You' : 'Hera';
  const content = document.createElement('p'); content.textContent = text;
  entry.append(speaker, content);
  $('#messages').append(entry);
  if ($('#messages').children.length > 20) $('#messages').firstElementChild.remove();
  if (transcript.length > 20) transcript.shift();
  $('#intro').hidden = true; $('#conversation').hidden = false; $('#suggestions').hidden = true; $('#new-chat').hidden = false;
  document.body.classList.add('has-conversation');
  // Scroll the newest message itself. On iOS this updates both the transcript
  // scroller and, when needed, the page viewport so the new line is visible.
  requestAnimationFrame(() => {
    entry.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    $('#conversation').scrollTop = $('#conversation').scrollHeight;
  });
}

// ── Text Transport ──────────────────────────────────────────────────────────
// Two modes:
//  1. Text-only (no LiveKit): fetch('/api/chat')
//  2. LiveKit text stream: room.localParticipant.sendText(..., { topic: 'lk.chat' })

const CHAT_TOPIC = 'lk.chat';
const INTERRUPT_MARKER = '__hera_interrupt__';
let transportMode = 'text'; // 'text' | 'livekit'

async function sendText(text) {
  if (transportMode === 'livekit' && room && livekitConnected) {
    await room.localParticipant.sendText(text, { topic: CHAT_TOPIC });
  } else {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok) throw new Error('Chat request failed: ' + res.status);
    const data = await res.json();
    if (data.ok && data.reply) {
      addMessage('assistant', data.reply);
      setState('idle');
    } else {
      throw new Error(data.error || 'No reply from server');
    }
  }
}

async function sendMessage(text) {
  const value = String(text).trim(); if (!value) return;
  if (value.length > 2000) throw new Error('Please keep messages under 2,000 characters.');
  addMessage('user', value);
  $('#message').value = ''; $('#send').hidden = true;
  setState('thinking');
  try {
    await sendText(value);
  } catch (err) {
    setState('error');
    notice('Your message couldn\'t be sent. Please try again.');
  }
}

function newConversation() {
  // Disconnect LiveKit if connected
  if (livekitConnected) disconnectRoom();
  transcript = []; $('#messages').replaceChildren();
  $('#intro').hidden = false; $('#conversation').hidden = true; $('#suggestions').hidden = false; $('#new-chat').hidden = true;
  document.body.classList.remove('has-conversation'); $('#message').value = ''; $('#send').hidden = true;
  setState('idle'); notice();
}

// ── Preview Panel (debug, hidden by default) ────────────────────────────────
function previewState(next) {
  if (!(next in labels)) throw new Error('Unknown voice state');
  setState(next, next !== 'idle');
  if (next === 'error') notice('Connection interrupted. This is an error-state preview.');
  $('#preview-panel').close();
}

for (const [key, name] of Object.entries(stateNames)) {
  const button = document.createElement('button'); button.type = 'button'; button.dataset.state = key; button.textContent = name;
  button.setAttribute('aria-pressed', String(key === 'idle')); button.addEventListener('click', () => previewState(key)); $('#state-grid').append(button);
}

$('#preview-toggle').addEventListener('click', () => $('#preview-panel').showModal());
$('#close-preview').addEventListener('click', () => $('#preview-panel').close());
$('#reset-state').addEventListener('click', () => previewState('idle'));
$('#preview-panel').addEventListener('click', event => { if (event.target === $('#preview-panel')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });

// ── Composer / Input ────────────────────────────────────────────────────────
$('#composer').addEventListener('submit', event => { event.preventDefault(); void sendMessage($('#message').value); });
$('#message').addEventListener('input', () => { $('#send').hidden = !$('#message').value.trim(); });
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => void sendMessage(button.dataset.prompt)));
$('#new-chat').addEventListener('click', newConversation);

// ═══════════════════════════════════════════════════════════════════════════
// LiveKit Integration
// ═══════════════════════════════════════════════════════════════════════════

let room = null;
let localMicTrack = null;
let localMicPublication = null;
let livekitConnected = false;
let livekitConnecting = false;
let livekitAnalyserActive = false; // true when either analyser is active
let userSpeakingNow = false; // set from local mic level while user talks
let disconnectRequested = false;
let backgroundTaskCount = 0;

let userSpeaking = false; // true while the user's voice is actively driving the orb

function currentAudioLevel() {
  const localMicActive = localAnalyser && (!localMicTrack || !localMicTrack.isMuted);
  userSpeakingNow = localMicActive && localAudioLevel > 0.06;
  if (state === 'speaking' && remoteAnalyser) return remoteAudioLevel;
  if (localMicActive) return localAudioLevel;
  return remoteAudioLevel;
}

function updateUserSpeaking(level) {
  const localMicActive = localAnalyser && (!localMicTrack || !localMicTrack.isMuted);
  userSpeaking = localMicActive && state !== 'speaking' && level > 0.08;
}

// Remote audio monitoring
let remoteAudioEl = null;
let remoteAudioContext = null;
let remoteAnalyser = null;
let remoteAudioBuffer = null;
let remoteStream = null;
let silenceTimer = null;
let remoteAnalyserInterval = null;

// Local mic monitoring (for orb visual)
let localAudioContext = null;
let localAnalyser = null;
let localAudioBuffer = null;
let localMicInterval = null;

function logLK(...args) { console.log('[LiveKit]', ...args); }

// ── Token fetch ─────────────────────────────────────────────────────────────
async function fetchToken() {
  const res = await fetch('/api/livekit-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: 'MOKU Digital' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error('Token endpoint returned ' + res.status + ': ' + body);
  }
  return res.json();
}

// ── Remote audio monitoring ─────────────────────────────────────────────────
function startRemoteAudioMonitoring(track) {
  stopRemoteAudioMonitoring();

  remoteStream = new MediaStream();
  remoteStream.addTrack(track.mediaStreamTrack);

  remoteAudioEl = new Audio();
  remoteAudioEl.srcObject = remoteStream;
  remoteAudioEl.autoplay = true;
  remoteAudioEl.play().catch(e => logLK('Audio autoplay blocked:', e.message));

  try {
    remoteAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = remoteAudioContext.createMediaStreamSource(remoteStream);
    remoteAnalyser = remoteAudioContext.createAnalyser();
    remoteAnalyser.fftSize = 512;
    remoteAudioBuffer = new Uint8Array(remoteAnalyser.fftSize);
    source.connect(remoteAnalyser);
  } catch (e) {
    logLK('Remote audio analyser setup failed:', e.message);
  }

  livekitAnalyserActive = true;
  let speakingActive = false;

  remoteAnalyserInterval = setInterval(() => {
    if (!remoteAnalyser) return;
    remoteAnalyser.getByteTimeDomainData(remoteAudioBuffer);
    let power = 0;
    for (let i = 0; i < remoteAudioBuffer.length; i++) {
      const sample = (remoteAudioBuffer[i] - 128) / 128;
      power += sample * sample;
    }
    const rms = Math.sqrt(power / remoteAudioBuffer.length);
    const level = Math.min(1, rms * 4);
    remoteAudioLevel = level;
    simulated = false;

    const isSpeaking = level > 0.04;
    if (isSpeaking && !speakingActive) {
      speakingActive = true;
      clearTimeout(silenceTimer);
      setState('speaking');
    } else if (!isSpeaking && speakingActive) {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        speakingActive = false;
        if (localMicTrack && !localMicTrack.isMuted) {
          setState(backgroundTaskCount > 0 ? 'thinking' : 'listening');
        } else {
          setState('idle');
        }
      }, 800);
    }
  }, 60);
}

function stopRemoteAudioMonitoring() {
  clearInterval(remoteAnalyserInterval);
  remoteAnalyserInterval = null;
  clearTimeout(silenceTimer);
  silenceTimer = null;
  if (remoteAudioEl) { remoteAudioEl.pause(); remoteAudioEl.srcObject = null; remoteAudioEl = null; }
  if (remoteStream) { remoteStream.getTracks().forEach(t => t.stop()); remoteStream = null; }
  if (remoteAudioContext) { remoteAudioContext.close().catch(() => {}); remoteAudioContext = null; remoteAnalyser = null; remoteAudioBuffer = null; }
  remoteAudioLevel = 0;
  livekitAnalyserActive = Boolean(localAnalyser);
}

// ── Local mic monitoring (for orb visual) ───────────────────────────────────
function startLocalMicMonitoring(stream) {
  stopLocalMicMonitoring();
  try {
    localAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = localAudioContext.createMediaStreamSource(stream);
    localAnalyser = localAudioContext.createAnalyser();
    localAnalyser.fftSize = 512;
    localAudioBuffer = new Uint8Array(localAnalyser.fftSize);
    source.connect(localAnalyser);

    livekitAnalyserActive = true;

    localMicInterval = setInterval(() => {
      if (!localAnalyser) return;
      localAnalyser.getByteTimeDomainData(localAudioBuffer);
      let power = 0;
      for (let i = 0; i < localAudioBuffer.length; i++) {
        const sample = (localAudioBuffer[i] - 128) / 128;
        power += sample * sample;
      }
      const rms = Math.sqrt(power / localAudioBuffer.length);
      localAudioLevel = Math.min(1, rms * 5);
      simulated = false;
    }, 60);
  } catch (e) {
    logLK('Local mic monitoring setup failed:', e.message);
  }
}

function stopLocalMicMonitoring() {
  clearInterval(localMicInterval);
  localMicInterval = null;
  if (localAudioContext) { localAudioContext.close().catch(() => {}); localAudioContext = null; localAnalyser = null; localAudioBuffer = null; }
  localAudioLevel = 0;
  livekitAnalyserActive = Boolean(remoteAnalyser);
}

// ── Connect to LiveKit room ─────────────────────────────────────────────────
async function connectRoom() {
  if (livekitConnecting || livekitConnected) return;
  disconnectRequested = false;
  livekitConnecting = true;

  setState('connecting');
  notice('Connecting to Hera voice…');
  $('#voice').disabled = true;

  try {
    if (typeof LivekitClient === 'undefined') {
      throw new Error('LiveKit client library not loaded');
    }

    // Start microphone capture immediately from the user's click and before
    // joining the room. This avoids dispatching an agent into a session whose
    // microphone permission or device later fails, and is more reliable on
    // iOS Safari than wrapping a raw MediaStreamTrack ourselves.
    const [{ token, url }, microphoneTrack] = await Promise.all([
      fetchToken(),
      LivekitClient.createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }),
    ]);
    localMicTrack = microphoneTrack;
    startLocalMicMonitoring(new MediaStream([localMicTrack.mediaStreamTrack]));

    room = new LivekitClient.Room({
      adaptiveStream: true,
      dynacast: true,
    });

    // ── Room event handlers ──────────────────────────────────────────────

    room.on(LivekitClient.RoomEvent.ParticipantConnected, (participant) => {
      logLK('Participant connected:', participant.identity);
      if (participant.identity !== room.localParticipant.identity) {
        notice('');
      }
    });

    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
      logLK('Participant disconnected:', participant.identity);
      if (participant.identity !== room.localParticipant.identity) {
        stopRemoteAudioMonitoring();
        setState('idle');
        if (!disconnectRequested) {
          notice('Hera disconnected. You can reconnect or keep typing.', 4000);
        }
      }
    });

    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      logLK('Track subscribed:', track.kind, 'from', participant.identity);
      if (track.kind === 'audio') {
        notice('');
        startRemoteAudioMonitoring(track);
      }
    });

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
      logLK('Track unsubscribed:', track.kind);
      if (track.kind === 'audio') {
        stopRemoteAudioMonitoring();
      }
    });

    room.on(LivekitClient.RoomEvent.TranscriptionReceived, (segments, participant) => {
      for (const segment of segments || []) {
        if (!segment?.final || !segment.text) continue;
        notice('');
        const isLocal = participant?.isLocal || participant?.identity === room.localParticipant?.identity;
        if (isLocal) {
          addMessage('user', segment.text);
          setState('thinking');
        } else {
          addMessage('assistant', segment.text);
          // Remote audio monitoring owns the speaking state. A final
          // transcript can arrive after playback ends, so forcing speaking
          // here leaves the interface stuck indefinitely.
          if (remoteAudioLevel > 0.04) setState('speaking');
          else setState(backgroundTaskCount > 0 ? 'thinking' : 'listening');
        }
      }
    });

    room.on(LivekitClient.RoomEvent.DataReceived, (payload, participant, kind, topic) => {
      if (topic !== 'hera.status') return;
      try {
        const update = JSON.parse(new TextDecoder().decode(payload));
        if (update.type !== 'delegation_status') return;
        backgroundTaskCount = Number(update.pending) || 0;
        const agentName = update.agent === 'main'
          ? 'Hera Main'
          : String(update.agent || 'agent').replace(/^./, char => char.toUpperCase());
        if (update.status === 'working') {
          setState('thinking');
          notice(`${agentName} is working in the background. You can keep talking.`);
        } else {
          notice(update.status === 'failed' ? `${agentName} could not finish the task.` : `${agentName} has finished.`, 2500);
          if (state !== 'speaking') setState(backgroundTaskCount > 0 ? 'thinking' : 'listening');
        }
      } catch (error) {
        logLK('Invalid Hera status update:', error.message);
      }
    });

    room.on(LivekitClient.RoomEvent.Disconnected, (reason) => {
      logLK('Room disconnected:', reason);
      const endedByUser = disconnectRequested;
      disconnectRequested = false;
      livekitConnected = false;
      livekitConnecting = false;
      backgroundTaskCount = 0;
      stopRemoteAudioMonitoring();
      stopLocalMicMonitoring();
      cleanupRoom();
      transportMode = 'text';
      setState('idle');
      if (endedByUser) {
        notice('');
      } else {
        notice('Session ended. Click the microphone to start again.', 4000);
      }
      $('#voice').disabled = false;
      $('#session-actions').hidden = true;
      updateVoiceButtonAria();
      $('#input-hint').textContent = 'Type a thought. Or just start talking.';
    });

    room.on(LivekitClient.RoomEvent.LocalTrackPublished, (publication) => {
      logLK('Local track published:', publication.kind);
      if (publication.kind === 'audio') {
        localMicPublication = publication;
        setState('listening');
        $('#input-hint').textContent = 'Live microphone · Speak naturally';
        notice('');
      }
    });

    room.on(LivekitClient.RoomEvent.TrackMuted, (publication, participant) => {
      if (participant.isLocal && publication.kind === 'audio') {
        setState('muted');
      }
    });

    room.on(LivekitClient.RoomEvent.TrackUnmuted, (publication, participant) => {
      if (participant.isLocal && publication.kind === 'audio') {
        setState('listening');
      }
    });

    room.on(LivekitClient.RoomEvent.Reconnecting, () => {
      logLK('Room reconnecting…');
      setState('connecting');
      notice('Reconnecting…');
    });

    room.on(LivekitClient.RoomEvent.Reconnected, () => {
      logLK('Room reconnected');
      notice('');
      if (localMicTrack && !localMicTrack.isMuted) {
        setState('listening');
      } else {
        setState('idle');
      }
    });

    // Connect to the room
    await room.connect(url, token, { autoSubscribe: true });
    livekitConnected = true;
    livekitConnecting = false;

    logLK('Connected to room:', room.name);

    // Switch text transport to the LiveKit text stream handled by the agent framework.
    transportMode = 'livekit';

    localMicPublication = await room.localParticipant.publishTrack(localMicTrack, {
      name: 'mic',
      source: LivekitClient.Track.Source.Microphone,
    });

    // Update UI
    $('#voice').disabled = false;
    $('#session-actions').hidden = false;
    updateVoiceButtonAria();

    notice('');

    // If no agent has joined yet, show waiting state
    const participants = room.remoteParticipants || room.participants || new Map();
    const agentParticipants = Array.from(participants.values()).filter(
      participant => participant.identity !== room.localParticipant.identity
    );
    if (agentParticipants.length === 0) {
      notice('Connected. Waiting for Hera to join…');
    }
  } catch (error) {
    logLK('Connection failed:', error);
    disconnectRequested = true;
    livekitConnecting = false;
    livekitConnected = false;
    setState('error');
    notice(
      error.name === 'NotAllowedError'
        ? 'Microphone access wasn\'t granted. Enable it in your browser to use voice.'
        : 'Could not connect to the voice service. ' + (error.message || 'Please try again.')
    );
    $('#voice').disabled = false;
    cleanupRoom();
  }
}

function cleanupRoom() {
  stopLocalMicMonitoring();
  if (localMicTrack) { localMicTrack.stop(); localMicTrack = null; }
  localMicPublication = null;
  if (room) { room.disconnect().catch(() => {}); room = null; }
}

function disconnectRoom() {
  disconnectRequested = true;
  cleanupRoom();
  livekitConnected = false;
  livekitConnecting = false;
  backgroundTaskCount = 0;
  transportMode = 'text'; // restore text-only transport
  stopRemoteAudioMonitoring();
  stopLocalMicMonitoring();
  setState('idle');
  notice('');
  $('#voice').disabled = false;
  $('#session-actions').hidden = true;
  updateVoiceButtonAria();
  $('#input-hint').textContent = 'Type a thought. Or just start talking.';
}

function toggleMute() {
  if (!localMicTrack) return;
  if (localMicTrack.isMuted) {
    localMicTrack.unmute();
    $('#mute').textContent = 'Mute microphone';
    setState('listening');
  } else {
    localMicTrack.mute();
    $('#mute').textContent = 'Resume microphone';
    setState('muted');
  }
}

// ── Button Handlers (unified, no cloning) ───────────────────────────────────

$('#voice').addEventListener('click', () => {
  // If speaking (remote audio active), send interrupt signal
  if (state === 'speaking' && room && livekitConnected) {
    room.localParticipant.sendText(INTERRUPT_MARKER, { topic: CHAT_TOPIC }).catch(error => {
      logLK('Interrupt failed:', error.message);
      notice('Could not interrupt. Try speaking or end the session.');
    });
    return;
  }
  // If connected, disconnect (toggle off)
  if (livekitConnected || livekitConnecting) {
    disconnectRoom();
    return;
  }
  // Not connected, start connection
  void connectRoom();
});

$('#mute').addEventListener('click', toggleMute);

$('#end').addEventListener('click', disconnectRoom);

// ── Visibility / pagehide ───────────────────────────────────────────────────
// DO NOT kill the LiveKit room on visibility change or pagehide.
// iOS Safari fires pagehide when showing the mic permission dialog.
// Only pause/resume the Canvas animation.

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(frame);
    // Do NOT resetActivity or disconnect LiveKit
  } else {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  }
});

window.addEventListener('pagehide', () => {
  // Do NOT resetActivity or disconnect LiveKit
  // The Canvas animation will resume on return via visibilitychange
});

// ── Web MCP (optional, for design preview only) ────────────────────────────
const webMcpLifecycle = new AbortController();
if (document.modelContext?.registerTool) {
  try {
    Promise.resolve(document.modelContext.registerTool({
      name: 'preview_voice_animation',
      title: 'Preview a voice animation',
      description: 'Show a simulated voice interface state. Does not start microphone access or connect to an agent.',
      inputSchema: { type: 'object', properties: { state: { type: 'string', enum: Object.keys(labels) } }, required: ['state'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) { if (!input || typeof input !== 'object' || Object.keys(input).length !== 1 || !Object.hasOwn(labels, input.state)) throw new Error('Choose a valid voice state'); previewState(input.state); return { state, simulated: simulated }; }
    }, { signal: webMcpLifecycle.signal })).catch(() => {});
  } catch { /* Ordinary browsers may not support the proposed API. */ }
}
window.addEventListener('pagehide', () => webMcpLifecycle.abort());

// ── HeraVoice Adapter API ───────────────────────────────────────────────────
// External code (or future tooling) can feed state, levels, and transcripts
// through this adapter without touching internals directly.
window.HeraVoice = Object.freeze({
  setState,
  setAudioLevel(value) { simulated = false; audioLevel = Math.max(0, Math.min(1, Number(value) || 0)); },
  addMessage(role, text) { if (!['user', 'assistant'].includes(role) || typeof text !== 'string') throw new Error('Invalid message'); addMessage(role, text); },
  reset: newConversation,
});

// ── Init ────────────────────────────────────────────────────────────────────
resize();
frame = requestAnimationFrame(draw);

// Text-only transport is the default. No mic needed to type.
// When LiveKit connects, transportMode switches to 'livekit'.
transportMode = 'text';
