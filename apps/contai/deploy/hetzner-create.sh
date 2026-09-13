#!/usr/bin/env bash
# Cria e configura o servidor Cont.ai no Hetzner Cloud pela API (sem browser).
#
# Obrigatorio:
#   HCLOUD_TOKEN       token de API (Read & Write) do projecto Hetzner
#   ENV_FILE           ficheiro .env com os segredos da app (ver .env.example)
# Opcional:
#   ADMIN_PUBKEY_FILE  chave publica SSH para o utilizador 'contai' (sem ela: consola web do Hetzner)
#   SERVER_NAME=contai SERVER_TYPE=cx22 LOCATION=nbg1 (nbg1 Nuremberga, fsn1 Falkenstein, hel1 Helsinquia)
#   DOMAIN             ex.: app.contai.pt (DNS A -> IP do servidor); vazio = HTTP por IP na fase de testes
#   REPO=fabioigor/brasfone BRANCH=claude/accounting-app-kangaroo-ymg5d7
#   DRY_RUN=1          so imprime o cloud-init renderizado, nao chama a API
set -euo pipefail
: "${HCLOUD_TOKEN:?defina HCLOUD_TOKEN}" "${ENV_FILE:?defina ENV_FILE}"
ADMIN_PUBKEY_FILE="${ADMIN_PUBKEY_FILE:-}"
SERVER_NAME="${SERVER_NAME:-contai}"; SERVER_TYPE="${SERVER_TYPE:-cx22}"; LOCATION="${LOCATION:-nbg1}"
DOMAIN="${DOMAIN:-}"; REPO="${REPO:-fabioigor/brasfone}"; BRANCH="${BRANCH:-claude/accounting-app-kangaroo-ymg5d7}"
API="https://api.hetzner.cloud/v1"
HERE="$(cd "$(dirname "$0")" && pwd)"

render() {
  python3 - "$HERE/hetzner-cloud-init.yaml" "$ADMIN_PUBKEY_FILE" "$ENV_FILE" "$DOMAIN" "$REPO" "$BRANCH" <<'EOF_PY'
import sys
tpl, pub, env, domain, repo, branch = sys.argv[1:]
t = open(tpl).read()
ind = lambda s: "\n".join("      " + l for l in s.rstrip("\n").split("\n"))
keys = ""
if pub:
    keys = "    ssh_authorized_keys:\n" + "\n".join("      - " + l.strip() for l in open(pub).read().splitlines() if l.strip())
t = t.replace("__ADMIN_KEYS__\n", keys + "\n" if keys else "")
t = t.replace("__ENV_INDENTED__", ind(open(env).read()))
t = t.replace("__DOMAIN__", domain).replace("__REPO__", repo).replace("__BRANCH__", branch)
sys.stdout.write(t)
EOF_PY
}

USERDATA="$(render)"
if [ "${DRY_RUN:-0}" = "1" ]; then printf '%s\n' "$USERDATA"; exit 0; fi

hc() { curl -sS -H "Authorization: Bearer $HCLOUD_TOKEN" -H "Content-Type: application/json" "$@"; }

# 1. Chave SSH de administracao (opcional, idempotente)
KEY_ID=""
if [ -n "$ADMIN_PUBKEY_FILE" ]; then
  KEY_ID="$(hc "$API/ssh_keys?name=contai-admin" | python3 -c 'import sys,json; k=json.load(sys.stdin)["ssh_keys"]; print(k[0]["id"] if k else "")')"
  if [ -z "$KEY_ID" ]; then
    KEY_ID="$(python3 -c 'import json,sys; print(json.dumps({"name":"contai-admin","public_key":open(sys.argv[1]).read().strip()}))' "$ADMIN_PUBKEY_FILE" \
      | hc -X POST "$API/ssh_keys" -d @- | python3 -c 'import sys,json; print(json.load(sys.stdin)["ssh_key"]["id"])')"
  fi
fi

# 2. Firewall do projecto (SSH, HTTP, HTTPS) - idempotente
FW_ID="$(hc "$API/firewalls?name=contai-web" | python3 -c 'import sys,json; f=json.load(sys.stdin)["firewalls"]; print(f[0]["id"] if f else "")')"
if [ -z "$FW_ID" ]; then
  FW_ID="$(python3 -c '
import json
rules=[{"direction":"in","protocol":"tcp","port":p,"source_ips":["0.0.0.0/0","::/0"]} for p in ("22","80","443")]
rules.append({"direction":"in","protocol":"icmp","source_ips":["0.0.0.0/0","::/0"]})
print(json.dumps({"name":"contai-web","rules":rules}))' | hc -X POST "$API/firewalls" -d @- | python3 -c 'import sys,json; print(json.load(sys.stdin)["firewall"]["id"])')"
fi

# 3. Servidor
BODY="$(python3 - "$SERVER_NAME" "$SERVER_TYPE" "$LOCATION" "$KEY_ID" "$FW_ID" <<'EOF_PY'
import json, sys
name, stype, loc, key, fw = sys.argv[1:]
body = {"name": name, "server_type": stype, "location": loc, "image": "ubuntu-24.04",
        "user_data": sys.stdin.read(), "labels": {"app": "contai", "owner": "lumarcont"},
        "public_net": {"enable_ipv4": True, "enable_ipv6": True},
        "firewalls": [{"firewall": int(fw)}]}
if key: body["ssh_keys"] = [int(key)]
print(json.dumps(body))
EOF_PY
<<< "$USERDATA")"

RESP="$(printf '%s' "$BODY" | hc -X POST "$API/servers" -d @-)"
printf '%s' "$RESP" | python3 -c '
import sys, json
r = json.load(sys.stdin)
if r.get("error"):
    print("ERRO:", json.dumps(r["error"], ensure_ascii=False)); sys.exit(1)
s = r["server"]
print("servidor:", s["name"], "id", s["id"], "tipo", s["server_type"]["name"], "local", s["datacenter"]["location"]["name"])
print("ipv4:", s["public_net"]["ipv4"]["ip"])
print("ipv6:", s["public_net"]["ipv6"]["ip"])
if r.get("root_password"): print("palavra-passe root (apenas se nao houver chave SSH):", r["root_password"])
'
echo "cloud-init demora 3 a 6 minutos (instala Docker e constroi a imagem). Verificar: curl http://<ipv4>/health"
