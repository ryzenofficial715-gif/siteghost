const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ==================== UTILS ====================
const RANDOM_UA = [
    "Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Googlebot/2.1 (+http://www.google.com/bot.html)",
    "Bingbot/2.0 (+http://www.bing.com/bingbot.htm)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randIP() { return `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`; }

function buildHeaders(type) {
    type = type || "normal";
    const headers = {
        "User-Agent": rand(RANDOM_UA),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
    };
    
    if (type === "xff") {
        headers["X-Forwarded-For"] = randIP();
        headers["X-Real-IP"] = randIP();
    } else if (type === "bot") {
        headers["User-Agent"] = "Googlebot/2.1 (+http://www.google.com/bot.html)";
    } else if (type === "mobile") {
        headers["User-Agent"] = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15";
    } else if (type === "cloudflare") {
        headers["CF-Connecting-IP"] = randIP();
        headers["True-Client-IP"] = "127.0.0.1";
    }
    
    return headers;
}

function pathVariations(path) {
    const variations = [path];
    variations.push(path.replace('/', '//'));
    variations.push(`/../${path.replace(/^\//, '')}`);
    variations.push(`/./${path.replace(/^\//, '')}`);
    variations.push(encodeURIComponent(path));
    variations.push(path.replace(/\//g, '%2F'));
    for (const s of [';.html', ';.php', '%00', '%20', '?', '#']) {
        variations.push(`${path}${s}`);
    }
    for (const p of ['?test=1', '?id=1', '?debug=true']) {
        variations.push(`${path}${p}`);
    }
    variations.push(path.toUpperCase());
    return variations;
}

// ==================== RIP FUNCTIONS ====================
function ripHTML($, html) {
    const scripts = [];
    $('script[src]').each((i, el) => {
        const src = $(el).attr('src');
        if (src) scripts.push(src);
    });
    
    const inlineScripts = [];
    $('script:not([src])').each((i, el) => {
        const txt = $(el).html();
        if (txt && txt.trim()) inlineScripts.push(txt.substring(0, 500));
    });
    
    const styles = [];
    $('link[rel="stylesheet"]').each((i, el) => {
        const href = $(el).attr('href');
        if (href) styles.push(href);
    });
    
    const inlineStyles = [];
    $('style').each((i, el) => {
        const txt = $(el).html();
        if (txt && txt.trim()) inlineStyles.push(txt.substring(0, 500));
    });
    
    const forms = [];
    $('form').each((i, el) => {
        const inputs = [];
        $(el).find('input, select, textarea').each((j, inp) => {
            inputs.push({
                name: $(inp).attr('name') || 'N/A',
                type: $(inp).attr('type') || 'text'
            });
        });
        forms.push({
            action: $(el).attr('action') || 'N/A',
            method: ($(el).attr('method') || 'GET').toUpperCase(),
            inputs: inputs
        });
    });
    
    const links = [];
    $('a[href]').each((i, el) => {
        const h = $(el).attr('href');
        if (h && !h.startsWith('#') && !h.startsWith('javascript:')) links.push(h);
    });
    
    const images = [];
    $('img[src]').each((i, el) => {
        const s = $(el).attr('src');
        if (s) images.push(s);
    });
    
    const meta = [];
    $('meta').each((i, el) => {
        const name = $(el).attr('name') || $(el).attr('property') || '';
        const content = $(el).attr('content') || '';
        if (name && content) meta.push({ name, content: content.substring(0, 200) });
    });
    
    const comments = (html.match(/<!--(.*?)-->/gs) || [])
        .map(c => c.replace(/<!--|-->/g, '').trim())
        .filter(c => c.length > 5);
    
    return {
        title: $('title').text() || 'N/A',
        meta,
        scripts,
        inlineScripts,
        styles,
        inlineStyles,
        forms,
        links,
        images,
        comments,
    };
}

function ripAPIKeys(text) {
    const found = new Set();
    const patterns = [
        /(?:api[_-]?key|apikey|token|secret|password)\s*[=:]\s*["']([a-zA-Z0-9_\-]{15,})["']/gi,
        /AIzaSy[a-zA-Z0-9_\-]{30,}/g,
        /sk-[a-zA-Z0-9]{20,}/g,
        /eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+/g,
    ];
    for (const p of patterns) {
        const matches = text.matchAll(p);
        for (const m of matches) {
            found.add(m[1] || m[0]);
        }
    }
    return [...found];
}

function ripEndpoints(html) {
    const eps = new Set();
    const patterns = [
        /(?:https?:\/\/[^\s"'<>]+?(?:api|v\d|graphql|auth|login|register|token|oauth)[^\s"'<>]*)/gi,
        /(?:fetch|axios|\.get|\.post)\s*\(\s*["']([^"']+)["']/gi,
        /(?:url|href|src|action)=["']([^"']+)["']/gi,
    ];
    for (const p of patterns) {
        const matches = html.matchAll(p);
        for (const m of matches) {
            const v = m[1] || m[0];
            if (v && v.length > 3) eps.add(v);
        }
    }
    return [...eps];
}

// ==================== MAIN API: RIP ====================
app.post('/api/rip', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.json({ success: false, error: 'URL wajib diisi' });
    }
    
    const targetUrl = url.startsWith('http') ? url : `https://${url}`;
    const urlObj = new URL(targetUrl);
    const targetPath = urlObj.pathname || '/';
    
    const result = {
        success: false,
        url: targetUrl,
        timestamp: new Date().toISOString(),
        data: null,
        bypass: null,
        attempts: 0,
    };
    
    // Attempt 1: Normal
    try {
        const resp = await axios.get(targetUrl, {
            headers: buildHeaders('normal'),
            timeout: 15000,
            maxRedirects: 5,
            validateStatus: () => true,
        });
        
        if (resp.status === 200 && resp.data) {
            const html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
            const $ = cheerio.load(html);
            
            result.success = true;
            result.status = resp.status;
            result.data = {
                html: html.substring(0, 500000),
                ripped: ripHTML($, html),
                apiKeys: ripAPIKeys(html),
                endpoints: ripEndpoints(html),
            };
            result.bypass = 'none';
            result.attempts = 1;
            
            return res.json(result);
        }
    } catch(e) {}
    
    // Attempt 2+: Header bypass
    const bypassTypes = ["xff", "bot", "mobile", "cloudflare"];
    
    for (const btype of bypassTypes) {
        result.attempts++;
        try {
            const resp = await axios.get(targetUrl, {
                headers: buildHeaders(btype),
                timeout: 15000,
                maxRedirects: 5,
                validateStatus: () => true,
            });
            
            if (resp.status === 200 && resp.data) {
                const html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
                const $ = cheerio.load(html);
                
                result.success = true;
                result.status = resp.status;
                result.data = {
                    html: html.substring(0, 500000),
                    ripped: ripHTML($, html),
                    apiKeys: ripAPIKeys(html),
                    endpoints: ripEndpoints(html),
                };
                result.bypass = `header:${btype}`;
                
                return res.json(result);
            }
        } catch(e) {}
    }
    
    // Attempt 3: Path bypass
    const paths = pathVariations(targetPath);
    for (const path of paths.slice(0, 15)) {
        result.attempts++;
        const bypassUrl = `${urlObj.protocol}//${urlObj.host}${path}`;
        try {
            const resp = await axios.get(bypassUrl, {
                headers: buildHeaders('xff'),
                timeout: 15000,
                maxRedirects: 5,
                validateStatus: () => true,
            });
            
            if (resp.status === 200 && resp.data) {
                const html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
                const $ = cheerio.load(html);
                
                result.success = true;
                result.status = resp.status;
                result.data = {
                    html: html.substring(0, 500000),
                    ripped: ripHTML($, html),
                    apiKeys: ripAPIKeys(html),
                    endpoints: ripEndpoints(html),
                };
                result.bypass = `path:${path}`;
                
                return res.json(result);
            }
        } catch(e) {}
    }
    
    result.error = 'Tidak bisa mengakses URL setelah ' + result.attempts + ' percobaan bypass';
    res.json(result);
});

// ==================== API: DOWNLOAD ASSETS ====================
app.post('/api/download-assets', async (req, res) => {
    const { url, files } = req.body;
    
    if (!url || !files || !Array.isArray(files)) {
        return res.json({ success: false, error: 'URL dan files[] wajib diisi' });
    }
    
    const baseUrl = url.startsWith('http') ? url : `https://${url}`;
    const urlObj = new URL(baseUrl);
    const results = {};
    
    for (const file of files.slice(0, 30)) {
        if (!file || typeof file !== 'string') continue;
        if (file.startsWith('data:') || file.startsWith('#')) continue;
        
        const fileUrl = file.startsWith('http') ? file : `${urlObj.protocol}//${urlObj.host}${file.startsWith('/') ? '' : '/'}${file}`;
        try {
            const resp = await axios.get(fileUrl, {
                headers: buildHeaders('xff'),
                timeout: 10000,
                responseType: 'text',
                validateStatus: () => true,
                maxRedirects: 3,
            });
            
            results[file] = {
                success: resp.status === 200,
                status: resp.status,
                content: resp.status === 200 ? (resp.data?.substring(0, 100000) || '') : null,
                contentType: resp.headers['content-type'] || 'unknown',
            };
        } catch(e) {
            results[file] = { success: false, status: 0, error: e.message };
        }
    }
    
    res.json({ success: true, results });
});

// ==================== API: HEALTH ====================
app.get('/api', (req, res) => {
    res.json({
        name: 'SITEGHOST API v2',
        version: '2.0.0',
        author: 'SHADOWREAPER',
        endpoints: [
            'POST /api/rip - Bedah web + bypass WAF/404',
            'POST /api/download-assets - Download file CSS/JS eksternal',
            'GET /api - Info API',
        ]
    });
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`[SITEGHOST] http://localhost:${PORT}`));
      }
