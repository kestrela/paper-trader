#!/usr/bin/env node
/**
 * Minimal WSS client (zero deps). Client frames only: text + close + ping/pong.
 */
'use strict';

const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');

function parseUrl(urlStr) {
  const u = new URL(urlStr);
  if (u.protocol !== 'wss:') throw new Error('Only wss:// supported');
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 443,
    path: (u.pathname || '/') + u.search,
  };
}

class WsLite extends EventEmitter {
  constructor(urlStr, opts = {}) {
    super();
    this.urlStr = urlStr;
    this.opts = opts;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this._connect();
  }

  _connect() {
    const { host, port, path } = parseUrl(this.urlStr);
    const key = crypto.randomBytes(16).toString('base64');
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: true,
      },
      () => {
        const headers = [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          'User-Agent: koruusdt-monitor/1.0',
          '',
          '',
        ].join('\r\n');
        socket.write(headers);
      }
    );
    this.socket = socket;
    socket.setKeepAlive(true);
    socket.on('data', (chunk) => this._onData(chunk, key));
    socket.on('error', (err) => {
      if (!this.closed) this.emit('error', err);
    });
    socket.on('close', () => {
      this.closed = true;
      this.emit('close');
    });
  }

  _onData(chunk, expectedKey) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this._handshakeDone) {
      const idx = this.buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = this.buf.slice(0, idx).toString('utf8');
      this.buf = this.buf.slice(idx + 4);
      if (!/^HTTP\/1\.1 101/i.test(head)) {
        this.emit('error', new Error('WS handshake failed: ' + head.split('\r\n')[0]));
        this.close();
        return;
      }
      this._handshakeDone = true;
      this.emit('open');
    }
    this._parseFrames();
  }

  _parseFrames() {
    while (true) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const hi = this.buf.readUInt32BE(2);
        const lo = this.buf.readUInt32BE(6);
        if (hi !== 0) {
          this.emit('error', new Error('Frame too large'));
          this.close();
          return;
        }
        len = lo;
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.slice(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buf = this.buf.slice(off + maskLen + len);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this._sendFrame(0xA, payload);
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x1) {
        this.emit('message', payload.toString('utf8'));
      } else if (opcode === 0x2) {
        this.emit('message', payload);
      }
    }
  }

  _sendFrame(opcode, payload) {
    if (!this.socket || this.closed) return;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8');
    const mask = crypto.randomBytes(4);
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) {
    this._sendFrame(0x1, text);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
    } catch (_) {}
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
    }
  }
}

function connect(urlStr, opts) {
  return new WsLite(urlStr, opts);
}

module.exports = { connect, WsLite };
