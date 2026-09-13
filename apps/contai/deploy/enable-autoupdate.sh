#!/usr/bin/env bash
# Activa a actualizacao automatica num servidor Cont.ai ja provisionado (correr como root, uma vez).
# A cada 5 minutos, se o ramo remoto tiver commits novos, o servidor faz git pull e reconstroi a app.
# Depois disto, as alteracoes chegam a producao so com um push para o ramo: sem SSH nem token do Hetzner.
set -euo pipefail
SRC=/home/contai/brasfone/apps/contai/deploy/hetzner-cloud-init.yaml
[ -f "$SRC" ] || { echo "repositorio nao encontrado em /home/contai/brasfone"; exit 1; }
python3 - "$SRC" <<'EOF_PY'
import sys, yaml
doc = yaml.safe_load(open(sys.argv[1]).read().replace("__ADMIN_KEYS__", "").replace("__ENV_INDENTED__", "      x=y"))
wanted = {"/usr/local/bin/contai-autoupdate", "/etc/cron.d/contai-autoupdate", "/usr/local/bin/contai-update"}
for f in doc["write_files"]:
    if f["path"] in wanted:
        open(f["path"], "w").write(f["content"])
        import os; os.chmod(f["path"], int(f.get("permissions", "0644"), 8))
        print("escrito", f["path"])
EOF_PY
systemctl restart cron
/usr/local/bin/contai-autoupdate || true
echo "actualizacao automatica activa (cron de 5 em 5 minutos); registo em /var/log/contai-autoupdate.log"
