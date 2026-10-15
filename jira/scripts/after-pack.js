'use strict';

// electron-builder afterPack hook (Linux): wrap the app binary in a script that adds the flags the app needs at
// launch, so they apply however it is started (AppImage double-click, deb menu entry, release/linux-unpacked).
//
// --ozone-platform-hint=auto: native Wayland instead of XWayland. Under XWayland, GNOME upscales the window on
//   fractional scaling (e.g. 125%) and all text is blurry. It cannot be set from electron-main.js: the platform
//   is picked before the main script runs.
// --no-sandbox (AppImage only): an AppImage cannot ship the setuid chrome-sandbox, and Ubuntu's AppArmor blocks
//   the user-namespace sandbox. The deb installs chrome-sandbox setuid, so it keeps the sandbox.

const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const name = context.packager.executableName;
  const bin = path.join(context.appOutDir, name);
  const real = `${bin}.bin`;
  fs.renameSync(bin, real);
  fs.writeFileSync(
    bin,
    `#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
EXTRA=()
[ -n "$APPIMAGE" ] && EXTRA+=(--no-sandbox)
exec "$HERE/${name}.bin" --ozone-platform-hint=auto --enable-features=WaylandWindowDecorations "\${EXTRA[@]}" "$@"
`,
    { mode: 0o755 },
  );
};
