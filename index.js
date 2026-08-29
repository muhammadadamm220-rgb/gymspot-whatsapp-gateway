const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');

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
const originalWarn = console.warn;
console.warn = (...args) => {
    originalWarn(...args);
    gatewayLogs.push({ timestamp: new Date().toISOString(), type: 'warning', message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') });
    if (gatewayLogs.length > 50) gatewayLogs.shift();
};

const app = express();

// Full CORS & Private Network Access for Chrome HTTPS -> Localhost
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Bypass-Tunnel-Reminder, bypass-tunnel-reminder");
    res.header("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Bypass-Tunnel-Reminder', 'bypass-tunnel-reminder']
}));
app.use(express.json());

let latestQr = "";
let connectionStatus = "disconnected";

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './auth_info' }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    },
    puppeteer: {
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        ]
    }
});

client.on('qr', (qr) => {
    latestQr = qr;
    connectionStatus = "disconnected";
    console.log('\n=======================================================');
    console.log('--> NEW QR CODE READY! Open http://localhost:4000/qr to scan.');
    console.log('=======================================================\n');
});

client.on('ready', () => {
    latestQr = "";
    connectionStatus = "connected";
    console.log('\n=======================================================');
    console.log('🎉 SUCCESS! WhatsApp Gateway is CONNECTED & READY!');
    console.log('=======================================================\n');
});

client.on('authenticated', () => {
    console.log('WhatsApp Client Authenticated successfully!');
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
    latestQr = "";
    connectionStatus = "disconnected";
});

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
    latestQr = "";
    connectionStatus = "disconnected";
    client.initialize();
});

client.initialize();

app.get('/status', (req, res) => {
    res.json({ status: connectionStatus, hasQr: !!latestQr, lastHeartbeat: new Date().toISOString() });
});

app.get('/logs', (req, res) => {
    res.json({ logs: gatewayLogs });
});

app.post('/restart', async (req, res) => {
    try {
        console.log('[Restart Gateway Triggered] Soft rebooting client & tunnel...');
        startTunnel();
        try {
            await client.destroy();
        } catch (e) {}
        client.initialize();
        res.json({ success: true, message: "Gateway soft-reboot initiated successfully." });
    } catch (err) {
        console.error('Failed to restart gateway:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/qr', async (req, res) => {
    if (connectionStatus === 'connected') {
        return res.send("<div style='text-align:center;padding:50px;font-family:sans-serif;'><h1 style='color:green;'>✅ WhatsApp is Connected & Active!</h1><p>You can test sending OTPs now.</p></div>");
    }
    if (!latestQr) {
        return res.send("<div style='text-align:center;padding:50px;font-family:sans-serif;'><h2>Starting WhatsApp engine, please wait 10 seconds...</h2><script>setTimeout(()=>location.reload(), 3000)</script></div>");
    }
    try {
        const qrImage = await qrcode.toDataURL(latestQr);
        res.send(`<div style="text-align:center;padding:40px;font-family:sans-serif;"><h2>Scan this QR Code with your WhatsApp:</h2><img src="${qrImage}" width="300"/><p>Open WhatsApp -> Linked Devices -> Link a Device.</p><script>setInterval(async()=>{ const r=await fetch('/status'); const d=await r.json(); if(d.status==='connected') location.reload(); }, 2000);</script></div>`);
    } catch (err) {
        res.status(500).send("Error generating QR.");
    }
});

const https = require('https');

function extendsClassRequest(binId, method, data = null) {
    return new Promise((resolve, reject) => {
        const payload = data ? JSON.stringify(data) : null;
        const options = {
            hostname: 'json.extendsclass.com',
            port: 443,
            path: method === 'GET' ? `/bin/${binId}?t=${Date.now()}` : `/bin/${binId}`,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'cache-control': 'no-cache'
            }
        };
        if (payload) {
            options.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    resolve(body);
                }
            });
        });

        req.on('error', (err) => reject(err));

        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

app.post('/sync-member', async (req, res) => {
    const { member } = req.body;
    if (!member || !member.id) {
        return res.status(400).json({ error: 'Invalid member data' });
    }
    try {
        console.log(`[Cloud-Sync Initiated] for Member ID: ${member.id}`);
        // 1. Fetch current cloud data
        const currentData = await extendsClassRequest('edebfad', 'GET');
        const cloudMembers = currentData && Array.isArray(currentData.members) ? currentData.members : [];
        
        // 2. Filter duplicates & prepend new member
        const filteredCloud = cloudMembers.filter((m) => m && m.id !== member.id);
        const updatedCloud = [member, ...filteredCloud];

        // 3. Write back to extendsclass cloud bin (preserving all other fields)
        await extendsClassRequest('edebfad', 'PUT', { 
            ...currentData,
            members: updatedCloud
        });
        console.log(`[Cloud-Sync Success] for Member ID: ${member.id}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Cloud sync error in gateway:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/register-gym', async (req, res) => {
    const { gym } = req.body;
    if (!gym || !gym.id) {
        return res.status(400).json({ error: 'Invalid gym data' });
    }
    try {
        console.log(`[Cloud-Gym-Registration Initiated] for Gym ID: ${gym.id}`);
        const currentData = await extendsClassRequest('edebfad', 'GET');
        const registeredGyms = currentData && Array.isArray(currentData.registeredGyms) ? currentData.registeredGyms : [];
        const filteredGyms = registeredGyms.filter((g) => g && g.id !== gym.id);
        const updatedGyms = [gym, ...filteredGyms];
        
        await extendsClassRequest('edebfad', 'PUT', { 
            ...currentData,
            registeredGyms: updatedGyms
        });
        console.log(`[Cloud-Gym-Registration Success] for Gym ID: ${gym.id}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Cloud register sync error in gateway:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/sync-admin-overrides', async (req, res) => {
    const { overrides } = req.body;
    if (!overrides) {
        return res.status(400).json({ error: 'Invalid overrides data' });
    }
    try {
        console.log(`[Cloud-Overrides-Sync Initiated]`);
        const currentData = await extendsClassRequest('edebfad', 'GET');
        
        await extendsClassRequest('edebfad', 'PUT', { 
            ...currentData,
            adminOverrides: overrides
        });
        console.log(`[Cloud-Overrides-Sync Success]`);
        res.json({ success: true });
    } catch (err) {
        console.error('Cloud overrides sync error in gateway:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/sync-attendance', async (req, res) => {
    const { attendance } = req.body;
    if (!attendance || !attendance.id) {
        return res.status(400).json({ error: 'Invalid attendance data' });
    }
    try {
        console.log(`[Cloud-Attendance-Sync Initiated] for ID: ${attendance.id}`);
        // 1. Fetch current cloud data
        const currentData = await extendsClassRequest('adcbebb', 'GET');
        const cloudLogs = currentData && Array.isArray(currentData.logs) ? currentData.logs : [];
        
        // 2. Filter duplicates & prepend new log (keep last 100)
        const filteredLogs = cloudLogs.filter((l) => l && l.id !== attendance.id);
        const updatedLogs = [attendance, ...filteredLogs].slice(0, 100);

        // 3. Write back to extendsclass cloud bin
        await extendsClassRequest('adcbebb', 'PUT', { logs: updatedLogs });
        console.log(`[Cloud-Attendance-Sync Success] for ID: ${attendance.id}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Cloud attendance sync error in gateway:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (connectionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp is not connected yet. Open http://localhost:4000/qr' });
    }
    try {
        let cleanPhone = phone === 'me' ? client.info.wid.user : phone.trim().replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('0')) cleanPhone = '92' + cleanPhone.substring(1);
        let formattedPhone = cleanPhone.includes('@c.us') ? cleanPhone : `${cleanPhone}@c.us`;
        await client.sendMessage(formattedPhone, message);
        console.log(`[Auto-Msg Sent] -> ${cleanPhone}`);
        res.json({ success: true, sentTo: cleanPhone });
    } catch (err) {
        console.error('Failed to send message:', err.message);
        res.status(500).json({ error: err.message });
    }
});


const PORT = 4000;
app.listen(PORT, () => {
    console.log(`\n=======================================================`);
    console.log(`GymSpot Local Gateway running on http://localhost:${PORT}`);
    console.log(`Status URL: http://localhost:${PORT}/status`);
    console.log(`QR Code URL: http://localhost:${PORT}/qr`);
    console.log(`=======================================================\n`);
    
    startTunnel();
});

const { exec } = require('child_process');
let publicTunnelUrl = '';
let ltProcess = null;
let consecutiveFailures = 0;

const killProcessTree = (pid) => {
    try {
        console.log(`[Tunnel Kill] Terminating process tree for PID ${pid}...`);
        exec(`taskkill /pid ${pid} /f /t`, (err) => {
            if (err) {
                console.warn(`[Tunnel Kill Info] taskkill reported: ${err.message}`);
            } else {
                console.log(`[Tunnel Kill Success] Process tree for PID ${pid} terminated.`);
            }
        });
    } catch (e) {
        console.error('[Tunnel Kill Exception] Failed to execute taskkill:', e);
    }
};

function startTunnel() {
    console.log('[Tunnel] Starting localtunnel on port 4000...');
    if (ltProcess) {
        try {
            killProcessTree(ltProcess.pid);
        } catch (e) {}
        ltProcess = null;
    }

    const lt = exec('npx -y localtunnel --port 4000');
    ltProcess = lt;
    
    const handleOutput = async (data) => {
        const output = data.toString();
        console.log(`[Tunnel Log] ${output.trim()}`);
        const match = output.match(/your url is: (https:\/\/[a-z0-9.-]+\.loca\.lt)/i);
        if (match) {
            publicTunnelUrl = match[1];
            console.log(`\n🎉 [Public Gateway URL] -> ${publicTunnelUrl}\n`);
            
            try {
                const currentData = await extendsClassRequest('edebfad', 'GET');
                await extendsClassRequest('edebfad', 'PUT', { 
                    ...currentData,
                    gatewayUrl: publicTunnelUrl
                });
                console.log('[Tunnel] Successfully published public URL to cloud database.');
            } catch (err) {
                console.error('[Tunnel] Failed to publish URL to cloud:', err.message);
            }
        }
    };

    lt.stdout.on('data', handleOutput);
    lt.stderr.on('data', handleOutput);

    lt.on('close', (code) => {
        console.log(`[Tunnel] Process exited with code ${code}. Restarting in 5 seconds...`);
        ltProcess = null;
        setTimeout(startTunnel, 5000);
    });
}

// Self-healing tunnel health check: Ping the tunnel status endpoint every 45 seconds
setInterval(async () => {
    if (publicTunnelUrl && ltProcess) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s request timeout
            const res = await fetch(`${publicTunnelUrl}/status`, {
                signal: controller.signal,
                headers: { "bypass-tunnel-reminder": "true" }
            });
            clearTimeout(timeoutId);
            if (res.status === 200) {
                consecutiveFailures = 0; // reset
                return;
            }
            throw new Error(`Status ${res.status}`);
        } catch (err) {
            consecutiveFailures++;
            console.warn(`[Tunnel Health Check] Warning: Tunnel ping failed (${err.message}). Failure count: ${consecutiveFailures}/3`);
            
            if (consecutiveFailures >= 3) {
                console.error(`[Tunnel Health Check] Tunnel failed 3 consecutive times. Restarting process tree...`);
                publicTunnelUrl = '';
                consecutiveFailures = 0;
                if (ltProcess) {
                    killProcessTree(ltProcess.pid);
                }
            }
        }
    }
}, 45000);
