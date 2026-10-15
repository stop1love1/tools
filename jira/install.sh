#!/bin/bash
# Jira Dashboard Installer
# Automatically sets up desktop shortcuts with correct paths

set -e

# Detect project directory
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="$PROJECT_DIR/assets"
ELECTRON_BIN="$PROJECT_DIR/node_modules/electron/dist/electron"

# The file must be named jira-dashboard.desktop: GNOME matches the window's app_id / WM_CLASS
# ("jira-dashboard", set in electron-main.js) to it, so the dock keeps this icon instead of a generic "Electron" one.
DESKTOP_FILE="$HOME/Desktop/jira-dashboard.desktop"
APPS_FILE="$HOME/.local/share/applications/jira-dashboard.desktop"

echo "📦 Installing Jira Dashboard..."
echo "   Project: $PROJECT_DIR"

if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Electron not found, running npm install..."
  (cd "$PROJECT_DIR" && npm install)
fi

# Remove the old shell launcher: it detached Electron via nohup, so the dock could not track the window.
rm -f "$HOME/Documents/jira-dashboard.sh"

# Exec runs Electron directly on the project dir (not on a bare .js file) so package.json names the app.
# --no-sandbox: Ubuntu's AppArmor blocks Electron's sandbox for binaries under node_modules.
cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Jira Dashboard
Comment=Launch Jira Dashboard
Exec="$ELECTRON_BIN" "$PROJECT_DIR" --no-sandbox
Path=$PROJECT_DIR
Icon=$ASSETS_DIR/icon.png
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=jira-dashboard
EOF

chmod +x "$DESKTOP_FILE"
gio set "$DESKTOP_FILE" metadata::trusted true 2>/dev/null || true
echo "✅ Desktop: $DESKTOP_FILE"

# Install to applications
mkdir -p "$HOME/.local/share/applications"
cp "$DESKTOP_FILE" "$APPS_FILE"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
echo "✅ Apps menu: $APPS_FILE"

echo ""
echo "🚀 Installation complete!"
echo "   Launch \"Jira Dashboard\" from the app menu or the Desktop, then right-click its dock icon → Pin to Dash."
echo ""
