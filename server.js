/**
 * 中文状态页 + JSON API，监听 8787。
 */
'use strict';

const http = require('http');

function htmlPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>纸面交易 · Paper Trader</title>
<style>
  :root { --bg:#0b1220; --card:#141c2e; --fg:#e8eefc; --muted:#8b9bb8; --up:#3dd68c; --dn:#f07178; --acc:#5b9dff; }
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Noto Sans SC",sans-serif;background:var(--bg);color:var(--fg)}
  header{padding:20px 24px;border-bottom:1px solid #1e2a44;display:flex;flex-wrap:wrap;gap:12px;align-items:baseline}
  header h1{margin:0;font-size:1.25rem}
  .badge{font-size:.75rem;padding:2px 8px;border-radius:999px;background:#2a1f0a;color:#f0c674}
  main{padding:16px 24px;max-width:1100px;margin:0 auto}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid #1e2a44;border-radius:12px;padding:14px 16px}
  .card .lab{color:var(--muted);font-size:.75rem}
  .card .val{font-size:1.35rem;font-weight:600;margin-top:4px}
  .up{color:var(--up)}.dn{color:var(--dn)}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #1e2a44}
  th{color:var(--muted);font-weight:500}
  .warn{background:#1a1208;border:1px solid #5a3a10;color:#f0c674;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:.85rem}
  .muted{color:var(--muted);font-size:.8rem}
  h2{font-size:1rem;margin:20px 0 10px}
</style>
</head>
<body>
<header>
  <h1>纸面交易模拟</h1>
  <span class="badge">非真实资金 · 仅模拟</span><span class="badge">股票型合约 · 不计手续费</span>
  <span class="muted" id="updated">—</span>
</header>
<main>
  <div class="warn" id="disclaimer">加载中…</div>
  <div class="grid" id="kpis"></div>
  <h2>交易品种（币安 U 本位股票型合约 TRADIFI_PERPETUAL，按流动性选取）</h2>
  <div class="card" style="overflow:auto"><table id="uni"><thead><tr>
    <th>品种</th><th>底层类型</th><th>24h 成交额</th><th>点差</th><th>±0.2% 深度 买/卖</th><th>最新价</th>
  </tr></thead><tbody></tbody></table></div>
  <h2>当前持仓</h2>
  <div class="card" style="overflow:auto"><table id="pos"><thead><tr>
    <th>品种</th><th>方向</th><th>杠杆</th><th>入场</th><th>标记</th><th>未实现</th><th>止盈/止损</th><th>强平≈</th><th>开仓时间</th>
  </tr></thead><tbody></tbody></table></div>
  <h2>最近成交</h2>
  <div class="card" style="overflow:auto"><table id="trades"><thead><tr>
    <th>时间</th><th>品种</th><th>方向</th><th>入场→出场</th><th>盈亏(USDT)</th><th>原因</th>
  </tr></thead><tbody></tbody></table></div>
  <h2 class="muted">策略摘要</h2>
  <pre class="card muted" id="strategy" style="white-space:pre-wrap;font-size:.8rem"></pre>
</main>
<script>
const fmt = (n,d=2)=> n==null||Number.isNaN(n)?'—':Number(n).toFixed(d);
const pct = (n)=> n==null?'—':(n>=0?'+':'')+Number(n).toFixed(2)+'%';
async function refresh(){
  try{
    const r = await fetch('/api/status');
    const j = await r.json();
    document.getElementById('disclaimer').textContent = j.disclaimer || '';
    document.getElementById('updated').textContent = '更新：'+(j.updatedAtCn||'');
    const s = j.stats||{};
    const ret = j.retPct||0;
    document.getElementById('kpis').innerHTML = [
      ['权益 (USDT)', fmt(j.equity,2), ret>=0?'up':'dn'],
      ['初始本金', fmt(j.initial,2), ''],
      ['收益率', pct(ret), ret>=0?'up':'dn'],
      ['可用保证金', fmt(j.cash,2), ''],
      ['持仓数', String(s.openN||0), ''],
      ['已平仓笔数', String(s.trades||0), ''],
      ['胜率', ((s.winRate||0)*100).toFixed(1)+'%', ''],
      ['已实现盈亏', fmt(s.sumPnl,2), (s.sumPnl||0)>=0?'up':'dn'],
    ].map(([lab,val,cls])=>'<div class="card"><div class="lab">'+lab+'</div><div class="val '+cls+'">'+val+'</div></div>').join('');
    const pb = document.querySelector('#pos tbody');
    const pos = j.positions||[];
    pb.innerHTML = pos.length? pos.map(p=>'<tr>'+
      '<td>'+p.symbol+'</td><td>'+(p.side==='long'?'多':'空')+'</td><td>'+p.leverage+'x</td>'+
      '<td>'+fmt(p.entry,2)+'</td><td>'+fmt(p.mark,2)+'</td>'+
      '<td class="'+(p.uPnl>=0?'up':'dn')+'">'+fmt(p.uPnl,2)+'</td>'+
      '<td>'+fmt(p.tp)+' / '+fmt(p.sl)+'</td><td>'+fmt(p.liq)+'</td><td>'+(p.openedAtCn||'')+'</td></tr>').join('')
      : '<tr><td colspan="9" class="muted">暂无持仓</td></tr>';
    const tb = document.querySelector('#trades tbody');
    const tr = j.recentTrades||[];
    tb.innerHTML = tr.length? tr.map(t=>'<tr>'+
      '<td>'+(t.closedAtCn||'')+'</td><td>'+t.symbol+'</td><td>'+(t.side==='long'?'多':'空')+'</td>'+
      '<td>'+fmt(t.entry)+' → '+fmt(t.exit)+'</td>'+
      '<td class="'+(t.pnl>=0?'up':'dn')+'">'+fmt(t.pnl,2)+'</td>'+
      '<td>'+(t.reasonClose||'')+'</td></tr>').join('')
      : '<tr><td colspan="6" class="muted">暂无成交</td></tr>';
    const m = j.meta||{};
    const ub = document.querySelector('#uni tbody');
    const uni = m.universe||[];
    ub.innerHTML = uni.length? uni.map(u=>'<tr><td>'+u.symbol+'</td><td>'+u.type+'</td><td>$'+fmt(u.quoteVolume/1e6,1)+'M</td><td>'+fmt(u.spreadPct,4)+'%</td><td>$'+fmt(u.bid02/1e3,0)+'k / $'+fmt(u.ask02/1e3,0)+'k</td><td>'+fmt((j.prices||{})[u.symbol],2)+'</td></tr>').join('')
      : '<tr><td colspan="6" class="muted">（手动 SYMBOLS 模式）</td></tr>';
    document.getElementById('strategy').textContent =
      '品种: '+(m.symbols||[]).join(', ')+'\n'+
      '杠杆: '+m.leverage+'x（上限 10x）\n'+
      '信号: 1m EMA9/21 交叉 + RSI14 过滤；20s 复核 + 明确趋势动量（EMA 间距 ≥ max(0.08%, 0.3×ATR)）\n'+
      '止盈/止损: 5m ATR14 × 2.2 / × 1.5，下限 止盈 ≥0.40%、止损 ≥0.25%，且止盈 ≥1.5×止损；最长持仓 90 分钟\n'+
      '费用: 不计手续费（费率 '+((m.feeRate||0)*100)+'%），无滑点（'+(m.slipTicks||0)+' tick）；忽略资金费\n'+
      '单笔保证金约权益 12%（名义 ≤ ±0.2% 盘口深度的 15%），同品种单仓，最多 4 仓，多空均可\n'+
      '注意: 股票型合约 7×24 交易，但底层美/韩股休市时（周末/夜间）波动低、价格可能在开盘时跳空\n'+
      '启动: '+(m.startedAt? new Date(m.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+' (UTC+8)':'—');
  }catch(e){
    document.getElementById('disclaimer').textContent = '状态拉取失败: '+e.message;
  }
}
refresh(); setInterval(refresh, 3000);
</script>
</body>
</html>`;
}

function createServer(getStatus) {
  return http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/status' || url === '/status.json') {
      const body = JSON.stringify(getStatus());
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
      return;
    }
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage());
      return;
    }
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404); res.end('not found');
  });
}

module.exports = { createServer };
