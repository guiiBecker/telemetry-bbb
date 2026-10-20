#!/usr/bin/env bash
# Installs the bbb-telemetry switch on a BigBlueButton server. Safe to re-run: it never overwrites
# /etc/bigbluebutton/bbb-telemetry.yml or bbb-telemetry.env, and it does not turn telemetry on.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo ./install.sh" >&2; exit 1; }
DIR="$(cd "$(dirname "$0")" && pwd)"
SHARE=/usr/local/share/bbb-telemetry

command -v yq >/dev/null || { echo "yq not found (it ships with BigBlueButton)" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker not found (needed for the OTel collector)" >&2; exit 1; }

install -m 755 "$DIR/bin/bbb-telemetry" /usr/local/bin/bbb-telemetry
install -d "$SHARE/otel" "$SHARE/nginx"
install -m 644 "$DIR"/otel/*.yaml "$SHARE/otel/"
install -m 644 "$DIR/nginx/telemetry.nginx" "$SHARE/nginx/"
install -m 644 "$DIR/README.md" "$SHARE/README.md"
[ -f /etc/bigbluebutton/bbb-telemetry.yml ] || install -m 644 "$DIR/config.yml" /etc/bigbluebutton/bbb-telemetry.yml
[ -f /etc/bigbluebutton/bbb-telemetry.env ] || install -m 600 "$DIR/bbb-telemetry.env.example" /etc/bigbluebutton/bbb-telemetry.env
install -m 644 "$DIR/systemd/bbb-telemetry.service" /etc/systemd/system/bbb-telemetry.service
systemctl daemon-reload
systemctl enable bbb-telemetry.service >/dev/null

echo "Installed. Next:"
echo "  1. edit /etc/bigbluebutton/bbb-telemetry.env (SigNoz region and ingestion key)"
echo "  2. edit /etc/bigbluebutton/bbb-telemetry.yml (telemetry.enabled, observer.enabled)"
echo "  3. sudo bbb-telemetry apply --restart   (or reboot: bbb-telemetry.service applies it at boot)"
