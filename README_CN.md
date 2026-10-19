# 纸面交易模拟（Paper Trader）· 股票型合约

**声明：本程序只做纸面模拟，不下真实订单，不使用 API Key，不产生真实盈亏。不计手续费。**

## 交易品种：币安 U 本位「股票型合约」

- 只交易 exchangeInfo 中 `contractType = TRADIFI_PERPETUAL` 且 `underlyingType ∈ {EQUITY, KR_EQUITY, HK_EQUITY, CN_EQUITY}` 的合约。
- 排除：`COMMODITY`（黄金/白银/原油/天然气/铜等）、`FX`（USDBRL）、`PREMARKET`（Pre-IPO，如 OPENAI/ANTHROPIC）；
  以及可区分的宽基指数/波动率 ETF（QQQ、SPY、IWM、TQQQ、SQQQ、TZA、EWY/EWJ/EWT/EWZ、KODEX200、UVXY、KORU）。
  另排除 SOXS（SOXL 反向，重复敞口）、SKHY（与 SKHYNIX 同底层）。可用 `UNIVERSE_EXCLUDE` 覆盖。
- 启动时自动选品（流动性优先）：24h 成交额 ≥ $20M → 盘口（depth limit=500）点差 ≤ 0.1% 且 ±0.2% 内较薄一侧深度 ≥ $150k → 按成交额取前 6。
- 不再交易 BTCUSDT / ETHUSDT。`koruusdt-monitor`（:8765）为独立服务，本进程不占用、不停止。
- 股票型合约 7×24 交易，但底层股市休市（周末/夜间）时波动低、开盘可能跳空。最近 3 根 1m 无波动/无量时不开仓。

## 策略规则（中文摘要）

- **信号**：1m EMA9 上穿/下穿 EMA21；RSI(14) 过滤（多 <70，空 >30）；每 20s 复核
- **趋势动量**：EMA9−EMA21 间距 ≥ max(0.08%, 0.3×ATR5m) 且价在快线同侧、RSI 多 52–72 / 空 28–48（已取消旧版噪声级均值回归单）
- **方向**：多空均可；同品种同时仅 1 仓；反向交叉信号可提前平仓；同品种同向冷却 3 分钟
- **杠杆**：默认 **5x**（硬上限 10x）；强平价为简化模型，**有爆仓风险**
- **仓位**：单笔保证金约权益 12%；最多 4 仓；名义 ≤ ±0.2% 盘口深度（较薄一侧）的 15%（每 5 分钟刷新深度）
- **止盈 / 止损**：5m ATR(14) × 2.2 / × 1.5，下限 **止盈 ≥ 0.40%、止损 ≥ 0.25%**，且止盈 ≥ 1.5 × 止损；最长持仓 90 分钟
- **费用**：**不计手续费**（`FEE_RATE` 默认 0）、**无滑点**（`SLIP_TICKS` 默认 0）；忽略资金费
- **企业微信**：仅在设置 `WECOM_WEBHOOK_URL` 时，纯文本摘要，间隔 ≥ 45 分钟；启动不发消息

## 运行

```bash
cd /workspace/paper-trader
nohup env WECOM_WEBHOOK_URL="${WECOM_WEBHOOK_URL:-}" node app.js >> run.log 2>&1 &
echo $! > run.pid
```

- 状态页：`http://<host>:8787/`；JSON：`/api/status`
- 持久化：`state.json`、`trades.jsonl`、`equity.csv`；旧账户归档在 `archive_<时间戳>/`

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| PORT | 8787 | HTTP 端口 |
| SYMBOLS | （空=自动选品） | 手动指定逗号分隔品种 |
| MAX_SYMBOLS | 6 | 自动选品数量 |
| MIN_QUOTE_VOL / MAX_SPREAD_PCT / MIN_DEPTH_USD | 2e7 / 0.1 / 150000 | 流动性门槛 |
| LEVERAGE | 5 | 1–10 |
| FEE_RATE | 0 | 手续费率（默认不计） |
| SLIP_TICKS | 0 | 每次成交滑点 tick 数 |
| SL_MIN_PCT / TP_MIN_PCT | 0.0025 / 0.004 | 止损/止盈下限 |
| DEPTH_FRAC | 0.15 | 名义上限占 ±0.2% 深度比例 |
| INITIAL_USDT | 10000 | 初始权益 |
| FAPI_BASE | fapi + www.binance.com | REST 回退（fapi 451 时用 www.binance.com/fapi） |
| WECOM_WEBHOOK_URL | （空） | 若设置则 ≥45min 一条纯文本摘要 |

## 风险说明

杠杆会放大亏损并可能触发**模拟强平**。不计手续费会高估短线策略表现。纸面胜率/收益**不可外推实盘**。
