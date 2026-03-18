# Grok2API Cloudflare Worker

这个 `cloudflare/` 子项目不再直连 `grok.com`，而是作为一层 **Cloudflare Worker 反向代理入口**：

```text
用户
  -> Cloudflare Worker
  -> 你部署的 chenyme/grok2api 后端
  -> grok.com
```

这样做的目标是：

- `chen` 当前主线是唯一真源
- Worker 只负责 Cloudflare 域名、HTTPS、边缘入口和透明转发
- 不再维护一套独立的旧 Worker 业务实现

## 需要的前提

你必须已经有一个可公网访问的 `chen` 后端地址，例如：

- `https://your-backend.example.com`
- `https://grok2api.onrender.com`
- `https://api.yourdomain.com`

Worker 会把所有请求转发到这个后端。

## 本地配置

`wrangler.toml` 中的核心变量：

```toml
[vars]
UPSTREAM_BASE_URL = "REPLACE_WITH_UPSTREAM_BASE_URL"
BUILD_SHA = "dev"
```

本地调试时，把 `UPSTREAM_BASE_URL` 改成你的后端地址即可。

## GitHub Actions 部署配置

仓库需要配置 3 个 Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_UPSTREAM_BASE_URL`

其中：

- `CLOUDFLARE_UPSTREAM_BASE_URL` 就是你主线后端的公网地址
- Worker 部署时会自动把它注入 `wrangler.ci.toml`

## 部署行为

当前 Worker 的行为非常简单：

- `/_worker/health`：查看 Worker 自己的健康状态
- 其他所有请求：透明代理到 `UPSTREAM_BASE_URL`

因此：

- 访问 `/admin/login` 时，实际会走你主线后端的管理页
- 访问 `/chat` 时，实际会走你主线后端的功能页
- 调 `/v1/*` 时，实际也会走你主线后端的 API

## 适用边界

这个 Worker 方案适合：

- 想保留 Cloudflare 域名入口
- 想把 `chen` 主线作为唯一能力来源
- 不想在 Worker 里重写 Grok reverse 能力

这个 Worker 方案不适合：

- 期望纯 Worker 独立运行全部 Grok reverse 逻辑
- 没有可公网访问的主线后端

## 校验

本地检查：

```bash
cd cloudflare
npm ci
npm run typecheck
```

部署后检查：

- `https://<你的worker域名>/_worker/health`
- `https://<你的worker域名>/admin/login`
- `https://<你的worker域名>/chat`
