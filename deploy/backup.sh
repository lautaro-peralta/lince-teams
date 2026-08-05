#!/usr/bin/env bash
# Respaldo de Lince Teams: base de datos + adjuntos de la pizarra.
#
# Sin esto, un disco roto en la VM se lleva el kanban, la pizarra, las
# transcripciones y el historial de actividad: nada de eso vive en otro lado.
#
# Qué guarda (en un solo .tar.gz por corrida):
#   · La base           — data/lince.db (SQLite) o un pg_dump (si DATABASE_URL).
#   · data/uploads/     — las imágenes que el equipo pegó en la pizarra.
#
# Instalación en la VM (cron diario a las 3:15, retención de 14 días):
#   sudo chmod +x /opt/lince-teams/deploy/backup.sh
#   ( crontab -l 2>/dev/null; echo "15 3 * * * /opt/lince-teams/deploy/backup.sh >> /var/log/lince-backup.log 2>&1" ) | crontab -
#
# IMPORTANTE: un backup que vive en el MISMO disco no protege del fallo más
# probable. Configurá BACKUP_REMOTE (destino de rclone) para copiarlo afuera:
#   rclone config                       # una vez: crear el remoto, p. ej. "drive"
#   export BACKUP_REMOTE=drive:lince-backups
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lince-teams}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/lince-teams}"
KEEP_DAYS="${KEEP_DAYS:-14}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"   # vacío = solo copia local (ver aviso arriba)

# El .env del servicio trae DATABASE_URL cuando se usa Postgres/Supabase.
for envfile in "$APP_DIR/teams.env" "$APP_DIR/.env"; do
  # shellcheck disable=SC1090
  [ -f "$envfile" ] && set -a && . "$envfile" && set +a
done

STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$BACKUP_DIR"

# ── Base de datos ────────────────────────────────────────────────────────────
if [ -n "${DATABASE_URL:-}" ]; then
  # Postgres/Supabase: volcado lógico, restaurable con `psql < dump.sql`.
  pg_dump "$DATABASE_URL" > "$WORK/db.sql"
else
  # SQLite: la API `backup()` es segura con el servicio CORRIENDO (copiar el
  # archivo a mano puede dejarlo inconsistente si hay una escritura a mitad de
  # camino). Se usa Python y no el CLI `sqlite3` porque Python siempre está —es
  # una app Python— y el CLI no viene instalado por defecto en Ubuntu.
  "${PYTHON:-python3}" - "$APP_DIR/data/lince.db" "$WORK/lince.db" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
with sqlite3.connect(f"file:{src}?mode=ro", uri=True) as s, sqlite3.connect(dst) as d:
    s.backup(d)
PY
fi

# ── Adjuntos de la pizarra ───────────────────────────────────────────────────
if [ -d "$APP_DIR/data/uploads" ]; then
  cp -r "$APP_DIR/data/uploads" "$WORK/uploads"
fi

ARCHIVE="$BACKUP_DIR/lince-teams-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK" .
echo "[backup] $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# ── Copia fuera de la VM ─────────────────────────────────────────────────────
if [ -n "$BACKUP_REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "$ARCHIVE" "$BACKUP_REMOTE" && echo "[backup] copiado a $BACKUP_REMOTE"
  else
    echo "[backup] AVISO: BACKUP_REMOTE está configurado pero rclone no está instalado." >&2
  fi
else
  echo "[backup] AVISO: sin BACKUP_REMOTE; el respaldo vive en el MISMO disco que la app." >&2
fi

# ── Retención ────────────────────────────────────────────────────────────────
find "$BACKUP_DIR" -name 'lince-teams-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
echo "[backup] listo (se conservan los últimos $KEEP_DAYS días)"
