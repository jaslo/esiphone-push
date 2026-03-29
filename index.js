// push-service/index.js
// Standalone Node.js service that runs on Railway alongside Nightscout.
// Every 5 minutes it checks Nightscout for a recent SGV and sends a
// silent push notification to the iPhone app to wake it and fetch fresh data.
//
// RAILWAY ENVIRONMENT VARIABLES:
//   NS_URL          e.g. https://yoursite.up.railway.app
//   NS_API_SECRET   your Nightscout API secret
//   APN_KEY         full contents of the .p8 file (including header/footer lines)
//   APN_KEY_ID      ZH38TQBCY7
//   APN_TEAM_ID     M6BY89LVGP
//   APN_BUNDLE_ID   com.vtable.esiphone
//   PORT            set automatically by Railway

const http  = require('http');
const https = require('https');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config (from environment variables)
// ---------------------------------------------------------------------------

const config = {
    ns: {
        url:       process.env.NS_URL?.replace(/\/$/, ''),
        apiSecret: process.env.NS_API_SECRET,
    },
    apn: {
        key:      process.env.APN_KEY,       // full .p8 contents
        keyId:    process.env.APN_KEY_ID,    // ZH38TQBCY7
        teamId:   process.env.APN_TEAM_ID,   // M6BY89LVGP
        bundleId: process.env.APN_BUNDLE_ID, // com.vtable.esiphone
    },
    pollIntervalMs: 5 * 60 * 1000,           // 5 minutes
};

// Device tokens registered by the iPhone app.
// Stored in memory — resets on redeploy, but the app re-registers on launch.
const deviceTokens = new Set();

// ---------------------------------------------------------------------------
// APNs JWT token (valid for 1 hour, reused until expiry)
// ---------------------------------------------------------------------------

let cachedJwt = null;
let jwtIssuedAt = 0;

function getApnsJwt() {
    const now = Math.floor(Date.now() / 1000);
    if (cachedJwt && now - jwtIssuedAt < 3500) return cachedJwt;

    const header  = base64url(JSON.stringify({ alg: 'ES256', kid: config.apn.keyId }));
    const payload = base64url(JSON.stringify({ iss: config.apn.teamId, iat: now }));
    const unsigned = `${header}.${payload}`;

    const sign = crypto.createSign('SHA256');
    sign.update(unsigned);
    const signature = base64url(sign.sign({ key: config.apn.key, dsaEncoding: 'ieee-p1363' }));

    cachedJwt   = `${unsigned}.${signature}`;
    jwtIssuedAt = now;
    return cachedJwt;
}

function base64url(str) {
    const b = Buffer.isBuffer(str) ? str : Buffer.from(str);
    return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ---------------------------------------------------------------------------
// Send silent push to a single device token
// ---------------------------------------------------------------------------

function sendSilentPush(deviceToken) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ aps: { 'content-available': 1 } });
        const jwt  = getApnsJwt();

        const options = {
            hostname: 'api.push.apple.com',
            port:     443,
            path:     `/3/device/${deviceToken}`,
            method:   'POST',
            headers: {
                'authorization':  `bearer ${jwt}`,
                'apns-topic':     config.apn.bundleId,
                'apns-push-type': 'background',
                'apns-priority':  '5',      // 5 = normal priority for background
                'content-type':   'application/json',
                'content-length': Buffer.byteLength(body),
            },
        };

        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log(`✅ Push sent to ${deviceToken.slice(0, 8)}...`);
                    resolve();
                } else {
                    console.error(`❌ APNs error ${res.statusCode}: ${data}`);
                    // Remove invalid tokens
                    if (res.statusCode === 410 || res.statusCode === 400) {
                        deviceTokens.delete(deviceToken);
                    }
                    reject(new Error(`APNs ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Poll Nightscout for latest SGV (just to confirm data is flowing)
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
                try {
                    const entries = JSON.parse(data);
                    resolve(entries[0] || null);
                } catch (e) {
                    reject(e);
                }
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
        // Send silent push to all registered devices regardless —
        // the app will fetch fresh data from Eversense directly.
        await Promise.allSettled([...deviceTokens].map(sendSilentPush));
    } catch (err) {
        console.error('Poll error:', err.message);
    }
}

// ---------------------------------------------------------------------------
// HTTP server — handles device token registration from the iPhone app
// ---------------------------------------------------------------------------
// Endpoints:
//   POST /register   body: { "token": "<device token hex string>" }
//   GET  /health     returns 200 OK

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
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
                res.writeHead(200);
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

    // Start polling immediately then every 5 minutes.
    poll();
    setInterval(poll, config.pollIntervalMs);
});
