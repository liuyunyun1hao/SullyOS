import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    parseLocalLlmProxyDescriptor,
    matchLocalProxyRoute,
    rewriteUrlForLocalLlmProxy,
    loadLocalLlmProxyDescriptor,
    resetLocalLlmProxyCacheForTests,
    LOCAL_LLM_PROXY_DESCRIPTOR_URL,
    isLoopbackHostname,
    type LocalLlmProxyDescriptor,
} from './localLlmProxy';

const PAGE = 'http://127.0.0.1:4173';
const DESCRIPTOR: LocalLlmProxyDescriptor = {
    routes: [{ prefix: '/zen', target: 'http://127.0.0.1:9355' }],
};

describe('isLoopbackHostname', () => {
    it('接受 localhost、127.0.0.0/8 与 [::1]', () => {
        expect(isLoopbackHostname('localhost')).toBe(true);
        expect(isLoopbackHostname('LOCALHOST')).toBe(true);
        expect(isLoopbackHostname('127.0.0.1')).toBe(true);
        expect(isLoopbackHostname('127.1.2.3')).toBe(true);
        expect(isLoopbackHostname('[::1]')).toBe(true);
    });

    it('拒绝外网主机与 127 段变体写法', () => {
        expect(isLoopbackHostname('example.com')).toBe(false);
        expect(isLoopbackHostname('0.0.0.0')).toBe(false);
        expect(isLoopbackHostname('127.0.0.1.evil.com')).toBe(false);
        expect(isLoopbackHostname('')).toBe(false);
    });
});

describe('parseLocalLlmProxyDescriptor', () => {
    it('保留合法路由', () => {
        expect(parseLocalLlmProxyDescriptor(DESCRIPTOR)).toEqual(DESCRIPTOR);
    });

    it('丢弃缺字段 / 非 loopback target / 坏 prefix 的路由', () => {
        expect(parseLocalLlmProxyDescriptor({
            routes: [
                { prefix: '/zen', target: 'http://127.0.0.1:9355' },
                { prefix: 'zen', target: 'http://127.0.0.1:9355' },          // 无前导斜杠
                { prefix: '/', target: 'http://127.0.0.1:9355' },            // 根路径会劫持静态资源
                { prefix: '/zen/' },                                          // 缺 target
                { prefix: '/v1', target: 'https://api.example.com' },        // 非 loopback：云端 API 不得经本地代理
                { prefix: '/v1', target: 'not a url' },
                null,
            ],
        })).toEqual(DESCRIPTOR);
    });

    it('整体不合法时返回 null', () => {
        expect(parseLocalLlmProxyDescriptor(null)).toBeNull();
        expect(parseLocalLlmProxyDescriptor({})).toBeNull();
        expect(parseLocalLlmProxyDescriptor({ routes: [] })).toBeNull();
        expect(parseLocalLlmProxyDescriptor({ routes: 'nope' })).toBeNull();
        expect(parseLocalLlmProxyDescriptor({ routes: [{ prefix: '/a', target: 'https://api.example.com' }] })).toBeNull();
    });
});

describe('matchLocalProxyRoute', () => {
    it('命中的路由改写为同源路径，路径与查询串原样保留', () => {
        expect(matchLocalProxyRoute('http://127.0.0.1:9355/zen/go/v1/chat/completions', PAGE, DESCRIPTOR))
            .toBe('http://127.0.0.1:4173/zen/go/v1/chat/completions');
        expect(matchLocalProxyRoute('http://127.0.0.1:9355/zen/go/v1/models?x=1&y=2', PAGE, DESCRIPTOR))
            .toBe('http://127.0.0.1:4173/zen/go/v1/models?x=1&y=2');
        expect(matchLocalProxyRoute('http://127.0.0.1:9355/zen', PAGE, DESCRIPTOR))
            .toBe('http://127.0.0.1:4173/zen');
    });

    it('localhost / 127.0.0.1 / [::1] 是同一台机器的等价写法，端口一致即同一网关', () => {
        expect(matchLocalProxyRoute('http://localhost:9355/zen/go/v1/models', PAGE, DESCRIPTOR))
            .toBe('http://127.0.0.1:4173/zen/go/v1/models');
        expect(matchLocalProxyRoute('http://[::1]:9355/zen/go/v1/models', PAGE, DESCRIPTOR))
            .toBe('http://127.0.0.1:4173/zen/go/v1/models');
    });

    it('端口不同 / 前缀只有字面前缀相似时不改写', () => {
        expect(matchLocalProxyRoute('http://127.0.0.1:9356/zen/go/v1/models', PAGE, DESCRIPTOR)).toBeNull();
        expect(matchLocalProxyRoute('http://127.0.0.1:9355/zenith/go/v1/models', PAGE, DESCRIPTOR)).toBeNull();
        expect(matchLocalProxyRoute('http://127.0.0.1:9355/go/v1/models', PAGE, DESCRIPTOR)).toBeNull();
    });

    it('非 loopback 目标（云端 API）绝不改写', () => {
        expect(matchLocalProxyRoute('https://api.deepseek.com/chat/completions', PAGE, DESCRIPTOR)).toBeNull();
        expect(matchLocalProxyRoute('http://192.168.1.5:9355/zen/go/v1/models', PAGE, DESCRIPTOR)).toBeNull();
    });

    it('页面不在 http loopback 上时不动任何 URL（云端部署行为零变化）', () => {
        expect(matchLocalProxyRoute('http://127.0.0.1:9355/zen/go/v1/models', 'https://sully.example.com', DESCRIPTOR)).toBeNull();
        expect(matchLocalProxyRoute('http://127.0.0.1:9355/zen/go/v1/models', 'http://192.168.1.5:5173', DESCRIPTOR)).toBeNull();
        expect(matchLocalProxyRoute('http://127.0.0.1:9355/zen/go/v1/models', 'capacitor://localhost', DESCRIPTOR)).toBeNull();
    });

    it('目标与页面同源时不改写', () => {
        expect(matchLocalProxyRoute('http://127.0.0.1:4173/zen/go/v1/models', PAGE, DESCRIPTOR)).toBeNull();
    });

    it('解析不了输入时返回 null 而不是抛错', () => {
        expect(matchLocalProxyRoute('not a url', PAGE, DESCRIPTOR)).toBeNull();
        expect(matchLocalProxyRoute('http://127.0.0.1:9355/zen/go/v1/models', 'not a url', DESCRIPTOR)).toBeNull();
    });

    it('https 页面/https 网关不在本机制范围内', () => {
        const httpsDescriptor: LocalLlmProxyDescriptor = { routes: [{ prefix: '/zen', target: 'https://127.0.0.1:9355' }] };
        // 页面是 https：说明不是本地静态服务在提供，descriptor 也不该存在
        expect(matchLocalProxyRoute('https://127.0.0.1:9355/zen/go/v1/models', 'https://127.0.0.1:4173', httpsDescriptor)).toBeNull();
        // 页面是 http、网关写 https：协议不一致，描述符声明的是 http 网关，原样直发
        expect(matchLocalProxyRoute('https://127.0.0.1:9355/zen/go/v1/models', PAGE, DESCRIPTOR)).toBeNull();
    });
});

describe('rewriteUrlForLocalLlmProxy', () => {
    beforeEach(() => {
        resetLocalLlmProxyCacheForTests();
        // node 测试环境没有 location：模拟「页面由本地静态服务提供」的 origin。
        (globalThis as any).location = { origin: 'http://127.0.0.1:4173' };
    });

    afterEach(() => {
        delete (globalThis as any).location;
    });

    const makeFetcher = (descriptor: unknown, status = 200) => {
        const fetchImpl = vi.fn(async () => new Response(
            typeof descriptor === 'string' ? descriptor : JSON.stringify(descriptor),
            { status, headers: { 'content-type': 'application/json' } },
        ));
        return fetchImpl;
    };

    it('拉 descriptor 一次并缓存，改写后续请求', async () => {
        const fetchImpl = makeFetcher(DESCRIPTOR);
        const first = await rewriteUrlForLocalLlmProxy('http://127.0.0.1:9355/zen/go/v1/chat/completions', fetchImpl as unknown as typeof fetch);
        expect(first).toBe('http://127.0.0.1:4173/zen/go/v1/chat/completions');
        const second = await rewriteUrlForLocalLlmProxy('http://127.0.0.1:9355/zen/go/v1/models', fetchImpl as unknown as typeof fetch);
        expect(second).toBe('http://127.0.0.1:4173/zen/go/v1/models');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledWith(LOCAL_LLM_PROXY_DESCRIPTOR_URL, expect.objectContaining({ method: 'GET' }));
    });

    it('descriptor 404（云端部署）→ 原样直发且不再重复探测', async () => {
        const fetchImpl = makeFetcher('not found', 404);
        const first = await rewriteUrlForLocalLlmProxy('http://127.0.0.1:9355/zen/go/v1/models', fetchImpl as unknown as typeof fetch);
        expect(first).toBe('http://127.0.0.1:9355/zen/go/v1/models');
        await rewriteUrlForLocalLlmProxy('http://127.0.0.1:9355/zen/go/v1/chat/completions', fetchImpl as unknown as typeof fetch);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('descriptor 返回不合法 JSON → 原样直发', async () => {
        const fetchImpl = makeFetcher({ routes: [{ prefix: '/zen', target: 'https://api.example.com' }] });
        const result = await rewriteUrlForLocalLlmProxy('http://127.0.0.1:9355/zen/go/v1/models', fetchImpl as unknown as typeof fetch);
        expect(result).toBe('http://127.0.0.1:9355/zen/go/v1/models');
    });

    it('descriptor 拉取抛错 → 原样直发且不重复探测', async () => {
        const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
        const result = await rewriteUrlForLocalLlmProxy('http://127.0.0.1:9355/zen/go/v1/models', fetchImpl as unknown as typeof fetch);
        expect(result).toBe('http://127.0.0.1:9355/zen/go/v1/models');
        await rewriteUrlForLocalLlmProxy('http://127.0.0.1:9355/zen/go/v1/models', fetchImpl as unknown as typeof fetch);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('非 loopback 目标（云端 API）绝不触发 descriptor 拉取', async () => {
        const fetchImpl = makeFetcher(DESCRIPTOR);
        const result = await rewriteUrlForLocalLlmProxy('https://api.deepseek.com/chat/completions', fetchImpl as unknown as typeof fetch);
        expect(result).toBe('https://api.deepseek.com/chat/completions');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('loadLocalLlmProxyDescriptor 成功后同会话直接返回缓存', async () => {
        const fetchImpl = makeFetcher(DESCRIPTOR);
        const first = await loadLocalLlmProxyDescriptor(fetchImpl as unknown as typeof fetch);
        const second = await loadLocalLlmProxyDescriptor(fetchImpl as unknown as typeof fetch);
        expect(first).toEqual(DESCRIPTOR);
        expect(second).toEqual(DESCRIPTOR);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('没有 location（SSR/worker 等非浏览器环境）→ 原样直发且不探测', async () => {
        delete (globalThis as any).location;
        const fetchImpl = makeFetcher(DESCRIPTOR);
        const result = await rewriteUrlForLocalLlmProxy('http://127.0.0.1:9355/zen/go/v1/models', fetchImpl as unknown as typeof fetch);
        expect(result).toBe('http://127.0.0.1:9355/zen/go/v1/models');
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
