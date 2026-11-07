// 本地 LLM 网关的同源代理改写 —— 详见 docs/local-llm-gateway.md。
//
// 背景：本地/自建网关（OpenAI 兼容网关、opencode zen、各类自写 BaseHTTP 网关等）在浏览器侧
// 有两个用户自己解决不了的死结：
//   1) 网关经常没实现 CORS 预检（Python BaseHTTP 对 OPTIONS 直接 501），跨源 POST
//      （JSON body + Authorization 头）必被预检拦死——哪怕 GET /models 能通；
//   2) 页面部署在 https 上时，部分浏览器还会拦 http loopback 的混合内容。
// 用户改不了网关，所以唯一通用解法是「同源反向代理」：本地服务（scripts/local-static-server.cjs
// / vite dev）在页面同源上镜像网关路径（默认 /zen → http://127.0.0.1:9355），并通过
// /__local_llm_proxy.json descriptor 告诉页面有哪些路由。页面在统一 fetch 出口把用户配置的
// loopback 网关 URL 改写成同源路径，浏览器看到的变成同源请求，预检、CORS、混合内容全部消失。
//
// 约束（测试里都有对应用例）：
//   - 只在页面自身由 http loopback 服务时启用（本地起的页面）；云端部署拉不到 descriptor，
//     行为零变化；
//   - 只改写「目标也是 loopback」的 URL；普通云端 API 一律原样直发，绝不经本地服务转发；
//   - 改写只换 origin：路径与查询串原样保留（/zen/go/v1/... → 同源 /zen/go/v1/...），
//     与服务端代理的「路径镜像」语义一一对应；
//   - descriptor 拉不到/不合法 → 记一次失败，本会话不再改写，URL 原样直发。

export interface LocalLlmProxyRoute {
    /** 同源镜像的路径前缀，如 /zen。同时也是网关自己路径的前缀（镜像而非挂载）。 */
    prefix: string;
    /** 网关 origin，如 http://127.0.0.1:9355。只允许 loopback 目标参与改写。 */
    target: string;
}

export interface LocalLlmProxyDescriptor {
    routes: LocalLlmProxyRoute[];
}

/** descriptor 的同源地址，由 local-static-server / vite dev 提供；云端静态部署没有这个文件。 */
export const LOCAL_LLM_PROXY_DESCRIPTOR_URL = '/__local_llm_proxy.json';
/** descriptor 拉取超时：本地文件正常是毫秒级，超时说明没有代理能力，不值得让对话请求等它。 */
export const LOCAL_LLM_PROXY_DESCRIPTOR_TIMEOUT_MS = 1500;

const safeUrl = (value: string): URL | null => {
    try { return new URL(value); } catch { return null; }
};

/** 127.0.0.0/8 全段 + localhost + ::1。只用于「要不要走本地代理」的判断，不会当安全边界。 */
export const isLoopbackHostname = (hostname: string): boolean => {
    const host = hostname.toLowerCase();
    return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
};

const normalizePrefix = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const prefix = value.replace(/\/+$/, '');
    if (!prefix.startsWith('/') || prefix === '/') return null;
    return prefix;
};

const normalizeTarget = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const url = safeUrl(value);
    if (!url || !isLoopbackHostname(url.hostname)) return null;
    return `${url.protocol}//${url.host}`;
};

/** descriptor 非用户输入，但仍是外部数据：逐条校验，坏的丢掉，一条都不剩就当没有。 */
export const parseLocalLlmProxyDescriptor = (raw: unknown): LocalLlmProxyDescriptor | null => {
    const routesValue = (raw as any)?.routes;
    if (!Array.isArray(routesValue)) return null;
    const routes: LocalLlmProxyRoute[] = [];
    for (const item of routesValue) {
        const prefix = normalizePrefix(item?.prefix);
        const target = normalizeTarget(item?.target);
        if (prefix && target) routes.push({ prefix, target });
    }
    return routes.length > 0 ? { routes } : null;
};

/** prefix 按 path segment 匹配：/zen 匹配 /zen 与 /zen/...，不匹配 /zenith。 */
const pathHasPrefix = (pathname: string, prefix: string): boolean =>
    pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * 纯匹配逻辑：返回改写后的同源 URL；不满足改写条件返回 null。
 * pageOrigin 是页面自身 origin（http loopback 才有意义）；url 是用户配置的目标 URL。
 */
export const matchLocalProxyRoute = (url: string, pageOrigin: string, descriptor: LocalLlmProxyDescriptor): string | null => {
    const page = safeUrl(pageOrigin);
    const target = safeUrl(url);
    if (!page || !target) return null;
    if (page.protocol !== 'http:' || !isLoopbackHostname(page.hostname)) return null;
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    if (!isLoopbackHostname(target.hostname)) return null;
    if (target.origin === page.origin) return null;
    for (const route of descriptor.routes) {
        const routeTarget = safeUrl(route.target);
        if (!routeTarget) continue;
        // 回环等价：localhost / 127.0.0.1 / [::1] 是同一台机器的自然写法，端口一致即同一网关。
        // descriptor 里的 target 一定是 loopback（normalizeTarget 校验过），这里只需协议 + 端口对齐。
        if (routeTarget.protocol !== target.protocol) continue;
        if (routeTarget.port !== target.port) continue;
        if (!pathHasPrefix(target.pathname, route.prefix)) continue;
        return `${page.origin}${target.pathname}${target.search}${target.hash}`;
    }
    return null;
};

// --- 会话级 descriptor 缓存（页面生命周期内只拉一次；失败也只记一次） ---

type DescriptorState = 'idle' | 'unavailable' | 'ready';
let descriptorState: DescriptorState = 'idle';
let cachedDescriptor: LocalLlmProxyDescriptor | null = null;
let pendingLoad: Promise<LocalLlmProxyDescriptor | null> | null = null;

/** 测试专用：清空会话缓存。 */
export const resetLocalLlmProxyCacheForTests = (): void => {
    descriptorState = 'idle';
    cachedDescriptor = null;
    pendingLoad = null;
};

export const loadLocalLlmProxyDescriptor = (fetchImpl: typeof fetch = globalThis.fetch): Promise<LocalLlmProxyDescriptor | null> => {
    if (descriptorState === 'ready') return Promise.resolve(cachedDescriptor);
    if (descriptorState === 'unavailable') return Promise.resolve(null);
    if (pendingLoad) return pendingLoad;
    pendingLoad = (async () => {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), LOCAL_LLM_PROXY_DESCRIPTOR_TIMEOUT_MS);
            try {
                const response = await fetchImpl(LOCAL_LLM_PROXY_DESCRIPTOR_URL, {
                    method: 'GET',
                    headers: { accept: 'application/json' },
                    cache: 'no-store',
                    signal: controller.signal,
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const descriptor = parseLocalLlmProxyDescriptor(await response.json());
                if (!descriptor) throw new Error('invalid descriptor');
                cachedDescriptor = descriptor;
                descriptorState = 'ready';
                return descriptor;
            } finally {
                clearTimeout(timer);
            }
        } catch {
            // 云端部署没有这个文件（404）、或本地服务没开代理：都视为「本会话无代理」，
            // 之后不再为每个请求重复探测。
            descriptorState = 'unavailable';
            return null;
        } finally {
            pendingLoad = null;
        }
    })();
    return pendingLoad;
};

const currentPageOrigin = (): string | null => {
    try {
        if (typeof location === 'undefined') return null;
        return location.origin;
    } catch { return null; }
};

/**
 * OSContext 统一 fetch 出口的改写入口：
 * 输入用户配置的请求 URL，能改写就返回同源代理 URL，否则原样返回。
 * fast path（页面非 http loopback、目标非 loopback、同源）不会触发任何网络请求。
 * 传 fetchImpl 是为了用未打补丁的 originalFetch 拉 descriptor，避免绕回本出口。
 */
export const rewriteUrlForLocalLlmProxy = async (url: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<string> => {
    const pageOrigin = currentPageOrigin();
    if (!pageOrigin) return url;
    const target = safeUrl(url);
    if (!target || !isLoopbackHostname(target.hostname)) return url;
    if (target.origin === pageOrigin) return url;
    const descriptor = await loadLocalLlmProxyDescriptor(fetchImpl);
    if (!descriptor) return url;
    return matchLocalProxyRoute(url, pageOrigin, descriptor) ?? url;
};
