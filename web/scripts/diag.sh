#!/usr/bin/env bash
# 读诊断报告。
#
#   ./scripts/diag.sh list [条数]        最近的报告（一行一条）
#   ./scripts/diag.sh get <id>          某一条的正文
#   ./scripts/diag.sh serial <序列号>    只看某台设备的
#   ./scripts/diag.sh stats             占用量与配额
#
# token 从 $DIAG_TOKEN 或 ~/.adbstudio-diag-token 读（600）。它是 Pages 项目的加密
# 变量，不在仓库里：
#   npx wrangler pages secret put DIAG_TOKEN --project-name adb-studio
set -euo pipefail

SITE="${DIAG_SITE:-https://adb.kakacat.icu}"
TOKEN_FILE="${DIAG_TOKEN_FILE:-$HOME/.adbstudio-diag-token}"
if [ -z "${DIAG_TOKEN:-}" ] && [ -f "$TOKEN_FILE" ]; then
  DIAG_TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"
fi
: "${DIAG_TOKEN:?设置 DIAG_TOKEN，或把它写进 $TOKEN_FILE}"

get() { curl -fsS -H "x-diag-token: $DIAG_TOKEN" "$SITE/diag$1"; }

case "${1:-list}" in
list)
  # 一行一条：时间、编号、摘要、机器 —— 足够决定要打开哪一条。
  get "?limit=${2:-30}" | python3 -c '
import json, sys, datetime
for r in json.load(sys.stdin)["reports"]:
    when = datetime.datetime.fromtimestamp(r["created_at"] / 1000).strftime("%m-%d %H:%M")
    summary = (r["summary"] or "")[:52]
    print("%s  %-16s  %-54s  %-8s  %s" % (when, r["id"], summary, r["platform"] or "?", r["note"] or ""))
'
  ;;
get)
  : "${2:?用法: $0 get <id>}"
  get "/$2" | python3 -m json.tool
  ;;
serial)
  : "${2:?用法: $0 serial <序列号>}"
  get "?serial=$2&limit=${3:-30}" | python3 -m json.tool
  ;;
stats)
  get "/stats" | python3 -m json.tool
  ;;
*)
  echo "用法: $0 {list [n]|get <id>|serial <序列号>|stats}" >&2
  exit 1
  ;;
esac
