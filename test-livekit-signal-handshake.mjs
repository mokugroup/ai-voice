import WebSocket from 'ws';

const endpoint = process.env.VOICE_TEST_ENDPOINT || 'http://127.0.0.1:8080/api/livekit-token';
const identity = `livekit-signal-${Date.now()}`;

async function main() {
  const tokenRes = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identity }),
  });
  if (!tokenRes.ok) throw new Error(`token endpoint failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const tokenJson = await tokenRes.json();
  const wsUrl = new URL(tokenJson.url);
  wsUrl.searchParams.set('access_token', tokenJson.token);
  wsUrl.searchParams.set('auto_subscribe', '0');
  wsUrl.searchParams.set('sdk', 'js');
  wsUrl.searchParams.set('version', '2.15.13');
  wsUrl.searchParams.set('protocol', '15');

  const result = await new Promise((resolve, reject) => {
    const messages = [];
    const ws = new WebSocket(wsUrl, {
      rejectUnauthorized: true,
      handshakeTimeout: 15000,
    });

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('timeout waiting for LiveKit signal response'));
    }, 15000);

    ws.on('open', () => {
      messages.push('open');
    });

    ws.on('message', (data, isBinary) => {
      const preview = isBinary
        ? `binary:${Buffer.from(data).byteLength}`
        : String(data).slice(0, 400);
      messages.push(preview);
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve({
        ok: true,
        identity,
        room: tokenJson.room,
        wsUrl: wsUrl.toString().replace(tokenJson.token, '<redacted-token>'),
        messages,
      });
    });

    ws.on('close', (code, reason) => {
      messages.push(`close:${code}:${reason.toString()}`);
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`${err.message}`));
    });
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    identity,
    message: err?.message || String(err),
    stack: err?.stack || null,
  }, null, 2));
  process.exit(1);
});
