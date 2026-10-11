// Screenshots of the monitor UI on the demo project (tests/tools/demo.py), via headless Chrome and the DevTools protocol.
// Needs Node 22+ (global WebSocket) and Chrome/Edge. No npm packages.
//   node tests/tools/screenshots.mjs http://127.0.0.1:8860 OUTDIR [chrome-path]
// The last shot stops the viewer process (found through /api/health) to show the offline state: start it again afterwards.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [base, outDir, chromeArg] = process.argv.slice(2);
if (!base || !outDir) { console.error('usage: node screenshots.mjs BASE_URL OUTDIR [chrome]'); process.exit(2); }
const chrome = chromeArg || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9340 + Math.floor(Math.random() * 50);

const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'shots-'))}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let info;
for (let i = 0; i < 60 && !info; i++) {
  try { info = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await sleep(250); }
}
if (!info) { proc.kill(); throw new Error('Chrome did not start'); }
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; };
await send('Page.enable'); await send('Runtime.enable');

async function view(w, h, scheme, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
}
async function open(hash = '') {
  await send('Page.navigate', { url: 'about:blank' }); await sleep(100);
  await send('Page.navigate', { url: base + '/' + hash });
  await sleep(2600);
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(outDir, name), Buffer.from(r.data, 'base64')); console.log('wrote', name);
}
const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const sessions = await (await fetch(base + '/api/sessions')).json();
const sid = (letter) => sessions.find((s) => s.label.endsWith(' ' + letter)).id;

// storage is per origin: clear it before every scenario so saved preferences do not leak between shots
const fresh = async () => { await send('Page.navigate', { url: base + '/' }); await sleep(300); await ev('localStorage.clear()'); };

await view(1440, 1000, 'dark'); await fresh();
await open('#sid=' + sid('F')); await shot('01-overview-dark.png');
await view(1440, 1000, 'light'); await fresh(); await open('#sid=' + sid('F')); await shot('02-overview-light.png');

await view(1440, 1000, 'dark'); await fresh(); await open('#sid=' + sid('B'));
await click('#next-error'); await sleep(500); await shot('03-failed-session-errors.png');
await ev("document.querySelector('#search-input').value='Checkout'; document.querySelector('#search-input').dispatchEvent(new Event('input',{bubbles:true}))");
await sleep(600); await click('#search-whole'); await sleep(1500); await shot('04-search-whole-transcript.png');

await fresh(); await open('#sid=' + sid('E')); await shot('05-partial-view-banner.png');
await fresh(); await open('#sid=' + sid('F')); await click('#health-details-btn'); await sleep(600); await shot('06-health-details.png');
await fresh(); await open('#sid=' + sid('F'));
await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true}))"); await sleep(500); await shot('07-keyboard-shortcuts.png');
await fresh(); await open('#sid=' + sid('A')); await click('#density-toggle'); await sleep(500); await shot('08-compact-density-completed-session.png');

await view(390, 844, 'dark', true); await fresh(); await open(''); await shot('09-mobile-sessions.png');
await open('#sid=' + sid('B')); await ev("document.querySelector('#main').scrollIntoView()"); await sleep(500); await shot('10-mobile-timeline.png');

// offline state: stop the viewer, wait past stale_after_ms, capture
await view(1440, 1000, 'dark'); await fresh(); await open('#sid=' + sid('F'));
const pid = (await (await fetch(base + '/api/health')).json()).pid;
process.kill(pid); await sleep(19000); await shot('11-offline-stale.png');

ws.close(); proc.kill();
