#!/usr/bin/env bash
# Actualizacao automatica (temporizador systemd de 5 em 5 minutos): se o ramo remoto tiver commits novos, corre update.sh.
# Corre inteiro a partir de uma funcao para que o pull a meio nao altere o script em execucao.
set -Eeuo pipefail
# Ambientes de cron/systemd podem arrancar com PATH minimo (sem /usr/sbin, onde vive o runuser): fixar aqui.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=${CONTAI_REPO:-/home/contai/brasfone}
LOGDIR=${CONTAI_LOG_DIR:-/var/log/contai}
LOG=$LOGDIR/autoupdate.log
mkdir -p "$LOGDIR"
trap 'echo "$(date -Is) ERRO na linha $LINENO (codigo $?)" >> "$LOG"' ERR
main() {
  exec 9>"$LOGDIR/.autoupdate.lock"; flock -n 9 || exit 0
  cd "$REPO"
  local g="runuser -u contai -- git"
  $g fetch -q origin 2>>"$LOG"
  local b l r
  b=$($g rev-parse --abbrev-ref HEAD); l=$($g rev-parse HEAD); r=$($g rev-parse "origin/$b")
  date -Is > "$LOGDIR/last-check"
  if [ "$l" = "$r" ]; then exit 0; fi
  echo "$(date -Is) actualizar $b ${l:0:7} -> ${r:0:7}" >> "$LOG"
  if bash "$REPO/apps/contai/deploy/update.sh" >> "$LOG" 2>&1; then echo "$(date -Is) ok" >> "$LOG"; else echo "$(date -Is) FALHOU (ver acima)" >> "$LOG"; fi
  tail -n 400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
}
main "$@"; exit $?
