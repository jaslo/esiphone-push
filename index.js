// push-service/index.js
// Multi-tenant silent push service for ESiPhone.
// Stores per-user Eversense access tokens (never passwords).
// Polls Eversense every 5 minutes for each user and sends silent pushes.
//
// RAILWAY ENVIRONMENT VARIABLES:
//   APN_KEY         full contents of the .p8 file
//   APN_KEY_ID      XCX6F34JDS
//   APN_TEAM_ID     M6BY89LVGP
//   APN_BUNDLE_ID   com.vtable.esiphone
//   PORT            set automatically by Railway

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const crypto = require('crypto');
const apn    = require('@parse/node-apn');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config = {
    apn: {
        key:      process.env.APN_KEY?.replace(/\\n/g, '\n'),
        keyId:    process.env.APN_KEY_ID,
        teamId:   process.env.APN_TEAM_ID,
        bundleId: process.env.APN_BUNDLE_ID,
    },
    pollIntervalMs:   5 * 60 * 1000,   // 5 minutes
    tokenRefreshBuffer: 5 * 60,        // re-auth 5 min before token expires (seconds)
    dataFile: '/data/users.json',      // persisted user store
};

// ---------------------------------------------------------------------------
// APNs provider
// ---------------------------------------------------------------------------

const apnProvider = new apn.Provider({
    token: {
        key:    config.apn.key,
        keyId:  config.apn.keyId,
        teamId: config.apn.teamId,
    },
    production: true,
});

// ---------------------------------------------------------------------------
// User store
// Each user: { deviceToken, accessToken, tokenExpiry, lastSgv, lastUpdated }
// Keyed by deviceToken for easy lookup and update.
// ---------------------------------------------------------------------------

let users = {};  // { [deviceToken]: userRecord }

function saveUsers() {
    try {
        fs.mkdirSync('/data', { recursive: true });
        fs.writeFileSync(config.dataFile, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error('Failed to save users:', e.message);
    }
}

function loadUsers() {
    try {
        if (fs.existsSync(config.dataFile)) {
            users = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
            console.log(`📂 Loaded ${Object.keys(users).length} user(s) from disk`);
        }
    } catch (e) {
        console.error('Failed to load users:', e.message);
        users = {};
    }
}

// ---------------------------------------------------------------------------
// Eversense API
// ---------------------------------------------------------------------------

const EVERSENSE_DETAILS_URL = 'https://usapialpha.eversensedms.com/api/care/GetFollowingPatientList';

function fetchGlucose(accessToken) {
    return new Promise((resolve, reject) => {
        const url = new URL(EVERSENSE_DETAILS_URL);
        const options = {
            hostname: url.hostname,
            path:     url.pathname,
            headers:  { 'Authorization': `Bearer ${accessToken}` },
        };

        https.get(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 401) {
                    reject(new Error('TOKEN_EXPIRED'));
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    const entries = JSON.parse(data);
                    const first = entries[0];
                    if (!first) { reject(new Error('NO_DATA')); return; }

                    const trendMap = {
                        0: '?', 1: '↓↓', 2: '↓', 3: '→',
                        4: '↑', 5: '↑↑', 6: '↓↓', 7: '↑↑'
                    };
                    const connected = first.IsTransmitterConnected;
                    const sgv       = first.CurrentGlucose;
                    const trend     = trendMap[first.GlucoseTrend] ?? '→';
                    const display   = connected ? `${sgv} ${trend}` : 'No signal';
                    resolve(display);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// APNs push helpers
// ---------------------------------------------------------------------------

async function sendSilentPush(deviceToken) {
    const cleanToken = deviceToken.replace(/[^a-f0-9]/gi, '');
    const note = new apn.Notification();
    note.topic            = config.apn.bundleId;
    note.pushType         = 'background';
    note.priority         = 10;
    note.contentAvailable = 1;
    note.payload          = {};

    const result = await apnProvider.send(note, cleanToken);
    if (result.failed.length > 0) {
        const reason = result.failed[0].response?.reason || result.failed[0].error;
        throw new Error(reason);
    }
}

async function sendReauthPush(deviceToken) {
    const cleanToken = deviceToken.replace(/[^a-f0-9]/gi, '');
    const note = new apn.Notification();
    note.topic            = config.apn.bundleId;
    note.pushType         = 'background';
    note.priority         = 10;
    note.contentAvailable = 1;
    note.payload          = { esiphone_reauth: true };  // App checks for this key

    const result = await apnProvider.send(note, cleanToken);
    if (result.failed.length > 0) {
        const reason = result.failed[0].response?.reason || result.failed[0].error;
        throw new Error(reason);
    }
}

// ---------------------------------------------------------------------------
// Poll loop — runs every 5 minutes
// ---------------------------------------------------------------------------

async function pollUser(deviceToken, user) {
    const now = Date.now() / 1000;

    // Check if token is about to expire — send re-auth push
    if (user.tokenExpiry && now >= user.tokenExpiry - config.tokenRefreshBuffer) {
        console.log(`🔑 Token expiring for ${deviceToken.slice(0, 8)}..., requesting re-auth`);
        try {
            await sendReauthPush(deviceToken);
        } catch (e) {
            console.error(`❌ Re-auth push failed for ${deviceToken.slice(0, 8)}...: ${e.message}`);
            if (e.message === 'BadDeviceToken' || e.message === 'Unregistered') {
                delete users[deviceToken];
                saveUsers();
            }
        }
        return;
    }

    // Fetch glucose from Eversense
    try {
        const display = await fetchGlucose(user.accessToken);
        console.log(`📊 ${deviceToken.slice(0, 8)}...: ${display}`);
        users[deviceToken].lastSgv     = display;
        users[deviceToken].lastUpdated = new Date().toISOString();
        saveUsers();
    } catch (e) {
        if (e.message === 'TOKEN_EXPIRED') {
            console.log(`🔑 Token expired for ${deviceToken.slice(0, 8)}..., requesting re-auth`);
            try { await sendReauthPush(deviceToken); } catch (_) {}
        } else {
            console.error(`❌ Glucose fetch failed for ${deviceToken.slice(0, 8)}...: ${e.message}`);
        }
        return;
    }

    // Send silent push to wake the app
    try {
        await sendSilentPush(deviceToken);
        console.log(`✅ Push sent to ${deviceToken.slice(0, 8)}...`);
    } catch (e) {
        console.error(`❌ Push failed for ${deviceToken.slice(0, 8)}...: ${e.message}`);
        if (e.message === 'BadDeviceToken' || e.message === 'Unregistered') {
            delete users[deviceToken];
            saveUsers();
        }
    }
}

async function poll() {
    const tokens = Object.keys(users);
    if (tokens.length === 0) {
        console.log('⏭  No registered users, skipping poll');
        return;
    }
    console.log(`🔄 Polling ${tokens.length} user(s)...`);
    await Promise.allSettled(tokens.map(token => pollUser(token, users[token])));
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
//
// POST /register    { deviceToken, accessToken, tokenExpiry }
// POST /unregister  { deviceToken }
// GET  /health      returns status + user count

const server = http.createServer((req, res) => {

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status:  'ok',
            users:   Object.keys(users).length,
            uptime:  Math.floor(process.uptime()),
        }));
        return;
    }

    // Register / re-register user
    if (req.method === 'POST' && req.url === '/register') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { deviceToken, accessToken, tokenExpiry } = JSON.parse(body);
                if (!deviceToken || !accessToken) throw new Error('Missing deviceToken or accessToken');

                const cleanToken = deviceToken.replace(/[^a-f0-9]/gi, '');
                if (cleanToken.length !== 64) throw new Error('Invalid token length');

                users[cleanToken] = {
                    accessToken,
                    tokenExpiry:  tokenExpiry || null,
                    lastSgv:      users[cleanToken]?.lastSgv || null,
                    lastUpdated:  users[cleanToken]?.lastUpdated || null,
                    registeredAt: new Date().toISOString(),
                };
                saveUsers();
                console.log(`📱 Registered: ${cleanToken.slice(0, 8)}... (total: ${Object.keys(users).length})`);

                // Trigger immediate poll for this user
                pollUser(cleanToken, users[cleanToken]).catch(console.error);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'registered' }));
            } catch (e) {
                console.error('Register error:', e.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Unregister user
    if (req.method === 'POST' && req.url === '/unregister') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { deviceToken } = JSON.parse(body);
                const cleanToken = deviceToken.replace(/[^a-f0-9]/gi, '');
                delete users[cleanToken];
                saveUsers();
                console.log(`🗑  Unregistered: ${cleanToken.slice(0, 8)}... (total: ${Object.keys(users).length})`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'unregistered' }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 ESiPhone push service listening on port ${PORT}`);
    console.log(`🔔 Bundle ID: ${config.apn.bundleId}`);
    loadUsers();
    poll();
    setInterval(poll, config.pollIntervalMs);
});
