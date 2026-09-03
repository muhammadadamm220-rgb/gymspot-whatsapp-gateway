const { execSync } = require('child_process');
const path = require('path');

const targetPath = path.resolve(__dirname, 'cache', 'puppeteer');
console.log('[Postinstall] Installing Chrome browser to absolute path:', targetPath);

try {
    execSync(`npx puppeteer browsers install chrome --path "${targetPath}"`, { stdio: 'inherit' });
    console.log('[Postinstall] Chrome browser installed successfully!');
} catch (err) {
    console.error('[Postinstall Error] Failed to install Chrome browser:', err.message);
    process.exit(1);
}
