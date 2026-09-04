const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const https = require('https');

const gatewayLogs = [];
const originalLog = console.log;
console.log = (...args) => {
    originalLog(...args);
    gatewayLogs.push({ timestamp: new Date().toISOString(), type: 'info', message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') });
    if (gatewayLogs.length > 50) gatewayLogs.shift();
};
const originalError = console.error;
console.error = (...args) => {
    originalError(...args);
    gatewayLogs.push({ timestamp: new Date().toISOString(), type: 'error', message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') });
    if (gatewayLogs.length > 50) gatewayLogs.shift();
};

const app = express();
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Bypass-Tunnel-Reminder, bypass-tunnel-reminder");
    res.header("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

let latestQr = "";
let connectionStatus = "disconnected";
let sock = null;

const SESSION_DIR = path.resolve(__dirname, 'auth_info');

function extendsClassRequest(binId, method, data = null) {
    return new Promise((resolve, reject) => {
        const payload = data ? JSON.stringify(data) : null;
        const options = {
            hostname: 'extendsclass.com',
            port: 443,
            path: method === 'GET' ? `/bin/${binId}?t=${Date.now()}` : `/bin/${binId}`,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'cache-control': 'no-cache'
            }
        };
        if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (e) { resolve(body); }
            });
        });
        req.on('error', (err) => reject(err));
        if (payload) req.write(payload);
        req.end();
    });
}

async function saveSessionToCloud() {
    try {
        if (!fs.existsSync(SESSION_DIR)) return;
        const map = {};
        const files = fs.readdirSync(SESSION_DIR);
        for (const file of files) {
            const fullPath = path.join(SESSION_DIR, file);
            if (fs.statSync(fullPath).isFile()) {
                map[file] = fs.readFileSync(fullPath, 'utf8');
            }
        }
        if (Object.keys(map).length === 0) return;
        console.log('[Cloud Session] Backing up WhatsApp session keys to cloud database...');
        const currentData = await extendsClassRequest('edebfad', 'GET');
        const payload = (currentData && typeof currentData === 'object' && !Array.isArray(currentData)) 
            ? { ...currentData, baileysSession: map } 
            : { baileysSession: map };
        payload.gatewayUrl = process.env.RENDER_EXTERNAL_URL || 'https://gymspot-whatsapp-gateway-ok82.onrender.com';
        await extendsClassRequest('edebfad', 'PUT', payload);
        console.log('[Cloud Session] Session keys successfully backed up to cloud database!');
    } catch (e) {
        console.error('[Cloud Session Error]', e.message);
    }
}

async function restoreSessionFromCloud() {
    try {
        console.log('[Cloud Session] Restoring session backup from cloud database...');
        const currentData = await extendsClassRequest('edebfad', 'GET');
        if (currentData && currentData.baileysSession && Object.keys(currentData.baileysSession).length > 0) {
            fs.mkdirSync(SESSION_DIR, { recursive: true });
            for (const [file, content] of Object.entries(currentData.baileysSession)) {
                fs.writeFileSync(path.join(SESSION_DIR, file), content, 'utf8');
            }
            console.log('[Cloud Session] Session restored successfully!');
            return true;
        }
    } catch (e) {
        console.error('[Cloud Session Restore Error]', e.message);
    }
    return false;
}

async function publishCloudUrl(url) {
    try {
        const currentData = await extendsClassRequest('edebfad', 'GET');
        const payload = (currentData && typeof currentData === 'object' && !Array.isArray(currentData)) 
            ? { ...currentData, gatewayUrl: url } 
            : { gatewayUrl: url };
        await extendsClassRequest('edebfad', 'PUT', payload);
        console.log('[Cloud Sync] Published gateway URL to cloud:', url);
    } catch (err) {
        console.error('[Cloud Sync Fail]', err.message);
    }
}

async function startWhatsApp() {
    await restoreSessionFromCloud();
    fs.mkdirSync(SESSION_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    let version = [2, 3000, 1015901307];
    try {
        const res = await fetchLatestBaileysVersion();
        version = res.version;
    } catch (e) {}

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['GymSpot Gateway', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await saveSessionToCloud();
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            latestQr = qr;
            connectionStatus = 'disconnected';
            console.log('\n=======================================================');
            console.log('--> FAST QR CODE READY! Scan via http://.../qr');
            console.log('=======================================================\n');
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[Baileys] Connection closed (code ${statusCode}). Reconnecting: ${shouldReconnect}`);
            connectionStatus = 'disconnected';
            if (shouldReconnect) {
                setTimeout(startWhatsApp, 3000);
            } else {
                console.log('[Baileys] Logged out. Clearing local session...');
                latestQr = '';
                try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
                setTimeout(startWhatsApp, 2000);
            }
        } else if (connection === 'open') {
            console.log('\n=======================================================');
            console.log('🎉 SUCCESS! WhatsApp Gateway is CONNECTED & READY!');
            console.log('=======================================================\n');
            connectionStatus = 'connected';
            latestQr = '';
            await saveSessionToCloud();
        }
    });
}

startWhatsApp();

app.get('/status', (req, res) => {
    res.json({ status: connectionStatus, hasQr: !!latestQr, lastHeartbeat: new Date().toISOString() });
});

app.get('/logs', (req, res) => {
    res.json({ logs: gatewayLogs });
});

app.post('/restart', async (req, res) => {
    try {
        console.log('[Restart Gateway Triggered] Rebooting Baileys socket...');
        if (sock) {
            try { sock.end(new Error('Manual Reboot')); } catch (e) {}
        }
        setTimeout(startWhatsApp, 1000);
        res.json({ success: true, message: "Gateway reboot initiated successfully." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/qr', async (req, res) => {
    if (connectionStatus === 'connected') {
        return res.send("<div style='text-align:center;padding:50px;font-family:sans-serif;'><h1 style='color:green;'>✅ WhatsApp is Connected & Active!</h1><p>You can close this tab now. The server will stay connected 24/7 in the cloud.</p></div>");
    }
    if (!latestQr) {
        return res.send("<div style='text-align:center;padding:50px;font-family:sans-serif;'><h2>Starting WhatsApp engine, please wait 3 seconds...</h2><script>setTimeout(()=>location.reload(), 2000)</script></div>");
    }
    try {
        const qrImage = await qrcode.toDataURL(latestQr);
        res.send(`<div style="text-align:center;padding:40px;font-family:sans-serif;"><h2>Scan this QR Code with your WhatsApp:</h2><img src="${qrImage}" width="300"/><p>Open WhatsApp -> Linked Devices -> Link a Device.</p><script>setInterval(async()=>{ const r=await fetch('/status'); const d=await r.json(); if(d.status==='connected') location.reload(); }, 1500);</script></div>`);
    } catch (err) {
        res.status(500).send("Error generating QR.");
    }
});

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (connectionStatus !== 'connected' || !sock) {
        return res.status(503).json({ error: 'WhatsApp is not connected yet.' });
    }
    try {
        let cleanPhone = phone === 'me' ? sock.user.id.split(':')[0] : phone.trim().replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('0')) cleanPhone = '92' + cleanPhone.substring(1);
        let formattedJid = cleanPhone.includes('@s.whatsapp.net') ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;
        await sock.sendMessage(formattedJid, { text: message });
        console.log(`[Auto-Msg Sent] -> ${cleanPhone}`);
        res.json({ success: true, sentTo: cleanPhone });
    } catch (err) {
        console.error('Failed to send message:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/sync-member', async (req, res) => {
    const { member } = req.body;
    if (!member || !member.id) return res.status(400).json({ error: 'Invalid member data' });
    try {
        const currentData = await extendsClassRequest('edebfad', 'GET');
        const cloudMembers = currentData && Array.isArray(currentData.members) ? currentData.members : [];
        const filteredCloud = cloudMembers.filter((m) => m && m.id !== member.id);
        const updatedCloud = [member, ...filteredCloud];
        const payload = (currentData && typeof currentData === 'object' && !Array.isArray(currentData)) 
            ? { ...currentData, members: updatedCloud } 
            : { members: updatedCloud };
        await extendsClassRequest('edebfad', 'PUT', payload);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/sync-attendance', async (req, res) => {
    const { attendance } = req.body;
    if (!attendance || !attendance.id) return res.status(400).json({ error: 'Invalid attendance data' });
    try {
        const currentData = await extendsClassRequest('adcbebb', 'GET');
        const cloudLogs = currentData && Array.isArray(currentData.logs) ? currentData.logs : [];
        const filteredLogs = cloudLogs.filter((l) => l && l.id !== attendance.id);
        const updatedLogs = [attendance, ...filteredLogs].slice(0, 100);
        await extendsClassRequest('adcbebb', 'PUT', { logs: updatedLogs });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`\n=======================================================`);
    console.log(`GymSpot Baileys Gateway running on port ${PORT}`);
    console.log(`=======================================================\n`);
    const pubUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    publishCloudUrl(pubUrl);
});
