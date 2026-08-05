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

API_BASE="${API_BASE:-https://api-adb.kakacat.icu}"
PROJECT="${PROJECT:-adb-studio}"
BRIDGE_DIR="${BRIDGE_DIR:-../server/bridge-dist}"

: "${CLOUDFLARE_API_TOKEN:?需要 CLOUDFLARE_API_TOKEN（Pages 编辑权限）}"
: "${CLOUDFLARE_ACCOUNT_ID:?需要 CLOUDFLARE_ACCOUNT_ID}"

if [ ! -f public/scrcpy-server ]; then
  echo "public/scrcpy-server missing — 先跑 npm run assets" >&2
  exit 1
fi

echo "==> 构建（API_BASE=${API_BASE}）"
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

部署完成。第一次上线还需要在 Cloudflare 侧做三件事（只做一次）：

  1. Pages 项目绑定自定义域 adb.kakacat.icu
     —— 这会把该主机名的 DNS 从 tunnel 切到 Pages，切换前请确认第 2 步已经就绪。
  2. api-adb.kakacat.icu 指向 tunnel（NAS 的 cloudflared 加一条 ingress），
     并把 Cloudflare Access application 的主机名从 adb.kakacat.icu 改到
     api-adb.kakacat.icu（路径保持 /api/auth、/api/remote、/api/dino）。
  3. NAS 上给后端加环境变量，否则跨源请求会被 CORS 拦掉：
       ADBSTUDIO_ALLOWED_ORIGINS=https://adb.kakacat.icu

验证：
  curl -s https://api-adb.kakacat.icu/api/health          # 200，公开
  curl -s -o /dev/null -w '%{http_code}' https://api-adb.kakacat.icu/api/dino/servers  # 302 → Access
  浏览器打开 https://adb.kakacat.icu ，登录后 Server Files / Dino Admin 应该可用
EOF
