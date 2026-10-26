#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ ! -f .local/integration/project || ! -f .local/integration/compose.env ]]; then
  echo 'Falta la configuración privada del entorno. Consultar docs/apicamstat-integration.md.' >&2
  exit 1
fi
integration_project=$(cat .local/integration/project)
if [[ ! "$integration_project" =~ ^digifort-integration-[a-f0-9]{8}$ ]]; then exit 1; fi
case "$(docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}')" in unix://*) ;; *) exit 1;; esac
compose=(docker --context desktop-linux compose --env-file .local/integration/compose.env -p "$integration_project" -f compose.integration.yaml)
case "${1:-status}" in
  start) "${compose[@]}" up -d --wait api apicamstat web ;;
  status) "${compose[@]}" ps -a ;;
  *) echo 'Uso: bash ops/integration.sh [start|status]. No aplica migraciones ni borra recursos.' >&2; exit 1 ;;
esac
