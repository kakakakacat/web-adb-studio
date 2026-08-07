#!/usr/bin/env bash
# Gets a publicly-trusted certificate for this host, so a browser can talk to it
# without a security warning.
#
# Why this is needed at all: the page must be served over HTTPS (WebUSB refuses to
# exist otherwise), and a self-signed cert makes every browser interrupt with a
# warning. Let's Encrypt normally proves control by answering an HTTP request on
# the public internet — impossible here, since this host is on a private address.
# So we use the DNS-01 challenge, which only needs a TXT record and works fine for
# a host the internet can't reach.
#
# Requires a Cloudflare API token with:
#   Zone → DNS → Edit   on the zone below
# Create at: https://dash.cloudflare.com/profile/api-tokens
#
#   CF_API_TOKEN=xxxxx ./setup-tls.sh      # first run
#   ./setup-tls.sh                          # later runs read ~/.adbstudio-cf-token
#
# The token file exists so unattended renewal doesn't have to put the secret in a
# crontab line or in argv, both of which are readable by anyone on this shared
# host (`ps` shows argv). First run stores it with mode 600.
#
# Safe to re-run: lego only re-issues near expiry, and the server is restarted
# only if the certificate actually changed.
set -euo pipefail
cd "$(dirname "$0")"

TOKEN_FILE="${TOKEN_FILE:-$HOME/.adbstudio-cf-token}"
if [ -z "${CF_API_TOKEN:-}" ] && [ -f "$TOKEN_FILE" ]; then
  CF_API_TOKEN="$(cat "$TOKEN_FILE")"
fi

DOMAIN="${DOMAIN:-nas.kakacat.icu}"
ZONE="${ZONE:-kakacat.icu}"
# The private address this host answers on. Published as a public A record, which
# is legal and common: it just means the name only resolves usefully on the VPN.
HOST_IP="${HOST_IP:-192.168.0.3}"
# Let's Encrypt 的联系邮箱（过期提醒发到这里）。没有合理的默认值 —— 公开仓库里写死
# 某个人的地址既是泄漏也是替别人做决定，所以要求显式给。
EMAIL="${EMAIL:?set EMAIL — Lets Encrypt 的联系邮箱，用于证书过期提醒}"
LEGO_VERSION="${LEGO_VERSION:-4.17.4}"

: "${CF_API_TOKEN:?set CF_API_TOKEN (Cloudflare token with Zone:DNS:Edit), or put it in $TOKEN_FILE}"

# Remember it for unattended renewal.
if [ ! -f "$TOKEN_FILE" ]; then
  (umask 077; printf '%s' "$CF_API_TOKEN" > "$TOKEN_FILE")
  echo "==> Stored the token in $TOKEN_FILE (mode 600) for renewals"
fi

# Fingerprint before, so we only bounce the server if the cert really changed.
cert_fingerprint() {
  [ -f tls/server.crt ] || { echo "none"; return; }
  openssl x509 -in tls/server.crt -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2
}
BEFORE="$(cert_fingerprint)"

api() {
  curl -sS -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" "$@"
}

echo "==> Looking up zone $ZONE"
ZONE_ID="$(api "https://api.cloudflare.com/client/v4/zones?name=${ZONE}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["result"][0]["id"] if d.get("result") else "")')"
[ -n "$ZONE_ID" ] || { echo "error: cannot read zone $ZONE — is the token scoped to it?" >&2; exit 1; }

echo "==> Ensuring A record ${DOMAIN} -> ${HOST_IP} (DNS only, not proxied)"
EXISTING="$(api "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=A&name=${DOMAIN}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d.get("result") or []; print(r[0]["id"] if r else "")')"
BODY="$(python3 -c "
import json,sys
print(json.dumps({'type':'A','name':'${DOMAIN}','content':'${HOST_IP}','ttl':120,'proxied':False}))")"
if [ -n "$EXISTING" ]; then
  api -X PUT --data "$BODY" \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${EXISTING}" >/dev/null
  echo "    updated"
else
  api -X POST --data "$BODY" \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" >/dev/null
  echo "    created"
fi
# Proxying must stay off: an orange-cloud record would send browsers to
# Cloudflare's edge, which cannot reach a private address.

echo "==> Installing lego (single binary, no root)"
mkdir -p "$HOME/.local/bin"
if [ ! -x "$HOME/.local/bin/lego" ]; then
  tmp="$(mktemp -d)"
  curl -sSfL --max-time 180 -o "$tmp/lego.tar.gz" \
    "https://github.com/go-acme/lego/releases/download/v${LEGO_VERSION}/lego_v${LEGO_VERSION}_linux_amd64.tar.gz"
  tar -xzf "$tmp/lego.tar.gz" -C "$tmp" lego
  mv "$tmp/lego" "$HOME/.local/bin/lego"
  rm -rf "$tmp"
fi
"$HOME/.local/bin/lego" --version

echo "==> Requesting certificate for ${DOMAIN} via DNS-01"
export CLOUDFLARE_DNS_API_TOKEN="$CF_API_TOKEN"
mkdir -p tls/lego
# `run` issues, `renew` is a no-op until close to expiry — try renew first so
# re-running this script is safe and idempotent.
if [ -f "tls/lego/certificates/${DOMAIN}.crt" ]; then
  "$HOME/.local/bin/lego" --accept-tos --email "$EMAIL" --dns cloudflare \
    --domains "$DOMAIN" --path tls/lego renew --days 30
else
  "$HOME/.local/bin/lego" --accept-tos --email "$EMAIL" --dns cloudflare \
    --domains "$DOMAIN" --path tls/lego run
fi

echo "==> Installing cert where the server expects it"
cp "tls/lego/certificates/${DOMAIN}.crt" tls/server.crt
cp "tls/lego/certificates/${DOMAIN}.key" tls/server.key
chmod 600 tls/server.key
openssl x509 -in tls/server.crt -noout -subject -issuer -dates

# The running server loaded its cert at startup, so a renewed cert only takes
# effect after a restart — but restarting when nothing changed would drop live
# connections for no reason.
AFTER="$(cert_fingerprint)"
if [ "$BEFORE" != "$AFTER" ] && ps -eo comm | grep -qx 'adbstudio-web-s'; then
  echo "==> Certificate changed and the server is running — restarting it"
  ./run-nas.sh
else
  cat <<EOF

==> Done. Start (or restart) the server to use it:

    ./run-nas.sh

Then open  https://${DOMAIN}:7070  (on the VPN) — no certificate warning.
EOF
fi

cat <<EOF

Renewal: certificates last 90 days. The token is in $TOKEN_FILE, so cron needs no
secret on its command line:

    (crontab -l 2>/dev/null; echo "17 4 * * 1 $PWD/setup-tls.sh >> /tmp/adbstudio-tls.log 2>&1") | crontab -
EOF
