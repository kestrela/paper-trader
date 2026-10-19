#!/usr/bin/env node
/**
 * 纸面交易主程序：币安 U 本位「股票型合约」(TRADIFI_PERPETUAL) 流动性最好的若干个，
 * 1m EMA9/21 交叉 + RSI，5m ATR 止盈止损（带下限），5x 杠杆，不计手续费，状态页 :8787。
 * 不下真实单，无需 API Key。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { MultiFeed, fetchExchangeInfo } = require('./binance');
const { selectEquityUniverse, depthStats } = require('./universe');
const { signal } = require('./strategy');
const { PaperEngine, fmtTs } = require('./engine');
const { createServer } = require('./server');
const { WeComSummary } = require('./wecom');

const DIR = process.env.PAPER_DIR || path.join(__dirname);
const PORT = parseInt(process.env.PORT || '8787', 10);
let SYMBOLS = (process.env.SYMBOLS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
let UNIVERSE = [];
const LEVERAGE = Math.min(10, Math.max(1, parseInt(process.env.LEVERAGE || '5', 10)));
const INITIAL = parseFloat(process.env.INITIAL_USDT || '10000');

async function main() {
  console.log('=== 纸面交易模拟启动 ===');
  console.log(`时间: ${fmtTs(Date.now())}`);
  if (!SYMBOLS.length) {
    try {
      UNIVERSE = await selectEquityUniverse();
      SYMBOLS = UNIVERSE.map((u) => u.symbol);
    } catch (e) {
      console.warn('[选品] REST 失败，使用默认股票型合约:', e.message);
    }
    if (!SYMBOLS.length) {
      SYMBOLS = (process.env.FALLBACK_SYMBOLS || 'SOXLUSDT,SNDKUSDT,SKHYNIXUSDT,MUUSDT,SPCXUSDT,DRAMUSDT')
        .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      console.warn(`[选品] 回退固定品种: ${SYMBOLS.join(',')}`);
    }
  }
  console.log(`品种: ${SYMBOLS.join(', ')} | 杠杆: ${LEVERAGE}x | 本金: ${INITIAL} USDT | 不计手续费`);
  console.log('声明: 纸面模拟，非真实盈亏。高杠杆有强平风险（模拟）。');
  console.log(`WeCom: ${process.env.WECOM_WEBHOOK_URL ? '已从环境变量启用（≥45min/条摘要）' : '未设置 WECOM_WEBHOOK_URL，跳过推送'}`);

  const engine = new PaperEngine(DIR, { initialCapital: INITIAL, leverage: LEVERAGE, symbols: SYMBOLS });

  engine.meta.universe = UNIVERSE.map((u) => ({ symbol: u.symbol, type: u.underlyingType, quoteVolume: u.quoteVolume, spreadPct: u.spreadPct, bid02: u.bid02, ask02: u.ask02 }));
  for (const u of UNIVERSE) engine.setDepth(u.symbol, { bid02: u.bid02, ask02: u.ask02, spreadPct: u.spreadPct, ts: Date.now() });
  for (const sym of SYMBOLS) {
    const u = UNIVERSE.find((x) => x.symbol === sym);
    if (u) { engine.setTick(sym, u.tickSize); continue; }
    try {
      const info = await fetchExchangeInfo(sym);
      engine.setTick(sym, info.tickSize);
      console.log(`[meta] ${sym} tickSize=${info.tickSize}`);
    } catch (e) {
      console.warn(`[meta] ${sym} exchangeInfo 失败，用默认 tick:`, e.message);
      engine.setTick(sym, 0.01);
    }
  }

  let lastPrices = {};
  const feed = new MultiFeed(SYMBOLS, (ev) => {
    if (ev.price != null) lastPrices[ev.symbol] = ev.price;
    if (ev.type === 'trade' || ev.type === 'mark') {
      if (ev.price != null) engine.onPrice(ev.symbol, ev.price);
      else if (ev.mark != null) engine.onPrice(ev.symbol, ev.mark);
    }
    if (ev.type === 'kline' && ev.closed) {
      const candles = feed.klines[ev.symbol] || [];
      const sig = signal(candles);
      engine.onPrice(ev.symbol, ev.price);
      const opened = engine.onClosedBar(ev.symbol, candles, ev.price, sig);
      if (!opened && sig.side) {
        // 信号被冷却/仓位限制挡住时打 debug
        // console.log(`[信号忽略] ${ev.symbol} ${sig.side} ${sig.reason}`);
      }
      // 反向信号：若持有反方向仓，可提前平
      const pos = engine.positions.find((p) => p.symbol === ev.symbol);
      if (pos && sig.side && sig.side !== pos.side && Date.now() - pos.openedAt > 30000) {
        engine.onPrice(ev.symbol, ev.price); // 先正常检查
        // 强制按反向信号平仓
        const still = engine.positions.find((p) => p.id === pos.id);
        if (still) {
          still.openedAt = still.openedAt; // noop keep
          // 直接关
          engine._close(still, ev.price, `反向信号:${sig.reason}`);
        }
      }
    }
  });

  await feed.bootstrap();
  lastPrices = { ...feed.prices };
  engine.markEquity(lastPrices);
  engine.recordEquity(lastPrices);
  console.log(`[bootstrap] 价格 ${JSON.stringify(lastPrices)} 权益=${engine.equity.toFixed(2)}`);

  // 启动后若有足够 K 线，立即评估一次（用最新已收盘）
  for (const sym of SYMBOLS) {
    const candles = feed.klines[sym] || [];
    const closed = candles.filter((c) => c.closed !== false);
    if (closed.length >= 25) {
      // 标记最后一根为已处理，避免重复；但仍允许下一根信号
      const sig = signal(closed);
      console.log(`[指标] ${sym} RSI=${sig.rsi != null ? sig.rsi.toFixed(1) : '—'} EMA9=${sig.emaFast?.toFixed?.(2)} EMA21=${sig.emaSlow?.toFixed?.(2)} ATR5m=${sig.atr != null ? (sig.atr / closed[closed.length - 1].c * 100).toFixed(3) + '%' : '—'} 信号=${sig.side || '无'} (${sig.reason})`);
    }
  }

  feed.start();

  const wecom = new WeComSummary(undefined, path.join(DIR, 'wecom_state.json'));
  const server = createServer(() => engine.snapshot(lastPrices));
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP] 状态页 http://0.0.0.0:${PORT}/  API /api/status`);
  });

  // 权益采样 + 可选 WeCom 摘要
  setInterval(() => {
    engine.recordEquity(lastPrices);
    const st = engine.stats();
    console.log(`[权益] ${engine.equity.toFixed(2)} USDT | 持仓=${st.openN} 已平=${st.trades} 胜率=${(st.winRate * 100).toFixed(1)}% 收益=${st.retPct.toFixed(2)}%`);
  }, 15000);

  const buildSummary = () => {
    const snap = engine.snapshot(lastPrices);
    const st = snap.stats;
    return [
      '【纸面交易摘要·非真实盈亏】',
      `时间 ${snap.updatedAtCn}`,
      `股票型合约 ${SYMBOLS.join('/')}`,
      `权益 ${snap.equity.toFixed(2)} / 本金 ${snap.initial} (${st.retPct.toFixed(2)}%)`,
      `持仓 ${st.openN} | 已平 ${st.trades} | 胜率 ${(st.winRate * 100).toFixed(1)}%`,
      `已实现盈亏 ${st.sumPnl.toFixed(2)} USDT`,
      '不计手续费；高杠杆高波动，模拟结果不可外推实盘。',
    ].join('\n');
  };
  const tryWecom = async (force = false) => {
    const r = await wecom.maybeSend(buildSummary(), { force });
    if (r.ok) console.log('[WeCom] 摘要已发送');
    else if (r.skipped) console.log(`[WeCom] 跳过 ${r.reason}${r.waitMs ? ` 还需${Math.ceil(r.waitMs/60000)}分钟` : ''}`);
    else console.warn('[WeCom]', r.error || JSON.stringify(r.r));
  };
  // 本次启动立即补发一条（你问了没看到消息）；之后仍 ≥45 分钟一条
  setTimeout(() => tryWecom(true), 3000);
  setInterval(() => tryWecom(false), 60 * 1000);

  // 盘口深度每 5 分钟刷新（用于仓位上限：名义 ≤ 15% × ±0.2% 较薄一侧深度）
  setInterval(async () => {
    for (const sym of SYMBOLS) {
      try { engine.setDepth(sym, await depthStats(sym)); } catch (_) {}
    }
  }, 5 * 60 * 1000);

  // 每 20s 复核：① EMA 交叉信号（定时复核）；② 明确的均线趋势动量（阈值远高于噪声）。
  // 过滤：最近 3 根 1m 无波动 / 无成交（底层休市冷清）则不开仓。
  setInterval(() => {
    for (const sym of SYMBOLS) {
      const candles = feed.klines[sym] || [];
      if (candles.length < 60) continue;
      const px = lastPrices[sym];
      if (px == null) continue;
      engine.onPrice(sym, px);
      if (engine.positions.some((p) => p.symbol === sym)) continue;
      if (engine.positions.length >= 4) continue;
      const recent = candles.slice(-4, -1);
      if (recent.every((c) => c.h === c.l || c.v === 0)) continue;
      const sig = signal(candles);
      if (sig.side) {
        engine.tryOpen(sym, sig.side, px, sig.atr, sig.reason + ' (定时复核)');
        continue;
      }
      if (sig.emaFast == null || sig.emaSlow == null || sig.rsi == null || !sig.atr) continue;
      const skew = (sig.emaFast - sig.emaSlow) / px;
      const dist = (px - sig.emaFast) / px;
      const atrPct = sig.atr / px;
      // 动量：EMA9-EMA21 间距 ≥ max(0.08%, 0.3×ATR5m)，价在快线同侧，RSI 未极端
      const th = Math.max(0.0008, 0.3 * atrPct);
      if (skew > th && dist > 0 && sig.rsi >= 52 && sig.rsi <= 72) {
        engine.tryOpen(sym, 'long', px, sig.atr, `趋势动量多 skew=${(skew * 100).toFixed(3)}% RSI=${sig.rsi.toFixed(1)}`);
      } else if (skew < -th && dist < 0 && sig.rsi <= 48 && sig.rsi >= 28) {
        engine.tryOpen(sym, 'short', px, sig.atr, `趋势动量空 skew=${(skew * 100).toFixed(3)}% RSI=${sig.rsi.toFixed(1)}`);
      }
    }
  }, 20000);

  process.on('SIGINT', () => shutdown(feed, engine, lastPrices));
  process.on('SIGTERM', () => shutdown(feed, engine, lastPrices));
}

function shutdown(feed, engine, prices) {
  console.log('[退出] 保存状态…');
  try { feed.stop(); } catch (_) {}
  try { engine.recordEquity(prices); } catch (_) {}
  process.exit(0);
}

async function bootWithRetry() {
  let delay = 5000;
  for (;;) {
    try {
      await main();
      return;
    } catch (e) {
      console.error('启动失败，将重试:', e && e.message ? e.message : e);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 120000);
    }
  }
}
bootWithRetry();
