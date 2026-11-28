#!/usr/bin/env node
// Operation Blackout — LAN host.
//
// Serves the built single-file game over the local network and relays
// WebSocket frames between the host's browser tab (slot 0) and guests.
// Node standard library only: no npm install, no CDN, no internet.
//
// The host tab stays authoritative for the match; this process only moves
// bytes and tracks who is connected.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20; // 1 MiB per frame

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

export function parseArgs(argv) {
  const out = { port: 8787, host: '0.0.0.0', max: 4, game: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--max') out.max = Number(argv[++i]);
    else if (a === '--game') out.game = argv[++i];
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('bad --port');
  if (!Number.isInteger(out.max) || out.max < 2 || out.max > 8) throw new Error('bad --max (2..8)');
  return out;
}

export function encodeFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, body]);
}

// Pulls complete frames out of a socket buffer. Returns [frames, rest].
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const hi = buf.readUInt32BE(p);
      const lo = buf.readUInt32BE(p + 4);
      if (hi !== 0) throw new Error('frame too large');
      len = lo;
      p += 8;
    }
    if (len > MAX_PAYLOAD) throw new Error('frame too large');
    let mask;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length - p < len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return [frames, buf.subarray(off)];
}

function handshakeAccept(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

export async function startServer({ port, host, max, game }) {
  const peers = new Map(); // slot -> { socket, buf, fragments, alive }
  const gamePath = game || path.join(ROOT, 'dist', 'Operation Blackout.html');

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://lan');
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/Operation Blackout.html';
      const file = path.resolve(ROOT, 'dist', '.' + rel);
      if (!file.startsWith(path.join(ROOT, 'dist'))) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const st = await stat(file).catch(() => null);
      if (!st || !st.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('error: ' + err.message);
    }
  });

  const send = (slot, text) => {
    const p = peers.get(slot);
    if (p && !p.socket.destroyed) p.socket.write(encodeFrame(text));
  };

  const dropPeer = (slot, reason) => {
    const p = peers.get(slot);
    if (!p) return;
    peers.delete(slot);
    if (slot !== 0) send(0, JSON.stringify({ from: slot, msg: JSON.stringify({ type: 'peer', kind: 'leave', slot, reason }) }));
  };

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const free = () => {
      for (let s = 1; s < max; s++) if (!peers.has(s)) return s;
      return -1;
    };
    const wanted = Number(new URL(req.url, 'http://lan').searchParams.get('slot'));
    const assign = wanted === 0 && !peers.has(0) ? 0 : free();
    if (assign === -1) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nSec-WebSocket-Version: 13\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + handshakeAccept(key) + '\r\n\r\n'
    );
    socket.setNoDelay(true);

    const peer = { socket, buf: Buffer.alloc(0), fragments: [], alive: true };
    peers.set(assign, peer);

    send(assign, JSON.stringify({ type: 'welcome', slot: assign, max, peers: [...peers.keys()].sort() }));
    if (assign !== 0) send(0, JSON.stringify({ from: assign, msg: JSON.stringify({ type: 'peer', kind: 'join', slot: assign }) }));

    socket.on('data', (chunk) => {
      peer.buf = peer.buf.length ? Buffer.concat([peer.buf, chunk]) : chunk;
      let frames;
      try {
        [frames, peer.buf] = decodeFrames(peer.buf);
      } catch (err) {
        dropPeer(assign, 'protocol: ' + err.message);
        socket.destroy();
        return;
      }
      for (const f of frames) {
        if (f.opcode === 0x8) {
          try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch { /* closing */ }
          dropPeer(assign, 'close');
          socket.end();
          return;
        }
        if (f.opcode === 0x9) { socket.write(encodeFrame(f.payload, 0xa)); continue; }
        if (f.opcode === 0xa) continue;
        if (f.opcode === 0x0) {
          peer.fragments.push(f.payload);
          if (!f.fin) continue;
          const whole = Buffer.concat(peer.fragments);
          peer.fragments = [];
          relay(assign, whole.toString('utf8'));
          continue;
        }
        if (f.opcode === 0x1 || f.opcode === 0x2) {
          if (!f.fin) { peer.fragments = [f.payload]; continue; }
          relay(assign, f.payload.toString('utf8'));
        }
      }
    });

    socket.on('error', () => { dropPeer(assign, 'error'); socket.destroy(); });
    // Upgraded HTTP sockets default to allowHalfOpen, so a peer FIN shows up as
    // 'end' only; 'close' would never fire and the slot would leak forever.
    socket.on('end', () => { dropPeer(assign, 'close'); socket.end(); });
    socket.on('close', () => dropPeer(assign, 'close'));
  });

  function relay(slot, text) {
    if (text.length > MAX_PAYLOAD) return;
    let to = null;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.to === 'number') to = parsed.to;
    } catch { /* not JSON: pass through untagged */ }
    if (slot !== 0) {
      send(0, JSON.stringify({ from: slot, msg: text }));
      return;
    }
    const targets = to === null ? [...peers.keys()].filter((s) => s !== 0) : [to];
    for (const target of targets) send(target, JSON.stringify({ msg: text }));
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    server,
    port: server.address().port,
    peers,
    close: () => new Promise((r) => {
      for (const p of peers.values()) p.socket.destroy();
      server.close(() => r());
    }),
    gamePath,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const srv = await startServer(args);
  const addrs = lanAddresses();
  console.log('Operation Blackout LAN host');
  console.log('  game file : ' + srv.gamePath);
  console.log('  host tab  : http://localhost:' + srv.port + '/?lan=host');
  for (const a of addrs) console.log('  guest url : http://' + a + ':' + srv.port + '/?lan=join');
  console.log('  slots     : 1 host + ' + (args.max - 1) + ' guests');
  console.log('Ctrl+C to stop.');
}
