// Protocol and relay tests for the LAN host. Node standard library only.
// Run: node --test tests/test_lan_host.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer, decodeFrames, encodeFrame } from '../tools/lan-host.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function maskedFrame(text) {
  const body = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  const len = body.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
  else { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  head[0] = 0x81;
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, out]);
}

class Client {
  constructor(socket) { this.socket = socket; this.buf = Buffer.alloc(0); this.texts = []; this.closed = false; }
  static connect(port, slot) {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64');
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          `GET /ws?slot=${slot} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      let raw = Buffer.alloc(0);
      let done = false;
      const onData = (chunk) => {
        raw = Buffer.concat([raw, chunk]);
        const idx = raw.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = raw.subarray(0, idx).toString();
        const rest = raw.subarray(idx + 4);
        if (!done) {
          done = true;
          socket.off('data', onData);
          if (!/^HTTP\/1\.1 101/.test(head)) { reject(new Error('handshake failed: ' + head.split('\r\n')[0])); socket.destroy(); return; }
          const expected = createHash('sha1').update(key + GUID).digest('base64');
          if (!head.includes(expected)) { reject(new Error('bad accept key')); socket.destroy(); return; }
          const c = new Client(socket);
          if (rest.length) c._push(rest);
          resolve(c);
        }
      };
      socket.on('data', onData);
      socket.on('error', reject);
    });
  }
  _push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const [frames, rest] = decodeFrames(this.buf);
    this.buf = rest;
    for (const f of frames) {
      if (f.opcode === 0x1) this.texts.push(f.payload.toString('utf8'));
      if (f.opcode === 0x8) this.closed = true;
    }
  }
  start() { this.socket.on('data', (c) => this._push(c)); return this; }
  send(text) { this.socket.write(maskedFrame(text)); }
  async next(timeout = 1500) {
    const started = Date.now();
    while (!this.texts.length) {
      if (Date.now() - started > timeout) throw new Error('timeout waiting for frame');
      await new Promise((r) => setTimeout(r, 15));
    }
    return JSON.parse(this.texts.shift());
  }
  async drain(ms = 250) {
    const out = [];
    const until = Date.now() + ms;
    while (Date.now() < until) {
      while (this.texts.length) out.push(JSON.parse(this.texts.shift()));
      await new Promise((r) => setTimeout(r, 15));
    }
    return out;
  }
  end() { this.socket.destroy(); }
}

async function withServer(max, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lan-host-'));
  await mkdir(path.join(dir, 'dist'), { recursive: true });
  await writeFile(path.join(dir, 'dist', 'Operation Blackout.html'), '<!doctype html><title>ob</title>');
  const proc = await startServer({ port: 0, host: '127.0.0.1', max });
  // startServer resolves gamePath from repo root; point requests at the temp tree instead
  const server = proc.server;
  const oldListeners = server.listeners('request').slice();
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>ob</title>');
  });
  void oldListeners; void dir;
  try { await fn(proc); } finally { await proc.close(); }
}

test('decodeFrames handles split and masked frames', () => {
  const frame = maskedFrame('{"a":1}');
  const [none, rest] = decodeFrames(frame.subarray(0, 4));
  assert.equal(none.length, 0);
  assert.equal(rest.length, 4);
  const [full, tail] = decodeFrames(frame);
  assert.equal(full.length, 1);
  assert.equal(full[0].payload.toString(), '{"a":1}');
  assert.equal(tail.length, 0);
});

test('encodeFrame length encodings round-trip', () => {
  for (const size of [3, 200, 70000]) {
    const text = 'x'.repeat(size);
    const [frames] = decodeFrames(encodeFrame(text));
    assert.equal(frames[0].payload.length, size);
  }
});

test('host claims slot 0 and guest gets slot 1 with join notice', async () => {
  await withServer(4, async ({ port }) => {
    const host = await Client.connect(port, 0).then((c) => c.start());
    const welcome = await host.next();
    assert.equal(welcome.type, 'welcome');
    assert.equal(welcome.slot, 0);

    const guest = await Client.connect(port, 1).then((c) => c.start());
    const gw = await guest.next();
    assert.equal(gw.slot, 1, 'guest must not take the host slot');

    const join = await host.next();
    assert.equal(join.from, 1);
    assert.deepEqual(JSON.parse(join.msg), { type: 'peer', kind: 'join', slot: 1 });
    host.end(); guest.end();
  });
});

test('guest input reaches the host, host reply reaches the guest', async () => {
  await withServer(4, async ({ port }) => {
    const host = await Client.connect(port, 0).then((c) => c.start());
    await host.next();
    const guest = await Client.connect(port, 1).then((c) => c.start());
    await guest.next();
    await host.next();

    guest.send(JSON.stringify({ type: 'input', seq: 7, moveX: 1 }));
    const got = await host.next();
    assert.equal(got.from, 1);
    assert.equal(JSON.parse(got.msg).seq, 7);

    host.send(JSON.stringify({ to: 1, type: 'state', tick: 42 }));
    const st = await guest.next();
    assert.equal(JSON.parse(st.msg).tick, 42);
    host.end(); guest.end();
  });
});

test('host broadcast reaches every guest', async () => {
  await withServer(4, async ({ port }) => {
    const host = await Client.connect(port, 0).then((c) => c.start());
    await host.next();
    const g1 = await Client.connect(port, 1).then((c) => c.start());
    const g2 = await Client.connect(port, 2).then((c) => c.start());
    await g1.drain(200); await g2.drain(200); await host.drain(200);
    host.send(JSON.stringify({ type: 'state', tick: 1 }));
    assert.equal(JSON.parse((await g1.next()).msg).tick, 1);
    assert.equal(JSON.parse((await g2.next()).msg).tick, 1);
    host.end(); g1.end(); g2.end();
  });
});

test('disconnect frees the slot and notifies the host', async () => {
  await withServer(2, async ({ port }) => {
    const host = await Client.connect(port, 0).then((c) => c.start());
    await host.next();
    const g1 = await Client.connect(port, 1).then((c) => c.start());
    await g1.next();
    await host.drain(200);
    g1.end();
    const leave = await host.next(2000);
    assert.equal(JSON.parse(leave.msg).kind, 'leave');

    const g2 = await Client.connect(port, 1).then((c) => c.start());
    assert.equal((await g2.next()).slot, 1);
    host.end(); g2.end();
  });
});

test('server refuses connections beyond the slot budget', async () => {
  await withServer(2, async ({ port }) => {
    const host = await Client.connect(port, 0).then((c) => c.start());
    await host.next();
    const g1 = await Client.connect(port, 1).then((c) => c.start());
    await g1.next();
    await assert.rejects(Client.connect(port, 2), /503/);
    host.end(); g1.end();
  });
});
