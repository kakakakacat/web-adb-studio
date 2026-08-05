#!/usr/bin/env bash
# 把 URL 主动推给 IndexNow（Bing / Yandex / Seznam / Naver 共用一个协议）。
#
# 为什么用它：Google 没有等价的免账号接口，但 Bing 系有 —— 不需要注册、不需要验证
# 站点所有权，只要证明你能在这个域上放文件。凭证就是 public/<key>.txt，内容是 key 本身，
# IndexNow 会来读它。
#
#   ./scripts/submit-indexnow.sh                       # 推首页
#   ./scripts/submit-indexnow.sh /new-page /other      # 推指定路径
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${HOST:-adb.kakacat.icu}"
# key 文件就是 public/ 下那个唯一的 32 位 hex .txt
KEY="$(ls public/ | grep -E '^[0-9a-f]{32}\.txt$' | head -1 | sed 's/\.txt$//')"
[ -n "$KEY" ] || { echo "error: public/ 下没有 IndexNow key 文件（<32位hex>.txt）" >&2; exit 1; }

# 先确认线上能读到 key，否则提交会被静默忽略
code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "https://${HOST}/${KEY}.txt")"
[ "$code" = "200" ] || { echo "error: https://${HOST}/${KEY}.txt 返回 $code —— key 文件没部署上去" >&2; exit 1; }

paths=("$@")
[ ${#paths[@]} -eq 0 ] && paths=("/")

for p in "${paths[@]}"; do
  url="https://${HOST}${p}"
  enc="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$url")"
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 30 "https://api.indexnow.org/indexnow?url=${enc}&key=${KEY}")"
  # 200 = 已接受，202 = 已接受待验证 key，两者都算成功
  case "$code" in
    200|202) echo "  ok    $url ($code)" ;;
    *)       echo "   失败  $url ($code)" >&2 ;;
  esac
done

cat <<'NOTE'

Google 没有免账号的提交接口，只能走 Search Console（需要登录）：
  1. https://search.google.com/search-console 添加「网域」资源 adb.kakacat.icu
  2. 它给一段 TXT 记录，加到 Cloudflare DNS
  3. 验证通过后在「站点地图」里提交 sitemap.xml
NOTE
