// "Screen patches": lets the app pick up a new version of the screen (renderer/index.html)
// without reinstalling the whole app. No Electron dependency, so it can be tested alone.
//
// How it works
//   * index.html carries two <meta> tags:
//       <meta name="ui-version" content="1.0.3">        version of the screen itself
//       <meta name="min-app-version" content="1.0.0">   oldest app that can run this screen
//   * The app fetches the latest renderer/index.html from the project's GitHub repository.
//     If its ui-version is newer than what is running, and this app is new enough, it is saved
//     in the user-data folder and loaded on the next start (or right away if the person agrees).
//   * A patched screen is only trusted once it has started properly: the page reports "ready"
//     after it has loaded. If it fails to load, crashes, or never reports ready, the app goes
//     back to the screen built into the installed app and skips that patch version.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ATTEMPTS = 3; // start attempts without a "ready" report before a patch is given up on

function parseVersion(v) {
  return String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
}
function compareVersions(a, b) {
  const A = parseVersion(a), B = parseVersion(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function readMeta(html, name) {
  const m = String(html).match(new RegExp('<meta\s+name="' + name + '"\s+content="([^"]*)"', 'i'));
  return m ? m[1] : null;
}

const VERSION_RE = /^d+(.d+){0,3}$/;

// Refuses anything that doesn't look like a complete copy of this app's screen.
function validateHtml(html) {
  if (typeof html !== 'string' || html.length < 2000 || html.length > MAX_BYTES) return { ok: false, reason: 'size' };
  if (!/</html>s*$/i.test(html.trim())) return { ok: false, reason: 'incomplete' };
  const ui = readMeta(html, 'ui-version');
  if (!ui || !VERSION_RE.test(ui)) return { ok: false, reason: 'no-ui-version' };
  const min = readMeta(html, 'min-app-version') || '0.0.0';
  if (!VERSION_RE.test(min)) return { ok: false, reason: 'bad-min-version' };
  if (!html.includes('desktopAPI')) return { ok: false, reason: 'not-app-page' };
  return { ok: true, uiVersion: ui, minAppVersion: min };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// dir: where patches are kept. bundledIndex: the screen built into the installed app.
function createPatcher({ dir, bundledIndex, appVersion }) {
  const htmlFile = path.join(dir, 'index.html');
  const metaFile = path.join(dir, 'meta.json');
  const badFile = path.join(dir, 'bad-versions.json');

  const readJson = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
  };
  const writeJson = (file, obj) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  };

  function bundledUiVersion() {
    try { return readMeta(fs.readFileSync(bundledIndex, 'utf8'), 'ui-version') || '0.0.0'; } catch (e) { return '0.0.0'; }
  }

  function markBad(uiVersion) {
    const bad = readJson(badFile, []);
    if (uiVersion && !bad.includes(uiVersion)) { bad.push(uiVersion); writeJson(badFile, bad); }
  }

  // Which screen to load right now: a saved patch if it is usable, otherwise the built-in one.
  function choose() {
    const bundled = { path: bundledIndex, uiVersion: bundledUiVersion(), source: 'bundled' };
    const meta = readJson(metaFile, null);
    if (!meta || !fs.existsSync(htmlFile)) return bundled;
    if (readJson(badFile, []).includes(meta.uiVersion)) return bundled;
    if (compareVersions(meta.uiVersion, bundled.uiVersion) <= 0) return bundled;   // installed app already has it (or newer)
    if (compareVersions(appVersion, meta.minAppVersion) < 0) return bundled;        // this app is too old for it
    if (meta.status !== 'ok' && (meta.attempts || 0) >= MAX_ATTEMPTS) {             // never managed to start properly
      markBad(meta.uiVersion);
      return bundled;
    }
    return { path: htmlFile, uiVersion: meta.uiVersion, source: 'patch' };
  }

  // Call each time a saved patch is about to be loaded.
  function beginLoad(choice) {
    if (!choice || choice.source !== 'patch') return;
    const meta = readJson(metaFile, {});
    meta.attempts = (meta.attempts || 0) + 1;
    writeJson(metaFile, meta);
  }

  // The loaded patch reported that it started properly.
  function ack() {
    const meta = readJson(metaFile, null);
    if (meta) { meta.status = 'ok'; meta.attempts = 0; writeJson(metaFile, meta); }
  }

  // The loaded patch failed: never use this version again.
  function rejectCurrent() {
    const meta = readJson(metaFile, null);
    if (meta) markBad(meta.uiVersion);
  }

  // fetchText(): resolves with the latest published index.html (or rejects when offline).
  async function check(fetchText) {
    let html;
    try { html = await fetchText(); } catch (e) { return { state: 'offline' }; }
    const v = validateHtml(html);
    if (!v.ok) return { state: 'invalid', reason: v.reason };
    const current = choose();
    if (compareVersions(v.uiVersion, current.uiVersion) <= 0) return { state: 'up-to-date', version: current.uiVersion };
    if (readJson(badFile, []).includes(v.uiVersion)) return { state: 'rejected', version: v.uiVersion };
    if (compareVersions(appVersion, v.minAppVersion) < 0) {
      return { state: 'needs-app-update', version: v.uiVersion, minAppVersion: v.minAppVersion };
    }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = htmlFile + '.tmp';
    fs.writeFileSync(tmp, html, 'utf8');
    fs.renameSync(tmp, htmlFile);
    writeJson(metaFile, {
      uiVersion: v.uiVersion,
      minAppVersion: v.minAppVersion,
      sha256: sha256(html),
      downloadedAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0
    });
    return { state: 'downloaded', version: v.uiVersion };
  }

  return { choose, beginLoad, ack, rejectCurrent, check };
}

module.exports = { createPatcher, validateHtml, compareVersions, readMeta, MAX_ATTEMPTS };
// "Screen patches": lets the app pick up a new version of the screen (renderer/index.html)
// without reinstalling the whole app. No Electron dependency, so it can be tested alone.
//
// How it works
//   * index.html carries two <meta> tags:
//       <meta name="ui-version" content="1.0.3">        version of the screen itself
//       <meta name="min-app-version" content="1.0.0">   oldest app that can run this screen
//   * The app fetches the latest renderer/index.html from the project's GitHub repository.
//     If its ui-version is newer than what is running, and this app is new enough, it is saved
//     in the user-data folder and loaded on the next start (or right away if the person agrees).
//   * A patched screen is only trusted once it has started properly: the page reports "ready"
//     after it has loaded. If it fails to load, crashes, or never reports ready, the app goes
//     back to the screen built into the installed app and skips that patch version.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ATTEMPTS = 3; // start attempts without a "ready" report before a patch is given up on

function parseVersion(v) {
  return String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
}
function compareVersions(a, b) {
  const A = parseVersion(a), B = parseVersion(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function readMeta(html, name) {
  const m = String(html).match(new RegExp('<meta\\s+name="' + name + '"\\s+content="([^"]*)"', 'i'));
  return m ? m[1] : null;
}

const VERSION_RE = /^\d+(\.\d+){0,3}$/;

// Refuses anything that doesn't look like a complete copy of this app's screen.
function validateHtml(html) {
  if (typeof html !== 'string' || html.length < 2000 || html.length > MAX_BYTES) return { ok: false, reason: 'size' };
  if (!/<\/html>\s*$/i.test(html.trim())) return { ok: false, reason: 'incomplete' };
  const ui = readMeta(html, 'ui-version');
  if (!ui || !VERSION_RE.test(ui)) return { ok: false, reason: 'no-ui-version' };
  const min = readMeta(html, 'min-app-version') || '0.0.0';
  if (!VERSION_RE.test(min)) return { ok: false, reason: 'bad-min-version' };
  if (!html.includes('desktopAPI')) return { ok: false, reason: 'not-app-page' };
  return { ok: true, uiVersion: ui, minAppVersion: min };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// dir: where patches are kept. bundledIndex: the screen built into the installed app.
function createPatcher({ dir, bundledIndex, appVersion }) {
  const htmlFile = path.join(dir, 'index.html');
  const metaFile = path.join(dir, 'meta.json');
  const badFile = path.join(dir, 'bad-versions.json');

  const readJson = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
  };
  const writeJson = (file, obj) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  };

  function bundledUiVersion() {
    try { return readMeta(fs.readFileSync(bundledIndex, 'utf8'), 'ui-version') || '0.0.0'; } catch (e) { return '0.0.0'; }
  }

  function markBad(uiVersion) {
    const bad = readJson(badFile, []);
    if (uiVersion && !bad.includes(uiVersion)) { bad.push(uiVersion); writeJson(badFile, bad); }
  }

  // Which screen to load right now: a saved patch if it is usable, otherwise the built-in one.
  function choose() {
    const bundled = { path: bundledIndex, uiVersion: bundledUiVersion(), source: 'bundled' };
    const meta = readJson(metaFile, null);
    if (!meta || !fs.existsSync(htmlFile)) return bundled;
    if (readJson(badFile, []).includes(meta.uiVersion)) return bundled;
    if (compareVersions(meta.uiVersion, bundled.uiVersion) <= 0) return bundled;   // installed app already has it (or newer)
    if (compareVersions(appVersion, meta.minAppVersion) < 0) return bundled;        // this app is too old for it
    if (meta.status !== 'ok' && (meta.attempts || 0) >= MAX_ATTEMPTS) {             // never managed to start properly
      markBad(meta.uiVersion);
      return bundled;
    }
    return { path: htmlFile, uiVersion: meta.uiVersion, source: 'patch' };
  }

  // Call each time a saved patch is about to be loaded.
  function beginLoad(choice) {
    if (!choice || choice.source !== 'patch') return;
    const meta = readJson(metaFile, {});
    meta.attempts = (meta.attempts || 0) + 1;
    writeJson(metaFile, meta);
  }

  // The loaded patch reported that it started properly.
  function ack() {
    const meta = readJson(metaFile, null);
    if (meta) { meta.status = 'ok'; meta.attempts = 0; writeJson(metaFile, meta); }
  }

  // The loaded patch failed: never use this version again.
  function rejectCurrent() {
    const meta = readJson(metaFile, null);
    if (meta) markBad(meta.uiVersion);
  }

  // fetchText(): resolves with the latest published index.html (or rejects when offline).
  async function check(fetchText) {
    let html;
    try { html = await fetchText(); } catch (e) { return { state: 'offline' }; }
    const v = validateHtml(html);
    if (!v.ok) return { state: 'invalid', reason: v.reason };
    const current = choose();
    if (compareVersions(v.uiVersion, current.uiVersion) <= 0) return { state: 'up-to-date', version: current.uiVersion };
    if (readJson(badFile, []).includes(v.uiVersion)) return { state: 'rejected', version: v.uiVersion };
    if (compareVersions(appVersion, v.minAppVersion) < 0) {
      return { state: 'needs-app-update', version: v.uiVersion, minAppVersion: v.minAppVersion };
    }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = htmlFile + '.tmp';
    fs.writeFileSync(tmp, html, 'utf8');
    fs.renameSync(tmp, htmlFile);
    writeJson(metaFile, {
      uiVersion: v.uiVersion,
      minAppVersion: v.minAppVersion,
      sha256: sha256(html),
      downloadedAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0
    });
    return { state: 'downloaded', version: v.uiVersion };
  }

  return { choose, beginLoad, ack, rejectCurrent, check };
}

module.exports = { createPatcher, validateHtml, compareVersions, readMeta, MAX_ATTEMPTS };
