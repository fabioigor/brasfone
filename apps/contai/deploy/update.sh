#!/usr/bin/env bash
# Actualiza o Cont.ai no servidor: git pull do ramo seguido, rebuild da imagem e reinicio sem perder o volume /data.
# Chamado por /usr/local/bin/contai-update (wrapper fino escrito pelo cloud-init). A logica vive aqui, no repositorio,
# para que alteracoes ao processo de actualizacao cheguem ao servidor por git, como o resto do codigo.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
main() {
  local repo=/home/contai/brasfone
  mkdir -p /var/log/contai
  cd "$repo"
  runuser -u contai -- git pull --ff-only
  cd "$repo/apps/contai"
  local domain; domain="$(cat /etc/contai-domain 2>/dev/null || true)"
  CONTAI_DOMAIN="$domain" docker compose -f docker-compose.vps.yml up -d --build --remove-orphans
  docker image prune -f >/dev/null 2>&1 || true
  local sha; sha="$(runuser -u contai -- git -C "$repo" rev-parse --short HEAD)"
  printf '{"commit":"%s","branch":"%s","updatedAt":"%s"}\n' "$sha" "$(runuser -u contai -- git -C "$repo" rev-parse --abbrev-ref HEAD)" "$(date -Is)" > /var/log/contai/deploy.json
  echo "contai actualizado para $sha em $(date -Is)"
}
main "$@"; exit $?
