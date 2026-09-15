#!/usr/bin/env bash
# Actualiza o Cont.ai no servidor: git pull do ramo seguido, rebuild da imagem e reinicio sem perder o volume /data.
# Chamado por /usr/local/bin/contai-update (wrapper fino escrito pelo cloud-init). A logica vive aqui, no repositorio,
# para que alteracoes ao processo de actualizacao cheguem ao servidor por git, como o resto do codigo.
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
main() {
  local repo=${CONTAI_REPO:-/home/contai/brasfone}
  mkdir -p /var/log/contai
  cd "$repo"
  runuser -u contai -- git pull --ff-only
  cd "$repo/apps/contai"
  # Pasta de configuracao partilhada com a app (o contentor corre como uid 1000).
  mkdir -p /var/lib/contai/config && chown 1000:1000 /var/lib/contai/config
  local domain
  if [ -s /var/lib/contai/config/domain ]; then domain="$(tr -d '[:space:]' < /var/lib/contai/config/domain)"
  elif [ -f /var/lib/contai/config/domain ]; then domain=""    # ficheiro vazio: a app desligou o dominio
  else domain="$(cat /etc/contai-domain 2>/dev/null | tr -d '[:space:]' || true)"; fi
  CONTAI_DOMAIN="$domain" docker compose -f docker-compose.vps.yml up -d --build --remove-orphans
  printf '%s\n' "$domain" > /var/log/contai/domain.applied
  local ip; ip="$(curl -sf --max-time 3 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || true)"
  printf '{"publicIp":"%s","domain":"%s","updatedAt":"%s"}\n' "$ip" "$domain" "$(date -Is)" > /var/log/contai/server.json
  docker image prune -f >/dev/null 2>&1 || true
  local sha; sha="$(runuser -u contai -- git -C "$repo" rev-parse --short HEAD)"
  printf '{"commit":"%s","branch":"%s","updatedAt":"%s"}\n' "$sha" "$(runuser -u contai -- git -C "$repo" rev-parse --abbrev-ref HEAD)" "$(date -Is)" > /var/log/contai/deploy.json
  echo "contai actualizado para $sha em $(date -Is)"
}
main "$@"; exit $?
