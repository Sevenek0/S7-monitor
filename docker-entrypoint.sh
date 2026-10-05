#!/bin/sh
# Naprawia uprawnienia wolumenu ./data i uruchamia aplikację jako użytkownik "node" (bez roota).
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  chown -R node:node "${DATA_DIR:-/data}"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
