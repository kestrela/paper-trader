/**
 * 纸面交易引擎：保证金、杠杆、强平近似、持久化。默认不计手续费、无滑点（FEE_RATE / SLIP_TICKS 可调）。
 * 不下真实单。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TAKER_FEE = Math.max(0, parseFloat(process.env.FEE_RATE || '0')); // 默认 0：不计手续费
const SLIP_TICKS = Math.max(0, parseInt(process.env.SLIP_TICKS || '0', 10)); // 默认 0：无滑点
const DEFAULT_LEVERAGE = 5;
const MAX_LEVERAGE = 10;
const MARGIN_FRAC = parseFloat(process.env.MARGIN_FRAC || '0.12'); // 单笔占用权益约 12% 作保证金
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '4', 10);  // 同时持仓上限
const COOLDOWN_MS = 3 * 60 * 1000; // 同品种同向冷却 3 分钟
const ATR_SL_MULT = 1.5;   // × ATR14(5m)
const ATR_TP_MULT = 2.2;   // × ATR14(5m)
const SL_MIN_PCT = parseFloat(process.env.SL_MIN_PCT || '0.0025'); // 止损下限 0.25%
const TP_MIN_PCT = parseFloat(process.env.TP_MIN_PCT || '0.004');  // 止盈下限 0.40%
const TP_MIN_RR = 1.5;     // 止盈距离 ≥ 1.5 × 止损距离
const DEPTH_FRAC = parseFloat(process.env.DEPTH_FRAC || '0.15'); // 名义 ≤ ±0.2% 盘口深度（较薄一侧）的 15%
const MIN_HOLD_MS = 15 * 1000;
const MAX_HOLD_MS = 90 * 60 * 1000; // 最长持仓 90 分钟

function roundTo(x, tick) {
  if (!tick || tick <= 0) return x;
  const n = Math.round(x / tick);
  const decimals = Math.max(0, (String(tick).split('.')[1] || '').length);
  return +(n * tick).toFixed(decimals);
}

function fmtTs(ms) {
  const s = new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  return `${s} (UTC+8)`;
}

class PaperEngine {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.initial = opts.initialCapital || 10000;
    this.leverage = Math.min(MAX_LEVERAGE, Math.max(1, opts.leverage || DEFAULT_LEVERAGE));
    this.equity = this.initial;
    this.cash = this.initial; // 可用保证金（简化：权益-占用保证金）
    this.positions = []; // open
    this.trades = [];    // closed
    this.equityCurve = [];
    this.meta = {
      symbols: opts.symbols || ['BTCUSDT', 'ETHUSDT'],
      leverage: this.leverage,
      startedAt: Date.now(),
      feeRate: TAKER_FEE,
      slipTicks: SLIP_TICKS,
      note: '纸面模拟 · 非真实盈亏',
    };
    this.ticks = {}; // symbol -> tickSize
    this.depth = {}; // symbol -> {bid02,ask02,spreadPct,ts} USD 深度（±0.2%）
    this.lastSignalAt = {}; // key symbol:side -> ts
    this.lastBarSignal = {}; // symbol -> bar open time already acted
    this._ensureDir();
    this._load();
  }

  _ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  setDepth(symbol, d) { if (d) this.depth[symbol] = d; }

  setTick(symbol, tickSize) {
    this.ticks[symbol] = tickSize || 0.01;
  }

  _statePath() { return path.join(this.dir, 'state.json'); }
  _tradesPath() { return path.join(this.dir, 'trades.jsonl'); }
  _equityPath() { return path.join(this.dir, 'equity.csv'); }

  _load() {
    try {
      if (fs.existsSync(this._statePath())) {
        const s = JSON.parse(fs.readFileSync(this._statePath(), 'utf8'));
        this.equity = s.equity ?? this.initial;
        this.cash = s.cash ?? this.equity;
        this.positions = s.positions || [];
        this.meta = { ...this.meta, ...s.meta, feeRate: TAKER_FEE, slipTicks: SLIP_TICKS, symbols: this.meta.symbols, leverage: this.leverage, note: '纸面模拟 · 非真实盈亏' };
        if (s.initial) this.initial = s.initial;
      }
    } catch (e) { console.warn('[engine] load state:', e.message); }
    try {
      if (fs.existsSync(this._tradesPath())) {
        const lines = fs.readFileSync(this._tradesPath(), 'utf8').trim().split('\n').filter(Boolean);
        this.trades = lines.map((l) => JSON.parse(l)).slice(-500);
      }
    } catch (e) { console.warn('[engine] load trades:', e.message); }
    if (!fs.existsSync(this._equityPath())) {
      fs.writeFileSync(this._equityPath(), 'ts,ts_cn,equity,unrealized,open_n\n');
    }
  }

  persist() {
    const snap = {
      initial: this.initial,
      equity: this.equity,
      cash: this.cash,
      positions: this.positions,
      meta: this.meta,
      savedAt: Date.now(),
      savedAtCn: fmtTs(Date.now()),
    };
    fs.writeFileSync(this._statePath(), JSON.stringify(snap, null, 2));
  }

  _appendTrade(t) {
    this.trades.push(t);
    if (this.trades.length > 500) this.trades = this.trades.slice(-500);
    fs.appendFileSync(this._tradesPath(), JSON.stringify(t) + '\n');
  }

  markEquity(prices) {
    let unreal = 0;
    for (const p of this.positions) {
      const px = prices[p.symbol];
      if (px == null) continue;
      unreal += this._pnl(p, px);
    }
    const eq = this.cash + this.positions.reduce((a, p) => a + p.margin, 0) + unreal;
    // 更清晰：权益 = 可用现金 + 占用保证金 + 未实现盈亏
    this.equity = eq;
    return { equity: eq, unrealized: unreal };
  }

  recordEquity(prices) {
    const { equity, unrealized } = this.markEquity(prices);
    const now = Date.now();
    const line = `${now},${fmtTs(now)},${equity.toFixed(4)},${unrealized.toFixed(4)},${this.positions.length}\n`;
    fs.appendFileSync(this._equityPath(), line);
    this.equityCurve.push({ ts: now, equity, unrealized });
    if (this.equityCurve.length > 2000) this.equityCurve = this.equityCurve.slice(-2000);
    this.persist();
    return { equity, unrealized };
  }

  _slipPrice(symbol, side, isEntry, rawPrice) {
    const tick = this.ticks[symbol] || 0.01;
    if (!SLIP_TICKS) return rawPrice;
    const slip = tick * SLIP_TICKS;
    // 入场：多买高一跳、空卖低一跳；出场相反
    if (isEntry) {
      return side === 'long' ? roundTo(rawPrice + slip, tick) : roundTo(rawPrice - slip, tick);
    }
    return side === 'long' ? roundTo(rawPrice - slip, tick) : roundTo(rawPrice + slip, tick);
  }

  _pnl(pos, exitPrice) {
    const dir = pos.side === 'long' ? 1 : -1;
    return dir * (exitPrice - pos.entry) * pos.qty;
  }

  _liqPrice(pos) {
    // 简化：维持保证金约 0.5%，强平价 ≈ 入场 ± (1/lev - mmr) * entry
    const mmr = 0.005;
    const move = (1 / pos.leverage - mmr);
    if (pos.side === 'long') return pos.entry * (1 - move);
    return pos.entry * (1 + move);
  }

  tryOpen(symbol, side, price, atr, reason) {
    if (this.positions.length >= MAX_POSITIONS) return null;
    if (this.meta.symbols && !this.meta.symbols.includes(symbol)) return null;
    if (this.positions.some((p) => p.symbol === symbol)) return null; // 同品种单仓
    const key = `${symbol}:${side}`;
    const now = Date.now();
    if (this.lastSignalAt[key] && now - this.lastSignalAt[key] < COOLDOWN_MS) return null;

    const { equity } = this.markEquity({ [symbol]: price });
    if (equity < 50) return null;

    let margin = Math.min(this.cash * 0.9, equity * MARGIN_FRAC);
    if (margin < 10) return null;

    let notional = margin * this.leverage;
    // 流动性约束：名义 ≤ DEPTH_FRAC × 较薄一侧 ±0.2% 深度
    const dp = this.depth[symbol];
    if (dp && dp.bid02 > 0 && dp.ask02 > 0) {
      const cap = DEPTH_FRAC * Math.min(dp.bid02, dp.ask02);
      if (notional > cap) { notional = cap; margin = notional / this.leverage; }
    }
    if (margin < 10) return null;
    const entry = this._slipPrice(symbol, side, true, price);
    const qty = notional / entry;
    const fee = notional * TAKER_FEE;
    if (this.cash < margin + fee) return null;

    // atr 为 5m ATR14；带下限，避免止盈止损落在噪声内
    const atrSafe = atr && atr > 0 ? atr : entry * 0.003;
    const slDist = Math.max(atrSafe * ATR_SL_MULT, entry * SL_MIN_PCT);
    const tpDist = Math.max(atrSafe * ATR_TP_MULT, entry * TP_MIN_PCT, slDist * TP_MIN_RR);
    const sl = side === 'long' ? entry - slDist : entry + slDist;
    const tp = side === 'long' ? entry + tpDist : entry - tpDist;

    this.cash -= margin + fee;
    const pos = {
      id: `P${now}-${symbol}-${side}`,
      symbol, side, entry, qty, margin,
      leverage: this.leverage,
      notional,
      feeOpen: fee,
      slPct: slDist / entry * 100,
      tpPct: tpDist / entry * 100,
      sl: roundTo(sl, this.ticks[symbol] || 0.01),
      tp: roundTo(tp, this.ticks[symbol] || 0.01),
      liq: this._liqPrice({ side, entry, leverage: this.leverage }),
      openedAt: now,
      openedAtCn: fmtTs(now),
      reason: reason || '',
    };
    this.positions.push(pos);
    this.lastSignalAt[key] = now;
    this.persist();
    console.log(`[开仓] ${side.toUpperCase()} ${symbol} @ ${entry} qty=${qty.toFixed(6)} lev=${this.leverage}x 保证金=${margin.toFixed(2)} 名义=${notional.toFixed(0)} TP=${pos.tp}(${pos.tpPct.toFixed(2)}%) SL=${pos.sl}(${pos.slPct.toFixed(2)}%) | ${reason}`);
    return pos;
  }

  _close(pos, rawPrice, why) {
    const exit = this._slipPrice(pos.symbol, pos.side, false, rawPrice);
    const pnlGross = this._pnl(pos, exit);
    const feeClose = pos.qty * exit * TAKER_FEE;
    const pnl = pnlGross - feeClose - (pos.feeOpen || 0);
    this.cash += pos.margin + pnlGross - feeClose;
    // feeOpen 已在开仓时从 cash 扣过，pnl 报表里再体现总成本
    const trade = {
      id: pos.id,
      symbol: pos.symbol,
      side: pos.side,
      entry: pos.entry,
      exit,
      qty: pos.qty,
      leverage: pos.leverage,
      margin: pos.margin,
      pnl,
      pnlGross,
      feeOpen: pos.feeOpen,
      feeClose,
      reasonOpen: pos.reason,
      reasonClose: why,
      openedAt: pos.openedAt,
      openedAtCn: pos.openedAtCn,
      closedAt: Date.now(),
      closedAtCn: fmtTs(Date.now()),
      holdMs: Date.now() - pos.openedAt,
    };
    this.positions = this.positions.filter((p) => p.id !== pos.id);
    this._appendTrade(trade);
    this.persist();
    const tag = pnl >= 0 ? '盈' : '亏';
    console.log(`[平仓·${tag}] ${pos.side} ${pos.symbol} ${pos.entry}->${exit} pnl=${pnl.toFixed(4)} USDT | ${why}`);
    return trade;
  }

  /**
   * 用最新价检查止盈/止损/强平/超时
   */
  onPrice(symbol, price) {
    const now = Date.now();
    const toClose = [];
    for (const pos of this.positions) {
      if (pos.symbol !== symbol) continue;
      const held = now - pos.openedAt;
      if (held < MIN_HOLD_MS) continue;
      // 强平
      if (pos.side === 'long' && price <= pos.liq) {
        toClose.push([pos, price, '强平(近似)']);
        continue;
      }
      if (pos.side === 'short' && price >= pos.liq) {
        toClose.push([pos, price, '强平(近似)']);
        continue;
      }
      if (pos.side === 'long') {
        if (price <= pos.sl) toClose.push([pos, price, '止损']);
        else if (price >= pos.tp) toClose.push([pos, price, '止盈']);
        else if (held >= MAX_HOLD_MS) toClose.push([pos, price, '超时平仓']);
      } else {
        if (price >= pos.sl) toClose.push([pos, price, '止损']);
        else if (price <= pos.tp) toClose.push([pos, price, '止盈']);
        else if (held >= MAX_HOLD_MS) toClose.push([pos, price, '超时平仓']);
      }
    }
    const closed = [];
    for (const [pos, px, why] of toClose) {
      if (!this.positions.find((p) => p.id === pos.id)) continue;
      closed.push(this._close(pos, px, why));
    }
    return closed;
  }

  /**
   * 已收盘 1m K 线后尝试开仓（由 app 调用）
   */
  onClosedBar(symbol, candles, price, sig) {
    if (!sig || !sig.side) return null;
    if (this.lastBarSignal[symbol] === candles[candles.length - 1].t) return null;
    this.lastBarSignal[symbol] = candles[candles.length - 1].t;
    return this.tryOpen(symbol, sig.side, price, sig.atr, sig.reason);
  }

  stats() {
    const closed = this.trades;
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl <= 0);
    const sumPnl = closed.reduce((a, t) => a + t.pnl, 0);
    return {
      trades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? wins.length / closed.length : 0,
      sumPnl,
      avgPnl: closed.length ? sumPnl / closed.length : 0,
      openN: this.positions.length,
      equity: this.equity,
      initial: this.initial,
      retPct: ((this.equity - this.initial) / this.initial) * 100,
    };
  }

  snapshot(prices) {
    this.markEquity(prices || {});
    const st = this.stats();
    return {
      meta: this.meta,
      equity: this.equity,
      cash: this.cash,
      initial: this.initial,
      retPct: st.retPct,
      positions: this.positions.map((p) => ({
        ...p,
        mark: prices[p.symbol],
        uPnl: prices[p.symbol] != null ? this._pnl(p, prices[p.symbol]) : null,
        liqRiskNote: '杠杆越高强平越近，纸面强平为近似模型',
      })),
      recentTrades: this.trades.slice(-30).reverse(),
      stats: st,
      prices: prices || {},
      updatedAt: Date.now(),
      updatedAtCn: fmtTs(Date.now()),
      disclaimer: '纸面模拟数据，非真实交易盈亏。不计手续费、无滑点。高杠杆高波动，结果不可外推实盘。',
    };
  }
}

module.exports = {
  PaperEngine, TAKER_FEE, SLIP_TICKS, MARGIN_FRAC, MAX_POSITIONS, ATR_SL_MULT, ATR_TP_MULT, SL_MIN_PCT, TP_MIN_PCT, TP_MIN_RR, DEPTH_FRAC, MAX_HOLD_MS, COOLDOWN_MS, DEFAULT_LEVERAGE, MAX_LEVERAGE, fmtTs,
};
