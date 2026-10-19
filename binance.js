/**
 * 币安 U 本位公共行情（零依赖）。多 base 回退；云主机常遇 418/451。
 */
'use strict';

const https = require('https');
const { connect } = require('./ws_lite');

const FAPI_BASES = (process.env.FAPI_BASE ||
  'https://fapi.binance.com,https://www.binance.com,https://fapi1.binance.com,https://fapi2.binance.com,https://fapi3.binance.com')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

const WS_BASE = (process.env.WS_BASE || 'wss://fstream.binance.com').replace(/\/$/, '');
const WS_PATHS = (process.env.WS_PATHS || '/market/stream,/stream').split(',').map((s) => s.trim()).filter(Boolean);

function getJsonOnce(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; paper-trader/1.1)',
        Accept: 'application/json',
      },
    }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

let preferredBase = 0;
async function fapiGet(path, timeoutMs = 15000) {
  let lastErr;
  const start = preferredBase;
  for (let i = 0; i < FAPI_BASES.length; i++) {
    const idx = (start + i) % FAPI_BASES.length;
    try {
      const data = await getJsonOnce(FAPI_BASES[idx] + path, timeoutMs);
      preferredBase = idx;
      return data;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function fetchPrice(symbol) {
  const d = await fapiGet(`/fapi/v1/ticker/price?symbol=${symbol}`);
  return parseFloat(d.price);
}

async function fetchKlines(symbol, interval = '1m', limit = 120) {
  return fapiGet(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
}

async function fetchExchangeInfo(symbol) {
  const d = await fapiGet('/fapi/v1/exchangeInfo');
  const s = (d.symbols || []).find((x) => x.symbol === symbol);
  if (!s) return { tickSize: 0.01, stepSize: 0.001 };
  const pf = (s.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
  const lf = (s.filters || []).find((f) => f.filterType === 'LOT_SIZE');
  return {
    tickSize: pf ? parseFloat(pf.tickSize) : 0.01,
    stepSize: lf ? parseFloat(lf.stepSize) : 0.001,
  };
}

function parseKline(k) {
  return {
    t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], T: +k[6], closed: true,
  };
}

class MultiFeed {
  constructor(symbols, onUpdate) {
    this.symbols = symbols.map((s) => s.toUpperCase());
    this.onUpdate = onUpdate;
    this.ws = null;
    this.closed = false;
    this.pathIdx = 0;
    this.backoffMs = 1000;
    this.prices = {};
    this.marks = {};
    this.klines = {};
    this.lastMsgAt = 0;
    this.connected = false;
  }

  async bootstrap() {
    for (const sym of this.symbols) {
      this.klines[sym] = this.klines[sym] || [];
      try {
        const raw = await fetchKlines(sym, '1m', 200);
        this.klines[sym] = raw.map(parseKline);
        this.prices[sym] = this.klines[sym][this.klines[sym].length - 1].c;
      } catch (e) {
        console.warn(`[bootstrap] ${sym} K线 REST 失败，等 WS: ${e.message}`);
      }
      try {
        this.prices[sym] = await fetchPrice(sym);
      } catch (_) {}
    }
  }

  start() {
    this._open();
    this._timer = setInterval(() => this._watchdog(), 10000);
  }

  stop() {
    this.closed = true;
    if (this._timer) clearInterval(this._timer);
    if (this.ws) try { this.ws.close(); } catch (_) {}
  }

  _streams() {
    const parts = [];
    for (const s of this.symbols) {
      const L = s.toLowerCase();
      parts.push(`${L}@aggTrade`, `${L}@markPrice@1s`, `${L}@kline_1m`);
    }
    return parts.join('/');
  }

  _open() {
    if (this.closed) return;
    const path = WS_PATHS[this.pathIdx % WS_PATHS.length];
    const url = `${WS_BASE}${path}?streams=${this._streams()}`;
    const ws = connect(url);
    this.ws = ws;
    let gotData = false;
    ws.on('open', () => {
      this.connected = true;
      console.log(`[WS] 已连接 ${url}`);
      this._noData = setTimeout(() => {
        if (!gotData && this.ws === ws) {
          console.warn(`[WS] ${path} 20s 无数据，切换路径`);
          this.pathIdx++;
          ws.close();
        }
      }, 20000);
    });
    ws.on('message', (raw) => {
      gotData = true;
      this.backoffMs = 1000;
      this.lastMsgAt = Date.now();
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }
      const data = msg.data || msg;
      if (!data || !data.e) return;
      if (data.e === 'aggTrade') {
        const sym = data.s;
        this.prices[sym] = parseFloat(data.p);
        this.onUpdate && this.onUpdate({ type: 'trade', symbol: sym, price: this.prices[sym], ts: data.T || Date.now() });
      } else if (data.e === 'markPriceUpdate') {
        const sym = data.s;
        this.marks[sym] = parseFloat(data.p);
        this.onUpdate && this.onUpdate({ type: 'mark', symbol: sym, mark: this.marks[sym], ts: data.E || Date.now() });
      } else if (data.e === 'kline') {
        const k = data.k;
        const sym = data.s || k.s;
        const candle = { t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, T: +k.T, closed: !!k.x };
        const arr = this.klines[sym] || [];
        if (arr.length && arr[arr.length - 1].t === candle.t) {
          arr[arr.length - 1] = candle;
        } else {
          arr.push(candle);
          if (arr.length > 300) arr.shift();
        }
        this.klines[sym] = arr;
        this.prices[sym] = candle.c;
        this.onUpdate && this.onUpdate({
          type: 'kline', symbol: sym, candle, closed: candle.closed, price: candle.c, ts: Date.now(),
        });
      }
    });
    ws.on('error', (e) => console.error('[WS]', e.message));
    ws.on('close', () => {
      this.connected = false;
      if (this._noData) clearTimeout(this._noData);
      if (this.closed) return;
      const wait = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
      console.warn(`[WS] 断开，${wait}ms 后重连`);
      setTimeout(() => this._open(), wait);
    });
  }

  _watchdog() {
    if (this.closed) return;
    if (Date.now() - this.lastMsgAt > 45000 && this.ws) {
      console.warn('[WS] 心跳超时，强制重连');
      this.pathIdx++;
      try { this.ws.close(); } catch (_) {}
    }
  }
}

module.exports = {
  fapiGet, fetchPrice, fetchKlines, fetchExchangeInfo, parseKline, MultiFeed, FAPI_BASES,
};
