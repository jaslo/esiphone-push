// push-service/index.js
// Uses the 'apn' package which handles HTTP/2 correctly for APNs.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const apn = require('apn');

const config = {
    ns: {
        url:       process.env.NS_URL?.replace(/\/$/, ''),
        apiSecret: process.env.NS_API_SECRET,
    },
    apn: {
        key:      process.env.APN_KEY?.replace(/\\n/g, '\n'),
        keyId:    process.env.APN_KEY_ID,
        teamId:   process.env.APN_TEAM_ID,
        bundleId: process.env.APN_BUNDLE_ID,
    },
    pollIntervalMs: 5 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// APNs provider (node-apn handles HTTP/2 and JWT automatically)
// ---------------------------------------------------------------------------

const apnProvider = new apn.Provider({
    token: {
        key:     config.apn.key,
        keyId:   config.apn.keyId,
        teamId:  config.apn.teamId,
    },
    production: true,
});

const deviceTokens = new Set();

// ---------------------------------------------------------------------------
// Send silent push
// ---------------------------------------------------------------------------

async function sendSilentPush(deviceToken) {
    // Clean token — remove any spaces, brackets, or non-hex characters
    const cleanToken = deviceToken.replace(/[^a-f0-9]/gi, '');
 
    const note = new apn.Notification();
    note.topic           = config.apn.bundleId;
    note.pushType        = 'background';
    note.priority        = 5;
    note.contentAvailable = 1;
    note.payload         = {};

    const result = await apnProvider.send(note, deviceToken);

    if (result.sent.length > 0) {
        console.log(`✅ Push sent to ${deviceToken.slice(0, 8)}...`);
    }
    if (result.failed.length > 0) {
        const failure = result.failed[0];
        console.error(`❌ Push failed: ${failure.error || failure.response?.reason}`);
        // Remove invalid tokens
        if (failure.response?.reason === 'BadDeviceToken' ||
            failure.response?.reason === 'Unregistered') {
            deviceTokens.delete(deviceToken);
            console.log(`🗑 Removed invalid token ${deviceToken.slice(0, 8)}...`);
        }
    }
}

// ---------------------------------------------------------------------------
// Poll Nightscout
// ---------------------------------------------------------------------------

function fetchLatestSgv() {
    return new Promise((resolve, reject) => {
        const apiSecretHash = crypto
            .createHash('sha1')
            .update(config.ns.apiSecret)
            .digest('hex');

        const url = new URL(`${config.ns.url}/api/v1/entries/sgv.json?count=1`);
        const options = {
            hostname: url.hostname,
            path:     url.pathname + url.search,
            headers:  { 'api-secret': apiSecretHash },
        };

        https.get(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)[0] || null); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// Main poll loop
// ---------------------------------------------------------------------------

async function poll() {
    if (deviceTokens.size === 0) {
        console.log('⏭  No registered devices, skipping push');
        return;
    }

    try {
        const sgv = await fetchLatestSgv();
        if (sgv) {
            console.log(`📊 Latest SGV: ${sgv.sgv} at ${new Date(sgv.date).toISOString()}`);
        }
        console.log(`📤 Attempting push to ${deviceTokens.size} device(s)...`);
        const results = await Promise.allSettled([...deviceTokens].map(sendSilentPush));
        results.forEach(r => {
            if (r.status === 'rejected') console.error(`❌ Push failed:`, r.reason);
        });
    } catch (err) {
        console.error('Poll error:', err.message);
    }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', devices: deviceTokens.size }));
        return;
    }

    if (req.method === 'POST' && req.url === '/register') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { token } = JSON.parse(body);
                if (!token || typeof token !== 'string') throw new Error('Invalid token');
                deviceTokens.add(token);
                console.log(`📱 Device registered: ${token.slice(0, 8)}... (total: ${deviceTokens.size})`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'registered' }));
            } catch (e) {
                res.writeHead(400);
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
    console.log(`🚀 Push service listening on port ${PORT}`);
    console.log(`📡 Nightscout: ${config.ns.url}`);
    console.log(`🔔 Bundle ID: ${config.apn.bundleId}`);
    poll();
    setInterval(poll, config.pollIntervalMs);
});
