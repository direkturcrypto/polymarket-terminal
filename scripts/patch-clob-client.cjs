/**
 * patch-clob-client.cjs
 *
 * Patches @polymarket/clob-client to inject proxy support.
 * Runs automatically via `npm install` (postinstall hook).
 *
 * What it does:
 *   - Adds HttpsProxyAgent import to http-helpers/index.js
 *   - Registers an axios interceptor that injects the proxy agent
 *     into every request to polymarket.com
 *   - Reads PROXY_URL from process.env at runtime
 */

const fs = require('fs');
const path = require('path');

const TARGET = path.join(
    __dirname,
    '..',
    'node_modules',
    '@polymarket',
    'clob-client',
    'dist',
    'http-helpers',
    'index.js',
);

if (!fs.existsSync(TARGET)) {
    console.log('[patch] @polymarket/clob-client not found — skipping');
    process.exit(0);
}

let code = fs.readFileSync(TARGET, 'utf8');

// Check if proxy support is already patched
const proxyAlreadyPatched = code.includes('getProxyAgent');
// Check if the JSON.stringify circular-ref fix is already applied
const jsonFixAlreadyPatched = !code.includes('config: (_d = err.response)');

// ── 1. Proxy interceptor ─────────────────────────────────────────────────────

if (!proxyAlreadyPatched) {
    const PATCH_CODE = `
// ── Proxy support (auto-patched by scripts/patch-clob-client.cjs) ──────────
const https_proxy_agent_1 = require("https-proxy-agent");
let _cachedProxyAgent = null;
const getProxyAgent = () => {
    if (!process.env.PROXY_URL) return undefined;
    if (!_cachedProxyAgent) {
        _cachedProxyAgent = new https_proxy_agent_1.HttpsProxyAgent(process.env.PROXY_URL);
    }
    return _cachedProxyAgent;
};
// Intercept all axios requests — inject proxy agent for polymarket.com
axios_1.default.interceptors.request.use(function(cfg) {
    if (cfg.url && cfg.url.includes('polymarket.com')) {
        var agent = getProxyAgent();
        if (agent) {
            cfg.httpsAgent = agent;
            cfg.httpAgent = agent;
            cfg.proxy = false;
        }
    }
    return cfg;
});
// ── End proxy patch ────────────────────────────────────────────────────────
`;
    const axiosPatterns = [
        /tslib_1\.__importDefault\s*\(\s*require\s*\(\s*["']axios["']\s*\)\s*\)\s*;/,
        /require\s*\(\s*["']axios["']\s*\)\s*;/,
    ];
    let injected = false;
    for (const pattern of axiosPatterns) {
        const match = code.match(pattern);
        if (match) {
            code = code.replace(match[0], match[0] + PATCH_CODE);
            console.log('[patch] Injected proxy interceptor after axios import');
            injected = true;
            break;
        }
    }
    if (!injected) {
        console.error('[patch] Could not find axios import — skipping proxy patch');
    }
} else {
    console.log('[patch] Proxy support already present — skipping');
}

// ── 2. Fix errorHandling circular JSON ───────────────────────────────────────
// JSON.stringify(err.response.config) includes httpsAgent (from proxy) which
// has circular/deep refs and causes "Maximum call stack size exceeded".
// Replace with a simple log that only serializes the response data.

if (!jsonFixAlreadyPatched) {
    const OLD_LOG = `console.error("[CLOB Client] request error", JSON.stringify({
                status: (_a = err.response) === null || _a === void 0 ? void 0 : _a.status,
                statusText: (_b = err.response) === null || _b === void 0 ? void 0 : _b.statusText,
                data: (_c = err.response) === null || _c === void 0 ? void 0 : _c.data,
                config: (_d = err.response) === null || _d === void 0 ? void 0 : _d.config,
            }));`;
    const NEW_LOG = `// config excluded — contains httpsAgent circular refs (stack overflow)
            console.error("[CLOB Client] request error:", (_a = err.response) === null || _a === void 0 ? void 0 : _a.status, JSON.stringify((_b = err.response) === null || _b === void 0 ? void 0 : _b.data));`;
    if (code.includes(OLD_LOG)) {
        code = code.replace(OLD_LOG, NEW_LOG);
        console.log('[patch] Fixed errorHandling circular JSON.stringify');
    } else {
        console.warn('[patch] Could not find errorHandling JSON.stringify — skipping (already fixed or SDK changed)');
    }
} else {
    console.log('[patch] errorHandling JSON fix already applied — skipping');
}

fs.writeFileSync(TARGET, code, 'utf8');
console.log('[patch] @polymarket/clob-client patched ✅');
