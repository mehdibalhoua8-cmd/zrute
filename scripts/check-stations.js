#!/usr/bin/env node
// Daily check of every station link in stations.json and islamic_stations.json.
// Run from the data repo root (the folder holding stations.json):
//   node scripts/check-stations.js            check, then update the JSON files
//   node scripts/check-stations.js --dry-run  check and print only
//
// - A station that fails on 2 runs in a row gets "offline": true, so the app moves it to the
//   end of the list and dims it. One success clears it. A single failure is never enough:
//   the checker runs outside Morocco and a host can be down for a few minutes.
// - Stations played through a web player ("embed") are skipped: they have no direct link.
// - For data saver, a lower bitrate link is looked for on hosts with a known naming scheme
//   (Infomaniak: -128.mp3 next to -64.mp3) and saved as "lowStreamUrl" when it plays.
// - The stream's bitrate (icy-br header) is saved as "bitrate" in kbps, so the app can show
//   how much data an hour of listening uses.
// Failure streaks are kept in station-status.json next to the station files.

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const FILES = ['stations.json', 'islamic_stations.json'];
const STATUS_FILE = path.join(ROOT, 'station-status.json');
const DRY_RUN = process.argv.includes('--dry-run');

const OFFLINE_AFTER_FAILS = 2;
const TIMEOUT_MS = 12000;
const CONCURRENCY = 8;
const PER_HOST = 2;
const RETRY_DELAY_MS = 5000;
// Enough audio to prove the stream is live and not an error page
const MIN_BYTES = 4096;

const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 12; TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Same headers the app sends (src/context/PlayerContext.tsx, playStream)
function headersFor(url) {
    if (url.includes('medi1.com') || url.includes('easybroadcast.io')) {
        return { 'User-Agent': BROWSER_UA, Accept: '*/*', Origin: 'https://medi1.com', Referer: 'https://medi1.com/' };
    }
    return { 'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Mobile)', Accept: '*/*' };
}

// kbps announced by Icecast / Shoutcast servers, by checked link
const bitrates = new Map();

const isHls =(url) => /\.m3u8|m3u8/i.test(url);
const isPlaylist = (url) => /\.m3u($|\?)|\.pls($|\?)|playlist/i.test(url) && !isHls(url);

async function fetchWithTimeout(url, ms = TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(url, { headers: headersFor(url), signal: controller.signal, redirect: 'follow' });
        return { res, controller, timer };
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

// Reads up to MIN_BYTES of the body, then drops the connection
async function readSome(res, controller) {
    const reader = res.body.getReader();
    let total = 0;
    let head = '';
    try {
        while (total < MIN_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            if (head.length < 200) head += Buffer.from(value).toString('latin1').slice(0, 200);
            total += value.length;
        }
    } finally {
        controller.abort();
    }
    return { total, head };
}

// Returns null when the link plays, otherwise a short reason
async function checkUrl(url, depth = 0) {
    if (!/^https?:\/\//i.test(url)) return 'not an http link';
    let r;
    try {
        r = await fetchWithTimeout(url);
    } catch (e) {
        return e.name === 'AbortError' ? 'timeout' : `network: ${e.cause?.code || e.message}`;
    }
    const { res, controller, timer } = r;
    try {
        if (!res.ok) {
            controller.abort();
            return `HTTP ${res.status}`;
        }
        const type = (res.headers.get('content-type') || '').toLowerCase();

        if (isHls(url) || type.includes('mpegurl')) {
            const text = await res.text();
            if (!text.includes('#EXTM3U')) return 'HLS playlist without #EXTM3U';
            // Follow the first variant or segment once, so a dead origin behind a live index is caught
            const next = text.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'));
            if (next && depth < 2) return checkUrl(new URL(next, url).toString(), depth + 1);
            return null;
        }

        if (isPlaylist(url) || type.includes('scpls') || type.includes('x-scpls')) {
            const text = await res.text();
            const lines = text.split(/\r?\n/).map(l => l.trim());
            const pls = lines.map(l => /^file\d+=(.+)$/i.exec(l)?.[1]).find(Boolean);
            const m3u = lines.find(l => /^https?:\/\//i.test(l));
            const next = pls || m3u;
            if (!next) return 'playlist without a stream link';
            if (depth >= 2) return null;
            return checkUrl(new URL(next, url).toString(), depth + 1);
        }

        if (type.includes('text/html')) {
            controller.abort();
            return 'returns a web page, not audio';
        }
        const br = parseInt((res.headers.get('icy-br') || '').split(',')[0], 10);
        if (br > 0 && br <= 512) bitrates.set(url, br);
        const { total } = await readSome(res, controller);
        if (total < MIN_BYTES) return `only ${total} bytes`;
        return null;
    } catch (e) {
        return e.name === 'AbortError' ? 'timeout while reading' : `read: ${e.message}`;
    } finally {
        clearTimeout(timer);
    }
}

// Lower bitrate link on hosts that publish several qualities side by side
function lowBitrateCandidates(url) {
    const out = [];
    const m = /^(https:\/\/[^/]+\.ice\.infomaniak\.ch\/[^/]+?)-(128|192|256|320|high)\.(mp3|aac)$/i.exec(url);
    if (m) {
        out.push(`${m[1]}-64.${m[3]}`, `${m[1]}-low.${m[3]}`, `${m[1]}-48.aac`, `${m[1]}-32.aac`);
    }
    return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// At most PER_HOST checks at once on one server: qurango.net (Quran radios) answers
// HTTP 500 when many of its streams are opened together
const hostSlots = new Map();
async function checkHost(url) {
    let host = '';
    try { host = new URL(url).host; } catch { return checkUrl(url); }
    const slot = hostSlots.get(host) || { active: 0, queue: [] };
    hostSlots.set(host, slot);
    if (slot.active >= PER_HOST) await new Promise(r => slot.queue.push(r));
    slot.active++;
    try {
        return await checkUrl(url);
    } finally {
        slot.active--;
        slot.queue.shift()?.();
    }
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: limit }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }));
    return results;
}

// One station per line, like the files are written by hand
function formatStations(list) {
    const fmt = (v) => {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            return '{ ' + Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${fmt(x)}`).join(', ') + ' }';
        }
        return JSON.stringify(v);
    };
    return '[\n' + list.map(s => '  ' + fmt(s)).join(',\n') + '\n]\n';
}

async function main() {
    const status = fs.existsSync(STATUS_FILE) ? JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) : {};
    const today = new Date().toISOString().slice(0, 10);
    const report = { ok: 0, failed: [], nowOffline: [], backOnline: [], lowAdded: [], lowRemoved: [], skipped: 0 };

    for (const file of FILES) {
        const full = path.join(ROOT, file);
        if (!fs.existsSync(full)) continue;
        const original = fs.readFileSync(full, 'utf8');
        const stations = JSON.parse(original);
        if (!Array.isArray(stations)) throw new Error(`${file}: expected an array`);

        await mapLimit(stations, CONCURRENCY, async (s) => {
            const url = String(s.streamUrl || s.url || '').trim();
            if (s.embed || !url) { report.skipped++; return; }
            const key = `${file}:${s.name}`;
            const prev = status[key] || { fails: 0 };
            let error = await checkHost(url);
            // One more try a little later: DNS hiccups and busy servers are common on the runner
            if (error) {
                await sleep(RETRY_DELAY_MS);
                error = await checkHost(url);
            }

            if (!error) {
                report.ok++;
                if (s.offline) { delete s.offline; report.backOnline.push(s.name); }
                status[key] = { fails: 0, lastOk: today };
                const br = bitrates.get(url);
                if (br && s.bitrate !== br) s.bitrate = br;
            } else {
                // A second run on the same day (e.g. started by hand) does not count again
                const fails = prev.lastCheck === today ? (prev.fails || 1) : (prev.fails || 0) + 1;
                status[key] = { fails, lastOk: prev.lastOk || null, lastError: error, lastCheck: today };
                report.failed.push(`${s.name}: ${error} (${fails} in a row)`);
                if (fails >= OFFLINE_AFTER_FAILS && !s.offline) { s.offline = true; report.nowOffline.push(s.name); }
            }

            if (error) return;
            if (s.lowStreamUrl) {
                if (await checkUrl(s.lowStreamUrl)) { delete s.lowStreamUrl; report.lowRemoved.push(s.name); }
                return;
            }
            for (const candidate of lowBitrateCandidates(url)) {
                if (!(await checkUrl(candidate))) { s.lowStreamUrl = candidate; report.lowAdded.push(s.name); break; }
            }
        });

        // Keep the file's layout: hand-written one-per-line, or indented JSON
        const onePerLine = /^\[\s*\n\s*\{ "/.test(original);
        const updated = onePerLine ? formatStations(stations) : JSON.stringify(stations, null, 2) + '\n';
        if (!DRY_RUN && updated !== original) fs.writeFileSync(full, updated);
    }

    if (!DRY_RUN) fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + '\n');

    const list = (title, items) => items.length && console.log(`\n${title} (${items.length}):\n  ` + items.join('\n  '));
    console.log(`Checked: ${report.ok} playing, ${report.failed.length} failing, ${report.skipped} skipped (web player)`);
    list('Failing', report.failed);
    list('Marked offline', report.nowOffline);
    list('Back online', report.backOnline);
    list('Low bitrate link added', report.lowAdded);
    list('Low bitrate link removed', report.lowRemoved);
    if (DRY_RUN) console.log('\nDry run: no file was changed.');
}

main().catch(e => { console.error(e); process.exit(1); });
