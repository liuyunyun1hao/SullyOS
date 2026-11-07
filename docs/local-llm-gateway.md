# 本地 LLM 网关接入（同源代理改写）

> 适用场景：把对话 API 指到跑在本机的 OpenAI 兼容网关（自建网关、opencode zen、各类
> BaseHTTP/自写转发层），例如 `http://127.0.0.1:9355/zen/go/v1`。

## 为什么需要这一层

本地网关在浏览器侧有两个用户自己解决不了的死结：

1. **CORS 预检缺失**。跨源 POST（JSON body + `Authorization` 头）会先触发 OPTIONS 预检；
   很多本地网关（Python BaseHTTP 一类）对 OPTIONS 直接回 `501 Unsupported method`，也不带
   CORS 头——预检失败，浏览器连真正的请求都不发。GET `/models` 是简单请求可能能通，
   这会造成「模型列表能拉到、聊天必失败」的假象，非常误导排查。
2. **混合内容**。页面部署在 https 上时，部分浏览器（如 Firefox）会拦 http loopback 请求；
   Chrome 虽把 loopback 当可信来源放行，但这不是跨浏览器可依赖的行为。

用户改不了网关，所以唯一通用解法是**同源反向代理**：本地服务在页面同源上镜像网关路径，
页面把请求改写到同源路径发出去——同源请求没有预检、没有 CORS、没有混合内容问题。

## 三件套机制

| 层 | 位置 | 职责 |
|---|---|---|
| 页面改写 | `utils/localLlmProxy.ts`（挂在 `context/OSContext.tsx` 的统一 fetch 出口） | 拉取 descriptor，把用户配置的 loopback 网关 URL 改写成同源代理路径 |
| 静态服务代理 | `scripts/local-static-server.cjs`（`open-local-web.bat` 起的就是它） | 同源 `<prefix>/*` 镜像转发到网关；在 `/__local_llm_proxy.json` 发布 descriptor |
| 开发代理 | `vite.config.ts`（`server.proxy` + descriptor 中间件） | `pnpm dev` 下同款镜像转发 + descriptor |

语义要点（改任何一层前先对齐这三条）：

- **路径镜像，不是挂载**：`/zen/go/v1/models` → 网关同路径。改写只换 origin，路径与查询串
  原样保留。descriptor 里的 `prefix` 是「网关自己路径的前缀」，不是要剥掉的挂载点。
- **只在本地页面启用**：页面 origin 是 http loopback（`localhost` / `127.0.0.0/8` / `[::1]`）
  才会去拉 descriptor；云端部署没有这个文件，行为零变化。
- **只代理 loopback 目标**：用户配置的 URL 不是 loopback（云 API）一律原样直发，
  绝不经本地服务转发。descriptor 里的 `target` 也强制必须是 loopback。

## 用户怎么用

1. 用 `build-and-open-local-web.bat`（或 `pnpm build` + `open-local-web.bat`）从本地起页面，
   或开发时 `pnpm dev`。
2. 设置页对话 API 的 URL 原样填网关地址，如 `http://127.0.0.1:9355/zen/go/v1`；
   Key 填网关要的凭证。**不需要**把 URL 改成 4173 端口——页面会自动改写。
3. 「获取模型列表」与聊天走同一出口，都会经同源代理；DevTools 里看到的实际请求是
   `http://127.0.0.1:<页面端口>/zen/go/v1/...`，属预期行为。

「API 调用记录」、系统日志与网络诊断记录的仍是**用户配置的原始 URL**——排查时看到的
必须和设置页里填的一致。

## 服务端配置（环境变量）

`local-static-server.cjs` 与 `vite.config.ts` 同名同义：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_PROXY_TARGET` | `http://127.0.0.1:9355` | 网关 origin；设为空字符串关闭代理（descriptor 会 404，页面按直发处理） |
| `LLM_PROXY_PREFIX` | `/zen` | 同源镜像路径前缀；别和 dist 里的静态路径撞车 |
| `LLM_PROXY_ROUTES` | 未设 | 多路由 JSON 数组，如 `[{"prefix":"/zen","target":"http://127.0.0.1:9355"},{"prefix":"/v1","target":"http://127.0.0.1:1234"}]`；设置后覆盖单路由变量 |

注意：

- `target` 一律只允许 loopback。想让局域网设备访问请自行做反向代理，不要把本服务
  `HOST=0.0.0.0` 暴露出去——那会把你的本地网关（连同它接受的凭证）开放给整个局域网。
- 代理是**流式透传**（请求体、响应体都走管道，客户端断开会连带取消上游请求），
  SSE 长回复不会被攒包掐断；上游挂了回 502，并把网关自己的错误码/错误体原样透传。

## 排查

| 症状 | 含义 / 下一步 |
|---|---|
| 请求仍是 `http://127.0.0.1:9355/...` 直发 | 页面不是 http loopback 起的（或 descriptor 拉取失败被缓存）。先确认访问地址是 `127.0.0.1:<端口>` / `localhost:<端口>` |
| 手动 `curl http://127.0.0.1:4173/__local_llm_proxy.json` 404 | 服务没配代理（`LLM_PROXY_TARGET=''` 或前缀不合法）。按上表配好后重启 |
| 经代理 502 | 网关没起 / 端口不对。`curl http://127.0.0.1:9355/zen/go/v1/models` 直接验证网关 |
| 401/403 透传 | 网关鉴权问题，凭证填设置页 Key 字段；错误体是网关原话 |
| descriptor 只在会话内缓存一次 | 拉取失败后本会话不再重试，改完服务配置要刷新页面 |

## 测试

- 单测：`pnpm vitest run utils/localLlmProxy.test.ts`（改写规则、descriptor 校验、缓存与降级）。
- 冒烟：对一个 mock「OPTIONS 501 网关」验证 descriptor / 静态不受影响 / GET 透传 /
  401 透传 / SSE 不攒包 / 上游 502 的脚本不在仓库里（临时验证用），改代理转发逻辑时
  按 `scripts/local-static-server.cjs` 的语义手写对照即可。
