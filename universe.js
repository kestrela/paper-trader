/**
 * 股票型合约（币安 U 本位 TRADIFI_PERPETUAL）选品：只看股票类 underlyingType，
 * 按 24h 成交额 + 盘口点差/深度筛选流动性最好的若干个。纯公共行情，无 API Key。
 */
'use strict';

const { fapiGet } = require('./binance');

// 股票类底层（排除 COMMODITY / FX / PREMARKET(Pre-IPO) / INDEX）
const EQUITY_TYPES = new Set(['EQUITY', 'KR_EQUITY', 'HK_EQUITY', 'CN_EQUITY']);
// 宽基指数 ETF / 波动率产品：可区分时排除（"排除指数"）
const INDEX_ETF_EXCLUDE = new Set((process.env.UNIVERSE_EXCLUDE ||
  'QQQUSDT,SPYUSDT,IWMUSDT,TQQQUSDT,SQQQUSDT,TZAUSDT,EWYUSDT,EWJUSDT,EWTUSDT,EWZUSDT,KODEX200USDT,UVXYUSDT,KORUUSDT,SOXSUSDT,SKHYUSDT')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
// 注：KORU=3x 韩国宽基 ETF（且点差≈0.1% 受 tick 限制）；SOXS=SOXL 反向（同向重复敞口）；SKHY 与 SKHYNIX 底层相同，保留成交额更大的 SKHYNIX。

const MIN_QV = parseFloat(process.env.MIN_QUOTE_VOL || '20000000');   // 24h 成交额 ≥ $20M
const MAX_SPREAD_PCT = parseFloat(process.env.MAX_SPREAD_PCT || '0.1'); // 点差 ≤ 0.1%
const MIN_DEPTH_USD = parseFloat(process.env.MIN_DEPTH_USD || '150000'); // ±0.2% 较薄一侧 ≥ $150k
const MAX_SYMBOLS = parseInt(process.env.MAX_SYMBOLS || '6', 10);

async function depthStats(symbol) {
  const d = await fapiGet(`/fapi/v1/depth?symbol=${symbol}&limit=500`);
  const bb = +d.bids[0][0], ba = +d.asks[0][0];
  const mid = (bb + ba) / 2;
  const sum = (arr, ok) => arr.filter((x) => ok(+x[0])).reduce((a, x) => a + x[0] * x[1], 0);
  return {
    mid,
    spreadPct: (ba - bb) / mid * 100,
    bid02: sum(d.bids, (p) => p >= mid * 0.998),
    ask02: sum(d.asks, (p) => p <= mid * 1.002),
    ts: Date.now(),
  };
}

async function selectEquityUniverse(log = console.log) {
  const [ei, t24] = await Promise.all([fapiGet('/fapi/v1/exchangeInfo'), fapiGet('/fapi/v1/ticker/24hr')]);
  const vol = new Map(t24.map((x) => [x.symbol, x]));
  const all = (ei.symbols || []).filter((s) => s.contractType === 'TRADIFI_PERPETUAL' && s.status === 'TRADING');
  const typeCount = {};
  all.forEach((s) => { typeCount[s.underlyingType] = (typeCount[s.underlyingType] || 0) + 1; });
  const eq = all.filter((s) => EQUITY_TYPES.has(s.underlyingType) && s.quoteAsset === 'USDT' && !INDEX_ETF_EXCLUDE.has(s.symbol))
    .map((s) => ({
      symbol: s.symbol,
      underlyingType: s.underlyingType,
      quoteVolume: +(vol.get(s.symbol)?.quoteVolume || 0),
      tickSize: +((s.filters || []).find((f) => f.filterType === 'PRICE_FILTER')?.tickSize || 0.01),
    }))
    .sort((a, b) => b.quoteVolume - a.quoteVolume);
  log(`[选品] TRADIFI_PERPETUAL 交易中 ${all.length} 个，按底层: ${JSON.stringify(typeCount)}；股票类候选 ${eq.length} 个`);
  const picked = [], rejected = [];
  for (const c of eq) {
    if (picked.length >= MAX_SYMBOLS) break;
    if (c.quoteVolume < MIN_QV) break;
    let d;
    try { d = await depthStats(c.symbol); } catch (e) { rejected.push(`${c.symbol}(depth失败)`); continue; }
    const thin = Math.min(d.bid02, d.ask02);
    const row = { ...c, spreadPct: d.spreadPct, bid02: d.bid02, ask02: d.ask02, depth02: thin };
    if (d.spreadPct > MAX_SPREAD_PCT) { rejected.push(`${c.symbol}(点差${d.spreadPct.toFixed(3)}%)`); continue; }
    if (thin < MIN_DEPTH_USD) { rejected.push(`${c.symbol}(深度$${thin.toFixed(0)})`); continue; }
    picked.push(row);
  }
  log(`[选品] 规则: 24h成交额≥$${(MIN_QV / 1e6).toFixed(0)}M, 点差≤${MAX_SPREAD_PCT}%, ±0.2%深度≥$${(MIN_DEPTH_USD / 1e3).toFixed(0)}k, 取前${MAX_SYMBOLS}; 排除: ${[...INDEX_ETF_EXCLUDE].join(',')}`);
  if (rejected.length) log(`[选品] 流动性不达标: ${rejected.join(', ')}`);
  for (const p of picked) {
    log(`[选品] ${p.symbol} ${p.underlyingType} 24h=$${(p.quoteVolume / 1e6).toFixed(1)}M 点差=${p.spreadPct.toFixed(4)}% ±0.2%深度 买$${(p.bid02 / 1e3).toFixed(0)}k/卖$${(p.ask02 / 1e3).toFixed(0)}k tick=${p.tickSize}`);
  }
  return picked;
}

module.exports = { selectEquityUniverse, depthStats, EQUITY_TYPES, INDEX_ETF_EXCLUDE };
