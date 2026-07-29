#!/usr/bin/env bash
# Sets up the Studio Booth print agent on a Raspberry Pi (Raspberry Pi OS).
# Run from inside this print-agent/ directory: sudo ./install.sh
set -euo pipefail

INSTALL_DIR="/home/pi/studio-booth-print-agent"
SERVICE_NAME="studio-booth-print-agent.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo ./install.sh" >&2
  exit 1
fi

echo "==> Installing CUPS (printing system) if not already present..."
apt-get update -y
apt-get install -y cups

echo "==> Letting the 'pi' user administer printers..."
usermod -aG lpadmin pi

echo "==> Enabling the CUPS web admin UI at http://localhost:631 ..."
cupsctl WebInterface=yes

echo "==> Copying the agent into ${INSTALL_DIR} ..."
mkdir -p "${INSTALL_DIR}"
cp -r ./server.js ./package.json "${INSTALL_DIR}/"
chown -R pi:pi "${INSTALL_DIR}"

echo "==> Installing the systemd service..."
cp ./"${SERVICE_NAME}" /etc/systemd/system/"${SERVICE_NAME}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo ""
echo "Done. Checking status:"
systemctl --no-pager status "${SERVICE_NAME}" || true

echo ""
echo "Next steps:"
echo "  1. Open http://localhost:631/printers on the Pi (in a real desktop"
echo "     browser session, not the kiosk Chromium) to add your printer and"
echo "     set its driver options (paper size, orientation, quality)."
echo "  2. Open the kiosk Admin page -> Printer Preferences -> Printer Setup"
echo "     to select that printer for the agent to use."
echo "  3. curl http://localhost:8787/health should now return ok:true."
