# Jira Dashboard - Portable Electron App

A standalone desktop application for viewing Jira issues with MCP integration.

## Features

- ✅ Native desktop app (no browser needed)
- ✅ Electron-based with Go backend
- ✅ MCP Atlassian integration
- ✅ Portable - works on any Linux machine
- ✅ Desktop shortcut & app menu integration

## Installation

### Prerequisites

1. **Node.js & npm** (via nvm recommended):
   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
   nvm install --lts
   ```

2. **Go** (for building the backend):
   ```bash
   # Install from https://go.dev/dl/
   ```

### Setup

1. **Clone/Copy the project:**
   ```bash
   cd ~/Documents/tools
   # Copy the jira folder here
   ```

2. **Install dependencies:**
   ```bash
   cd ~/Documents/tools/jira
   npm install
   ```

3. **Build the Go backend:**
   ```bash
   npm run build
   ```
   This creates `dist/jira-dashboard-linux`

4. **Run the installer:**
   ```bash
   bash install.sh
   ```
   This will:
   - Create a launcher script in `~/Documents/`
   - Add desktop shortcut
   - Add to app menu

5. **Launch:**
   - Double-click the **Jira Dashboard** icon on your Desktop
   - Or search for "Jira Dashboard" in your app launcher

## Project Structure

```
jira/
├── assets/
│   └── jira-icon.svg         # App icon
├── dist/
│   └── jira-dashboard-linux  # Go backend binary (generated)
├── electron-main.js           # Electron main process
├── preload.js                 # Electron preload script
├── install.sh                 # Installer script
├── main.go                    # Go backend server
├── package.json
└── public/                    # Frontend assets
    ├── index.html
    ├── style.css
    └── app.js
```

## Development

### Run in development mode:
```bash
npm run start:electron
```

### Rebuild after code changes:
```bash
npm run build
```

### Check logs:
```bash
tail -f /tmp/jira-dashboard.log
```

## Port Configuration

The app runs on **port 4747** by default. If you need to change it:

1. Edit `main.go` - change `PORT` constant
2. Edit `electron-main.js` - change `PORT` constant
3. Rebuild: `npm run build`

## Troubleshooting

### App won't start:
```bash
# Check if port is in use
lsof -i :4747

# Kill existing processes
pkill -f "electron.*jira"

# Check logs
tail -50 /tmp/jira-dashboard.log
```

### Icon not showing:
```bash
# Reinstall
bash install.sh
```

### Backend build fails:
```bash
# Ensure Go is installed
go version

# Clean and rebuild
rm -rf dist/
npm run build
```

## Uninstall

```bash
# Remove shortcuts
rm ~/Desktop/jira-dashboard.desktop
rm ~/.local/share/applications/jira-dashboard.desktop
rm ~/Documents/jira-dashboard.sh

# Remove project
rm -rf ~/Documents/tools/jira
```

## Platform Support

Currently supports **Linux only**. The backend binary is built for Linux.

To support other platforms:
- macOS: Build with `GOOS=darwin go build`
- Windows: Build with `GOOS=windows go build`

## License

MIT
