#!/bin/bash
# Jira Dashboard Installer
# Installs the built AppImage outside the project folder, so the app keeps working after the source is moved or
# deleted. Run it again after a rebuild to update the installed copy.

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ID="jira-dashboard"
INSTALL_DIR="$HOME/.local/share/$APP_ID"
APPIMAGE="$INSTALL_DIR/$APP_ID.AppImage"
ICON_FILE="$HOME/.local/share/icons/hicolor/512x512/apps/$APP_ID.png"
# Where the packaged app keeps .env, config.json, .oauth.json and .mcp-token (Electron's userData, see electron-main.js).
DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/$APP_ID"

# The file must be named jira-dashboard.desktop: GNOME matches the window's app_id / WM_CLASS
# ("jira-dashboard", set in electron-main.js) to it, so the dock keeps this icon instead of a generic "Electron" one.
DESKTOP_FILE="$HOME/Desktop/$APP_ID.desktop"
APPS_FILE="$HOME/.local/share/applications/$APP_ID.desktop"

echo "📦 Installing Jira Dashboard..."
echo "   Project: $PROJECT_DIR"

cd "$PROJECT_DIR"
[ -d node_modules ] || npm install

# Rebuild when there is no AppImage yet or a source file is newer than it.
BUILT="$(ls -t release/*.AppImage 2>/dev/null | head -n1 || true)"
if [ -z "$BUILT" ] || [ -n "$(find package.json electron-main.js preload.js server.js lib public assets scripts -newer "$BUILT" -print -quit)" ]; then
  echo "🔨 Building AppImage..."
  npx electron-builder --linux AppImage
  BUILT="$(ls -t release/*.AppImage | head -n1)"
fi

mkdir -p "$INSTALL_DIR" "$(dirname "$ICON_FILE")" "$DATA_DIR" "$(dirname "$APPS_FILE")"
cp "$BUILT" "$APPIMAGE.tmp"
chmod +x "$APPIMAGE.tmp"
mv "$APPIMAGE.tmp" "$APPIMAGE"
cp assets/icon.png "$ICON_FILE"
echo "✅ App: $APPIMAGE"

# Carry over the settings and sign-in used by `npm start` / the old dev launcher. Never overwrite the app's own.
for f in .env config.json .oauth.json .mcp-token; do
  if [ -f "$f" ] && [ ! -e "$DATA_DIR/$f" ]; then
    cp "$f" "$DATA_DIR/$f"
    chmod 600 "$DATA_DIR/$f"
    echo "✅ Copied $f → $DATA_DIR/"
  fi
done

# Remove the old shell launcher: it detached Electron via nohup, so the dock could not track the window.
rm -f "$HOME/Documents/jira-dashboard.sh"

# The AppImage's launcher (scripts/after-pack.js) adds --no-sandbox and the Wayland flags itself.
cat > "$APPS_FILE" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Jira Dashboard
Comment=Launch Jira Dashboard
Exec="$APPIMAGE" %U
Icon=$APP_ID
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=$APP_ID
EOF
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
echo "✅ Apps menu: $APPS_FILE"

if [ -d "$HOME/Desktop" ]; then
  cp "$APPS_FILE" "$DESKTOP_FILE"
  chmod +x "$DESKTOP_FILE"
  gio set "$DESKTOP_FILE" metadata::trusted true 2>/dev/null || true
  echo "✅ Desktop: $DESKTOP_FILE"
fi

echo ""
echo "🚀 Installation complete! The project folder is no longer needed to run the app."
echo "   Settings & sign-in: $DATA_DIR"
echo "   Launch \"Jira Dashboard\" from the app menu or the Desktop, then right-click its dock icon → Pin to Dash."
echo ""
