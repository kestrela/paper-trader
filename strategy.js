/**
 * 1m 双均线交叉 + RSI 过滤；止盈止损用 5m ATR14（由 1m 聚合）并设下限（引擎内）。
 * 快频纸面：每根已收盘 1m 可产生信号；冷却避免同向连开。
 */
'use strict';

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/** 把 1m K 线聚合为 N 分钟（按 openTime 对齐） */
function aggregate(candles, minutes = 5) {
  const ms = minutes * 60000;
  const out = [];
  for (const c of candles) {
    const b = Math.floor(c.t / ms) * ms;
    const last = out[out.length - 1];
    if (last && last.t === b) {
      last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; last.v += c.v;
    } else out.push({ t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
  }
  return out;
}

/**
 * @returns {{side:'long'|'short'|null, reason:string, atr:number|null, rsi:number|null, emaFast:number|null, emaSlow:number|null}}
 */
function signal(candles, opts = {}) {
  const fastP = opts.emaFast || 9;
  const slowP = opts.emaSlow || 21;
  const rsiP = opts.rsiPeriod || 14;
  const atrP = opts.atrPeriod || 14;
  const closed = candles.filter((c) => c.closed !== false);
  // 用已收盘 + 当前未收盘最后一根参与指标，但交叉只在「上一根已收盘」相对「再上一根」判定
  if (closed.length < slowP + 3) {
    return { side: null, reason: 'K线不足', atr: null, rsi: null, emaFast: null, emaSlow: null };
  }
  const closes = closed.map((c) => c.c);
  const fastS = emaSeries(closes, fastP);
  const slowS = emaSeries(closes, slowP);
  const i = closes.length - 1;
  const i1 = i - 1;
  const emaF = fastS[i], emaS = slowS[i];
  const emaF1 = fastS[i1], emaS1 = slowS[i1];
  const r = rsi(closes, rsiP);
  const a1 = atr(closed, atrP);
  const a5 = atr(aggregate(closed, 5), atrP);
  const a = a5 != null ? a5 : (a1 != null ? a1 * Math.sqrt(5) : null); // 优先 5m ATR
  if (emaF == null || emaS == null || emaF1 == null || emaS1 == null) {
    return { side: null, reason: '均线未就绪', atr: a, atr1m: a1, rsi: r, emaFast: emaF, emaSlow: emaS };
  }
  const crossUp = emaF1 <= emaS1 && emaF > emaS;
  const crossDn = emaF1 >= emaS1 && emaF < emaS;
  // RSI 过滤：多头避免超买，空头避免超卖
  if (crossUp && r != null && r < 70) {
    return { side: 'long', reason: `EMA${fastP}上穿EMA${slowP} RSI=${r.toFixed(1)}`, atr: a, atr1m: a1, rsi: r, emaFast: emaF, emaSlow: emaS };
  }
  if (crossDn && r != null && r > 30) {
    return { side: 'short', reason: `EMA${fastP}下穿EMA${slowP} RSI=${r.toFixed(1)}`, atr: a, atr1m: a1, rsi: r, emaFast: emaF, emaSlow: emaS };
  }
  return { side: null, reason: '无交叉', atr: a, atr1m: a1, rsi: r, emaFast: emaF, emaSlow: emaS };
}

module.exports = { ema, emaSeries, rsi, atr, aggregate, signal };
