import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AccessToken } from 'livekit-server-sdk';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.join(__dirname, 'web');

const PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const LIVEKIT_WS_HOST = process.env.LIVEKIT_WS_HOST || '';
const ENABLE_LOCAL_TLS = /^(1|true|yes|on)$/i.test(process.env.ENABLE_LOCAL_TLS || '');
const GATEWAY = process.env.GATEWAY_URL || 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const GATEWAY_MODEL = process.env.GATEWAY_MODEL || 'openclaw/hera';
const GATEWAY_USER = process.env.GATEWAY_USER || 'moku-digital';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const LIVEKIT_INTERNAL_URL = process.env.LIVEKIT_INTERNAL_URL || 'ws://127.0.0.1:7880';
const LIVEKIT_ROOM = process.env.ROOM_NAME || 'hera-voice';
const TAILSCALE_TLS_DOMAIN = process.env.TAILSCALE_TLS_DOMAIN || '';
const TAILSCALE_CERT_DIR = process.env.TAILSCALE_CERT_DIR || path.join(__dirname, 'tailscale-certs');
const defaultTailscaleCert = TAILSCALE_TLS_DOMAIN ? path.join(TAILSCALE_CERT_DIR, `${TAILSCALE_TLS_DOMAIN}.crt`) : '';
const defaultTailscaleKey = TAILSCALE_TLS_DOMAIN ? path.join(TAILSCALE_CERT_DIR, `${TAILSCALE_TLS_DOMAIN}.key`) : '';
const TLS_CERT = process.env.TLS_CERT || defaultTailscaleCert || path.join(__dirname, 'server-cert.pem');
const TLS_KEY = process.env.TLS_KEY || defaultTailscaleKey || path.join(__dirname, 'server-key.pem');

function json(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function staticFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  return types[ext] || 'application/octet-stream';
}

async function handleChat(req, res) {
  if (!GATEWAY_TOKEN) return json(res, 500, { ok: false, error: 'Missing GATEWAY_TOKEN' });

  const raw = await readBody(req);
  const data = raw ? JSON.parse(raw) : {};
  const message = String(data.message || '').trim();
  if (!message) return json(res, 400, { ok: false, error: 'Missing message' });

  const payload = JSON.stringify({
    model: GATEWAY_MODEL,
    user: GATEWAY_USER,
    messages: [{ role: 'user', content: message.slice(0, 2000) }],
    stream: false,
  });

  const url = new URL('/v1/chat/completions', GATEWAY);
  const client = url.protocol === 'https:' ? https : http;

  const reply = await new Promise((resolve, reject) => {
    const proxyReq = client.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GATEWAY_TOKEN}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (proxyRes) => {
        let body = '';
        proxyRes.on('data', (chunk) => { body += chunk; });
        proxyRes.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if ((proxyRes.statusCode || 500) >= 400 || parsed.error) {
              const message = parsed.error?.message || `Gateway returned ${proxyRes.statusCode || 500}`;
              reject(new Error(message));
              return;
            }
            const text = parsed.choices?.[0]?.message?.content?.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            if (!text) {
              reject(new Error('Gateway returned an empty reply'));
              return;
            }
            resolve(text);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    proxyReq.on('error', reject);
    proxyReq.setTimeout(30000, () => proxyReq.destroy(new Error('Gateway timeout')));
    proxyReq.write(payload);
    proxyReq.end();
  });

  return json(res, 200, { ok: true, reply });
}

function getForwardedHeaderValue(headerValue) {
  return String(headerValue || '').split(',')[0].trim();
}

function getExternalRequestContext(req) {
  const forwardedProto = getForwardedHeaderValue(req.headers['x-forwarded-proto']);
  const forwardedHost = getForwardedHeaderValue(req.headers['x-forwarded-host']);
  const forwardedPort = getForwardedHeaderValue(req.headers['x-forwarded-port']);

  const rawHost = forwardedHost || req.headers.host || `localhost:${req.socket.encrypted ? HTTPS_PORT : PORT}`;
  const proto = (forwardedProto || (req.socket.encrypted ? 'https' : 'http')).toLowerCase();

  let host = rawHost;
  if (forwardedHost && forwardedPort) {
    const hostnameOnly = rawHost.replace(/:\d+$/, '');
    const isDefaultPort = (proto === 'https' && forwardedPort === '443') || (proto === 'http' && forwardedPort === '80');
    host = isDefaultPort ? hostnameOnly : `${hostnameOnly}:${forwardedPort}`;
  } else if (forwardedProto && !forwardedHost && req.headers.host) {
    const hostnameOnly = String(req.headers.host).replace(/:\d+$/, '');
    const currentPort = String(req.headers.host).match(/:(\d+)$/)?.[1] || '';
    const isDefaultPort = (proto === 'https' && currentPort === '443') || (proto === 'http' && currentPort === '80');
    host = isDefaultPort || !currentPort ? hostnameOnly : `${hostnameOnly}:${currentPort}`;
  }

  const protocol = proto === 'https' ? 'wss' : 'ws';
  return { host, protocol };
}

async function handleLivekitToken(req, res) {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return json(res, 500, { ok: false, error: 'Missing LiveKit credentials' });
  }

  const raw = await readBody(req);
  const data = raw ? JSON.parse(raw) : {};
  const identity = String(data.identity || GATEWAY_USER || 'moku-digital').trim();
  if (!identity) return json(res, 400, { ok: false, error: 'Missing identity' });

  // Give every browser session its own room. Reusing one fixed room lets a
  // reconnect attach to an agent job that is still shutting down from the
  // previous session, leaving the user with audio but no active listener.
  const roomName = `${LIVEKIT_ROOM}-${randomUUID().slice(0, 8)}`;
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity });
  token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  const jwt = await token.toJwt();

  const { host, protocol } = getExternalRequestContext(req);
  // LiveKit SDK expects just the server URL (wss://host:port), NOT including /rtc
  // The SDK appends /rtc itself during connection
  const livekitUrl = `${protocol}://${host}`;
  return json(res, 200, {
    ok: true,
    token: jwt,
    url: livekitUrl,
    identity,
    room: roomName,
  });
}

function proxyLivekitHttp(req, res) {
  // Proxy HTTP requests (GET/POST) for /rtc paths to LiveKit server
  const lkUrl = new URL(LIVEKIT_INTERNAL_URL.replace(/^ws/, 'http'));
  const targetPath = `${lkUrl.pathname === '/' ? '' : lkUrl.pathname}${req.url}`;
  const targetUrl = new URL(targetPath, `${lkUrl.protocol}//${lkUrl.host}`);

  console.log(`[RTC HTTP PROXY] ${req.method} ${req.url} -> ${targetUrl.toString()}`);

  const proxyReq = (lkUrl.protocol === 'https:' ? https : http).request(targetUrl, {
    method: req.method,
    headers: { ...req.headers, host: lkUrl.host },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error('[RTC HTTP PROXY] Error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
    }
  });

  req.pipe(proxyReq, { end: true });
}

async function handleRequest(req, res) {
  const urlPath = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  // Proxy HTTP requests for /rtc paths to LiveKit (validation, join requests, etc.)
  // The LiveKit SDK makes HTTP requests to /rtc/v1/validate before WebSocket upgrade
  if (urlPath.startsWith('/rtc')) {
    return proxyLivekitHttp(req, res);
  }

  try {
    if (req.method === 'GET' && (urlPath === '/health' || urlPath === '/api/health')) {
      return json(res, 200, {
        ok: true,
        service: 'moku-digital-ai-voice-web',
        tls: ENABLE_LOCAL_TLS,
        gateway_configured: Boolean(GATEWAY_TOKEN),
        livekit_configured: Boolean(LIVEKIT_API_KEY && LIVEKIT_API_SECRET),
        room: LIVEKIT_ROOM,
      });
    }
    if (req.method === 'POST' && urlPath === '/api/chat') return await handleChat(req, res);
    if (req.method === 'POST' && (urlPath === '/api/livekit-token' || urlPath === '/api/token')) return await handleLivekitToken(req, res);

    const candidate = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = path.join(webRoot, candidate);
    const safePath = path.normalize(filePath);
    if (!safePath.startsWith(webRoot)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    const fallbackPath = path.join(webRoot, 'index.html');
    const toServe = fs.existsSync(safePath) && fs.statSync(safePath).isFile() ? safePath : fallbackPath;
    res.writeHead(200, {
      'Content-Type': staticFile(toServe),
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    fs.createReadStream(toServe).pipe(res);
  } catch (error) {
    console.error(error);
    json(res, 500, { ok: false, error: error.message || 'Server error' });
  }
}

const server = http.createServer(handleRequest);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`HTTP server listening on ${PORT}`);
});

function attachRtcProxy(serverInstance) {
  const upstreamUrl = new URL(LIVEKIT_INTERNAL_URL.replace(/^ws/, 'http'));
  const connectUpstream = upstreamUrl.protocol === 'https:'
    ? (options, cb) => tls.connect(options, cb)
    : (options, cb) => net.connect(options, cb);

  serverInstance.on('upgrade', (req, socket, head) => {
    console.log(`[RTC PROXY] Upgrade request: ${req.url} from ${req.headers.host}`);
    if (!req.url || !req.url.startsWith('/rtc')) {
      console.log(`[RTC PROXY] Rejected: path doesn't start with /rtc`);
      socket.destroy();
      return;
    }

    const upstreamSocket = connectUpstream(
      {
        host: upstreamUrl.hostname,
        port: Number(upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80)),
        servername: upstreamUrl.hostname,
      },
      () => {
        const pathWithQuery = `${upstreamUrl.pathname === '/' ? '' : upstreamUrl.pathname}${req.url}`;
        const headers = Object.entries(req.headers)
          .flatMap(([key, value]) => Array.isArray(value)
            ? value.map((item) => `${key}: ${item}`)
            : value !== undefined
              ? [`${key}: ${value}`]
              : [])
          .join('\r\n');

        console.log(`[RTC PROXY] Piping upgrade to LiveKit: ${pathWithQuery}`);
        upstreamSocket.write(`GET ${pathWithQuery} HTTP/1.1\r\n${headers}\r\n\r\n`);
        if (head?.length) upstreamSocket.write(head);
      }
    );

    upstreamSocket.on('connect', () => {
      console.log('[RTC PROXY] Upstream connected to LiveKit');
    });

    upstreamSocket.on('error', (err) => {
      console.error('RTC proxy upstream error:', err.message);
      if (!socket.destroyed) socket.destroy();
    });
    socket.on('error', () => upstreamSocket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => {
      if (!socket.destroyed) socket.end();
    });

    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
}

attachRtcProxy(server);

if (ENABLE_LOCAL_TLS) {
  if (fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
    const httpsServer = https.createServer(
      {
        cert: fs.readFileSync(TLS_CERT),
        key: fs.readFileSync(TLS_KEY),
      },
      handleRequest
    );

    attachRtcProxy(httpsServer);

    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`HTTPS server listening on ${HTTPS_PORT}`);
    });
  } else {
    console.warn('ENABLE_LOCAL_TLS is set but TLS cert or key is missing. HTTPS server not started.');
  }
} else {
  console.log('Local TLS disabled. Expect HTTPS termination from Tailscale funnel/serve in front of this HTTP server.');
}
