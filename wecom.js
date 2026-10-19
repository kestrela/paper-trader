/**
 * 可选企业微信：仅当环境变量 WECOM_WEBHOOK_URL 已设置时启用。
 * 不硬编码 webhook。默认至少间隔 45 分钟发一条纸面摘要。
 */
'use strict';

const https = require('https');
const fs = require('fs');

const URL_ENV = process.env.WECOM_WEBHOOK_URL || '';
// WECOM_PAPER_INTERVAL_S 单位：秒；硬下限 45 分钟
const MIN_GAP_MS = Math.max(45 * 60, Number(process.env.WECOM_PAPER_INTERVAL_S || 45 * 60) || 45 * 60) * 1000;

function postJson(urlStr, obj, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(txt)); } catch (_) { resolve({ errcode: -1, errmsg: txt.slice(0, 200) }); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

class WeComSummary {
  constructor(url = URL_ENV, stateFile = null) {
    this.url = url;
    this.enabled = /^https:\/\/qyapi\.weixin\.qq\.com\//.test(url);
    this.stateFile = stateFile;
    let prev = 0;
    try { if (stateFile && fs.existsSync(stateFile)) prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastSent || 0; } catch (_) {}
    this.startedAt = Date.now();
    // 首条：启动后满间隔才发；跨重启若上次已发则从上次算
    this.lastSent = prev > 0 ? prev : (this.startedAt - MIN_GAP_MS);
  }

  async maybeSend(text, { force = false } = {}) {
    if (!this.enabled) return { skipped: true, reason: 'disabled' };
    const now = Date.now();
    const wait = MIN_GAP_MS - (now - this.lastSent);
    if (!force && wait > 0) return { skipped: true, reason: 'rate_limit', waitMs: wait };
    try {
      let content = String(text);
      while (Buffer.byteLength(content, 'utf8') > 2000) content = content.slice(0, -40);
      const r = await postJson(this.url, { msgtype: 'text', text: { content } });
      if (r && r.errcode === 0) {
        this.lastSent = now;
        try { if (this.stateFile) fs.writeFileSync(this.stateFile, JSON.stringify({ lastSent: now })); } catch (_) {}
        return { ok: true };
      }
      return { ok: false, r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = { WeComSummary };
