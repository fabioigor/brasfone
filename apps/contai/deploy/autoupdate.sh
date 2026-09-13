#!/usr/bin/env bash
# Actualizacao automatica (cron de 5 em 5 minutos): se o ramo remoto tiver commits novos, corre update.sh.
# Corre inteiro a partir de uma funcao para que o pull a meio nao altere o script em execucao.
set -euo pipefail
main() {
  exec 9>/run/contai-autoupdate.lock; flock -n 9 || exit 0
  local repo=/home/contai/brasfone log=/var/log/contai-autoupdate.log
  cd "$repo"
  local g="runuser -u contai -- git"
  $g fetch -q origin
  local b l r; b=$($g rev-parse --abbrev-ref HEAD); l=$($g rev-parse HEAD); r=$($g rev-parse "origin/$b")
  [ "$l" = "$r" ] && exit 0
  echo "$(date -Is) actualizar $b ${l:0:7} -> ${r:0:7}" >> "$log"
  if bash "$repo/apps/contai/deploy/update.sh" >> "$log" 2>&1; then echo "$(date -Is) ok" >> "$log"; else echo "$(date -Is) FALHOU (ver acima)" >> "$log"; fi
}
main "$@"; exit $?
