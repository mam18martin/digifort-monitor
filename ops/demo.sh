#!/usr/bin/env bash
set -euo pipefail
# Dedicated local project. Never merge with compose.yaml or consume its .env.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "${1:-start}" == "start" || "${1:-start}" == "reset" ]]; then
  echo 'La demo está retirada del flujo operativo. Los fixtures se conservan sólo para pruebas.' >&2
  exit 1
fi
demo_port="${DEMO_PORT:-8081}"
if [[ ! "$demo_port" =~ ^[1-9][0-9]{3,4}$ ]] || (( demo_port > 65535 )); then
  echo 'DEMO_PORT debe ser un puerto entre 1024 y 65535.' >&2
  exit 1
fi
if (( demo_port < 1024 )); then exit 1; fi
demo_endpoint=$(docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}')
case "$demo_endpoint" in unix://*) ;; *) echo 'La demo requiere Docker Desktop local, sin contexto remoto.' >&2; exit 1;; esac
if [[ "$(docker --context desktop-linux info --format '{{.Name}}')" != 'docker-desktop' ]]; then
  echo 'No se identificó el daemon local de Docker Desktop.' >&2
  exit 1
fi
demo_compose=(docker --context desktop-linux compose --env-file /dev/null -p digifort-monitor-demo -f compose.demo.yaml)
case "${1:-start}" in
  start) "${demo_compose[@]}" up -d --build --wait web ;;
  reset)
    echo 'Recreando sólo la demostración: se descartan sus datos sintéticos temporales.'
    "${demo_compose[@]}" down
    "${demo_compose[@]}" up -d --build --wait web
    ;;
  stop) "${demo_compose[@]}" down; exit 0 ;;
  status) "${demo_compose[@]}" ps -a; exit 0 ;;
  *) echo 'Uso: bash ops/demo.sh [start|reset|stop|status]' >&2; exit 1 ;;
esac
for demo_attempt in {1..30}; do
  if curl --silent --fail --max-time 2 "http://127.0.0.1:${demo_port}/api/v1/ready" >/dev/null; then
    echo "Demostración lista: http://127.0.0.1:${demo_port}"
    echo 'Observaciones sintéticas sin sincronización real. Para renovar el escenario: bash ops/demo.sh reset'
    exit 0
  fi
  sleep 1
done
echo 'Los servicios se iniciaron, pero la aplicación todavía no responde. Revisar: bash ops/demo.sh status' >&2
exit 1
