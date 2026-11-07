const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || 'dist');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4173);

// --- 本地 LLM 网关反向代理（语义与页面侧 utils/localLlmProxy.ts 配对，详见 docs/local-llm-gateway.md）---
// 把同源 <prefix>/* 镜像转发到本地网关 origin 的同路径（路径原样保留，不做挂载剥离），
// 让浏览器页面 → 网关变成同源请求，绕开本地网关常见的 CORS 预检缺失（OPTIONS 501）。
// 页面通过 GET /__local_llm_proxy.json 感知这些路由，再把用户配置的 loopback URL 改写成同源路径。
//
// 环境变量：
//   LLM_PROXY_TARGET  网关 origin，默认 http://127.0.0.1:9355；设为空字符串可关闭代理
//   LLM_PROXY_PREFIX  同源镜像路径前缀，默认 /zen
//   LLM_PROXY_ROUTES  多路由配置，JSON 数组（如 [{"prefix":"/zen","target":"http://127.0.0.1:9355"}]），
//                     设置后覆盖上面两个单路由变量；target 一律只允许 loopback
const DEFAULT_LLM_PROXY_PREFIX = '/zen';
const DEFAULT_LLM_PROXY_TARGET = 'http://127.0.0.1:9355';
const DESCRIPTOR_PATH = '/__local_llm_proxy.json';

const isLoopbackHostname = (hostname) => {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
};

const normalizeProxyPrefix = (value) => {
  const prefix = String(value || '').replace(/\/+$/, '');
  return prefix.startsWith('/') && prefix !== '/' ? prefix : null;
};

const normalizeProxyTarget = (value) => {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!isLoopbackHostname(url.hostname)) return null;
    return `${url.protocol}//${url.host}`;
  } catch { return null; }
};

function readProxyRoutes() {
  if (process.env.LLM_PROXY_ROUTES) {
    try {
      const parsed = JSON.parse(process.env.LLM_PROXY_ROUTES);
      if (Array.isArray(parsed)) {
        const routes = parsed
          .map((item) => ({
            prefix: normalizeProxyPrefix(item && item.prefix),
            target: normalizeProxyTarget(item && item.target),
          }))
          .filter((route) => route.prefix && route.target);
        if (routes.length > 0) return routes;
      }
    } catch { /* 格式错误落到下面单路由默认 */ }
    console.warn('LLM_PROXY_ROUTES 解析失败或没有可用路由，忽略');
  }
  const targetEnv = process.env.LLM_PROXY_TARGET;
  const target = targetEnv === undefined ? DEFAULT_LLM_PROXY_TARGET : String(targetEnv || '');
  if (!target) return [];
  const prefix = normalizeProxyPrefix(process.env.LLM_PROXY_PREFIX || DEFAULT_LLM_PROXY_PREFIX);
  const normalizedTarget = normalizeProxyTarget(target);
  if (!prefix || !normalizedTarget) {
    console.warn('LLM_PROXY_PREFIX / LLM_PROXY_TARGET 不合法，本地代理未启用');
    return [];
  }
  return [{ prefix, target: normalizedTarget }];
}

const proxyRoutes = readProxyRoutes();

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function resolvePath(urlPath) {
  const relativePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const fullPath = path.resolve(root, relativePath);
  return fullPath.startsWith(root) ? fullPath : null;
}

function sendFile(filePath, res) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Server error');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    });
    res.end(data);
  });
}

// 镜像转发：path+query 原样、逐头透传（去掉逐跳头与 host）、请求体与响应体都走流式管道
// （SSE 攒包会把长回复掐成半截），客户端中途断开时连带取消上游请求。
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

function proxyToRoute(req, res, route) {
  const target = new URL(route.target);
  const mod = target.protocol === 'https:' ? https : http;
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  headers.host = target.host;
  const upstream = mod.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
    },
    (upstreamRes) => {
      const outHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (HOP_BY_HOP_HEADERS.has(name)) continue;
        outHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, outHeaders);
      upstreamRes.pipe(res);
    }
  );
  upstream.on('error', (error) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`本地网关转发失败（${route.target}）：${error.message}`);
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

function sendDescriptor(res) {
  if (proxyRoutes.length === 0) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No local LLM proxy routes');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ routes: proxyRoutes }));
}

const pathHasPrefix = (urlPath, prefix) =>
  urlPath === prefix || urlPath.startsWith(`${prefix}/`);

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // 页面侧 utils/localLlmProxy.ts 的 descriptor：拉不到（404）页面就会记住「本会话无代理」。
  if (urlPath === DESCRIPTOR_PATH) {
    sendDescriptor(res);
    return;
  }

  const route = proxyRoutes.find((item) => pathHasPrefix(urlPath, item.prefix));
  if (route) {
    proxyToRoute(req, res, route);
    return;
  }

  const requestedPath = resolvePath(urlPath);

  if (!requestedPath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(requestedPath, (statError, stats) => {
    if (!statError && stats.isFile()) {
      sendFile(requestedPath, res);
      return;
    }

    sendFile(path.join(root, 'index.html'), res);
  });
});

server.listen(port, host, () => {
  console.log(`Listening on http://${host}:${port}`);
  console.log(`Serving ${root}`);
  if (proxyRoutes.length > 0) {
    for (const route of proxyRoutes) console.log(`LLM proxy: ${route.prefix}/* -> ${route.target}/*`);
    console.log(`Descriptor: http://${host}:${port}${DESCRIPTOR_PATH}`);
  } else {
    console.log('LLM proxy: disabled');
  }
});
