#!/usr/bin/env bash
# Back up JARVIS's host-local data tree.
#
# Defaults:
#   source:      ~/.jarvis
#   destination: ~/backups/jarvis
#   retention:   14 archives
#
# Override with:
#   JARVIS_DATA_DIR=/path/to/.jarvis
#   JARVIS_BACKUP_DIR=/path/to/backups
#   JARVIS_BACKUP_KEEP=30
set -euo pipefail

DATA_DIR="${JARVIS_DATA_DIR:-$HOME/.jarvis}"
BACKUP_DIR="${JARVIS_BACKUP_DIR:-$HOME/backups/jarvis}"
KEEP="${JARVIS_BACKUP_KEEP:-14}"
HOST="$(hostname -s 2>/dev/null || hostname)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="jarvis-${HOST}-${STAMP}.tar.gz"
TMP="${BACKUP_DIR}/.${NAME}.tmp"
OUT="${BACKUP_DIR}/${NAME}"
SHA="${OUT}.sha256"
LATEST="${BACKUP_DIR}/latest.tar.gz"
LATEST_SHA="${BACKUP_DIR}/latest.tar.gz.sha256"

if [[ ! -d "$DATA_DIR" ]]; then
  echo "ERROR: data dir does not exist: $DATA_DIR" >&2
  exit 1
fi

if ! [[ "$KEEP" =~ ^[0-9]+$ ]] || [[ "$KEEP" -lt 1 ]]; then
  echo "ERROR: JARVIS_BACKUP_KEEP must be a positive integer; got: $KEEP" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Keep cache out. Everything else under ~/.jarvis is intentionally included:
# config, prompts, notes, sessions, audit log, .env, and OAuth creds.
# tar exit 1 = "file changed as we read it", expected for an active data dir.
# We still want that archive; only fail on real errors (exit >= 2).
tar_rc=0
tar \
  --create \
  --gzip \
  --file "$TMP" \
  --directory "$(dirname "$DATA_DIR")" \
  --exclude "$(basename "$DATA_DIR")/cache" \
  --exclude "$(basename "$DATA_DIR")/cache/*" \
  --warning=no-file-changed \
  "$(basename "$DATA_DIR")" || tar_rc=$?
if [[ "$tar_rc" -ge 2 ]]; then
  rm -f "$TMP"
  echo "ERROR: tar failed with exit code $tar_rc" >&2
  exit "$tar_rc"
fi

mv "$TMP" "$OUT"
sha256sum "$OUT" > "$SHA"
ln -sfn "$(basename "$OUT")" "$LATEST"
ln -sfn "$(basename "$SHA")" "$LATEST_SHA"

# Basic integrity check: gzip stream + tar listing.
tar -tzf "$OUT" >/dev/null

# Retention: keep newest N tarballs and their checksums. Symlinks are left alone.
mapfile -t OLD < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'jarvis-*.tar.gz' -printf '%T@ %p\n' | sort -rn | awk -v keep="$KEEP" 'NR > keep { print $2 }')
for archive in "${OLD[@]}"; do
  rm -f "$archive" "$archive.sha256"
done

SIZE="$(du -h "$OUT" | awk '{print $1}')"
COUNT="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'jarvis-*.tar.gz' | wc -l | tr -d ' ')"

echo "Backup OK: $OUT"
echo "Size: $SIZE"
echo "Archives retained: $COUNT/$KEEP"
echo "SHA256: $(cut -d' ' -f1 "$SHA")"
