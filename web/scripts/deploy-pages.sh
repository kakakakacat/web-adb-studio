#!/usr/bin/env bash
# 把前端部署到 Cloudflare Pages，API 留在 NAS（经 tunnel 出）。
#
# 拆分之后：
#   adb.kakacat.icu      → Cloudflare Pages（页面 / JS / CSS / scrcpy-server / bridge 下载）
#   api-adb.kakacat.icu  → tunnel → NAS（只有内网功能会被调用）
#
# 收益：匿名访客一个请求都不落到 NAS 上；NAS 或 tunnel 下线时站点照常可用，只是
# Server Files / Dino Admin 不可用。
#
#   ./deploy-pages.sh                                  # 用默认 API 地址
#   API_BASE=https://api-adb.kakacat.icu ./deploy-pages.sh
#   PROJECT=adb-studio ./deploy-pages.sh
#
# 需要 CLOUDFLARE_API_TOKEN（权限：Cloudflare Pages 编辑）和 CLOUDFLARE_ACCOUNT_ID。
set -euo pipefail
cd "$(dirname "$0")/.."

# 默认同源：/api/* 由 Cloudflare 的 Origin Rule 改写到 tunnel 主机名，页面本身在 Pages 上，
# 所以浏览器眼里始终只有一个 origin —— 不需要跨源、不需要 CORS、Access 的 cookie 也不用
# 操心 SameSite。只有把前端和 API 放在**不同主机名**时才需要设这个变量。
API_BASE="${API_BASE:-}"
PROJECT="${PROJECT:-adb-studio}"
BRIDGE_DIR="${BRIDGE_DIR:-../server/bridge-dist}"

# 两种凭据都行：环境变量里的 API token（CI 用），或者本机 `wrangler login` 留下的
# OAuth 配置。原来只认前者，于是一台已经登录过的开发机反而跑不了这个脚本。
WRANGLER_OAUTH="$HOME/Library/Preferences/.wrangler/config/default.toml"
[ -f "$WRANGLER_OAUTH" ] || WRANGLER_OAUTH="$HOME/.wrangler/config/default.toml"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ ! -f "$WRANGLER_OAUTH" ]; then
  echo "需要 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID，或者先跑一次 npx wrangler login" >&2
  exit 1
fi
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  : "${CLOUDFLARE_ACCOUNT_ID:?给了 token 就必须一起给 CLOUDFLARE_ACCOUNT_ID}"
fi

if [ ! -f public/scrcpy-server ]; then
  echo "public/scrcpy-server missing — 先跑 npm run assets" >&2
  exit 1
fi

echo "==> 构建（API_BASE=${API_BASE:-同源}）"
# VITE_API_BASE 是构建期注入的：Pages 上的静态包必须自己知道 API 在哪。
VITE_API_BASE="$API_BASE" npm run build

# bridge 二进制原来由后端在 /download 下提供。它们是纯静态文件，一起搬到 Pages，
# 免得为了下个 674KB 的中转程序去打扰 NAS。
if [ -d "$BRIDGE_DIR" ]; then
  echo "==> 带上 bridge 下载"
  mkdir -p dist/download
  cp "$BRIDGE_DIR"/* dist/download/
else
  echo "warn: $BRIDGE_DIR 不存在，页面里的桥接下载链接会 404" >&2
fi

# 内部主机名不能进公开产物。模式可配置：下游私有仓库把自己的内网域名填进来，
# 一旦某次改动把它写进了 bundle，这里会拒绝发布而不是等你在生产环境发现。
#   FORBID_IN_BUNDLE='[a-z0-9.-]*corp\.example\.com' ./deploy-pages.sh
if [ -n "${FORBID_IN_BUNDLE:-}" ]; then
  echo "==> 检查产物里有没有 ${FORBID_IN_BUNDLE}"
  if grep -rlE "$FORBID_IN_BUNDLE" dist/assets/ >/dev/null 2>&1; then
    echo "error: 产物里出现了不该公开的主机名，拒绝发布" >&2
    grep -ohE "$FORBID_IN_BUNDLE" dist/assets/* | sort -u | head >&2
    exit 1
  fi
fi

echo "==> 上传到 Pages 项目 ${PROJECT}"
npx --yes wrangler@latest pages deploy dist \
  --project-name "$PROJECT" \
  --branch main \
  --commit-dirty=true

cat <<EOF

部署完成。同源架构下 Cloudflare 侧需要一条 Origin Rule（只配一次）：

  规则：如果 URI 路径以 /api/ 开头 → 覆盖 DNS 记录为 api-adb.kakacat.icu

  这条规则让 adb.kakacat.icu/api/* 走到 tunnel（NAS），其余路径仍由 Pages 提供。
  Host 头保持 adb.kakacat.icu，cloudflared 的 ingress 里有这个主机名，所以能匹配上。

验证：
  curl -s -o /dev/null -w '%{http_code}\n' https://adb.kakacat.icu/api/health          # 200
  curl -s -o /dev/null -w '%{http_code}\n' https://adb.kakacat.icu/api/dino/servers    # 302 → Access
  curl -s -o /dev/null -w '%{http_code}\n' https://adb.kakacat.icu/                    # 200，来自 Pages
EOF
