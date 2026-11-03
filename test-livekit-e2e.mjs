import { Room, RoomEvent } from '@livekit/rtc-node';

const endpoint = process.env.VOICE_TEST_ENDPOINT || 'http://127.0.0.1:8080/api/livekit-token';
const identity = `livekit-e2e-${Date.now()}`;
const testPrompt = process.env.TEST_PROMPT || 'Reply OK only.';
const waitMs = Number(process.env.TEST_WAIT_MS || 8000);

async function main() {
  const tokenRes = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identity }),
  });
  if (!tokenRes.ok) {
    throw new Error(`token endpoint failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const tokenJson = await tokenRes.json();
  const { token, url, room } = tokenJson;
  if (!token || !url) throw new Error(`bad token payload: ${JSON.stringify(tokenJson)}`);

  const events = [];
  const roomClient = new Room();

  roomClient
    .on(RoomEvent.ParticipantConnected, (participant) => events.push(`participant:${participant.identity}`))
    .on(RoomEvent.Disconnected, (reason) => events.push(`disconnected:${reason || ''}`))
    .on(RoomEvent.ConnectionStateChanged, (state) => events.push(`state:${state}`))
    .on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
      if (topic === 'hera.status') events.push(`status:${new TextDecoder().decode(payload)}`);
    });

  const start = Date.now();
  await roomClient.connect(url, token, { autoSubscribe: true, dynacast: false });
  const elapsedMs = Date.now() - start;

  const agent = await new Promise((resolve, reject) => {
    const existing = [...roomClient.remoteParticipants.values()][0];
    if (existing) return resolve(existing);
    const timer = setTimeout(() => reject(new Error('voice agent did not join within 20 seconds')), 20_000);
    const onParticipantConnected = (participant) => {
      clearTimeout(timer);
      roomClient.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      resolve(participant);
    };
    roomClient.on(RoomEvent.ParticipantConnected, onParticipantConnected);
  });

  await new Promise((resolve) => setTimeout(resolve, 2500));
  await roomClient.localParticipant.sendText(testPrompt, { topic: 'lk.chat' });
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  const summary = {
    ok: true,
    identity,
    room,
    url,
    sid: roomClient.sid,
    name: roomClient.name,
    connectionState: roomClient.connectionState,
    events,
    elapsedMs,
    participantSid: roomClient.localParticipant?.sid || null,
    agentIdentity: agent.identity,
    remoteParticipantCount: roomClient.remoteParticipants.size,
    textTurnSent: true,
  };
  console.log(JSON.stringify(summary, null, 2));

  await roomClient.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    identity,
    message: err?.message || String(err),
    stack: err?.stack || null,
    cause: err?.cause ? String(err.cause) : null,
  }, null, 2));
  process.exit(1);
});
