# Jira Dashboard - Build Output

## 📦 Artifacts

```
dist/
├── jira-dashboard-linux              (45 MB) - Standalone binary
├── jira-dashboard-linux.sha256       - Checksum
├── jira-dashboard-linux-x64.tar.gz   (18 MB) - Complete package
├── jira-dashboard-linux-x64.tar.gz.sha256
└── jira-dashboard-package/           - Package directory (before compression)
    ├── jira-dashboard-linux
    ├── .env.example
    ├── config.json.example
    ├── README.md
    ├── setup.sh                      ← Run this first
    ├── start.sh                      ← Then this
    ├── jira-dashboard.service        - Systemd template
    ├── public/                       - Web UI (HTML/CSS/JS)
    └── lib/                          - Backend code
```

## 🚀 Quick Start

### Option 1: Binary only
```bash
./dist/jira-dashboard-linux
```

### Option 2: Full package (recommended)
```bash
cd dist
tar xzf jira-dashboard-linux-x64.tar.gz
cd jira-dashboard-package
./setup.sh
./start.sh
```

### Option 3: Systemd service
```bash
# Extract package
tar xzf dist/jira-dashboard-linux-x64.tar.gz
cd jira-dashboard-package

# Setup service
sudo cp jira-dashboard.service /etc/systemd/system/
sudo sed -i 's|CHANGE_THIS_USER|'$USER'|g' /etc/systemd/system/jira-dashboard.service
sudo sed -i "s|CHANGE_THIS_PATH|$(pwd)|g" /etc/systemd/system/jira-dashboard.service

# Enable & start
sudo systemctl daemon-reload
sudo systemctl enable jira-dashboard
sudo systemctl start jira-dashboard

# Monitor
sudo journalctl -u jira-dashboard -f
```

## 📋 Verify Integrity

```bash
cd dist
sha256sum -c jira-dashboard-linux.sha256
sha256sum -c jira-dashboard-linux-x64.tar.gz.sha256
```

Expected:
```
jira-dashboard-linux: OK
jira-dashboard-linux-x64.tar.gz: OK
```

## 🔧 Configuration

### .env (optional)
Biến môi trường:
- `PORT` - Server port (default: 4747)
- `NODE_ENV` - Chế độ (development/production)

### config.json (via UI)
Settings từ dashboard:
- Jira site & credentials
- JQL filters
- Git repositories
- Refresh interval

## 📊 File Sizes

| File | Size | Type |
|------|------|------|
| jira-dashboard-linux | 45 MB | x86-64 binary |
| jira-dashboard-linux-x64.tar.gz | 18 MB | Compressed package |

## 🌐 Browser Access

```
http://localhost:4747
```

## 🔐 Security

- Listens on `127.0.0.1` only (no public network exposure)
- Token stored locally in `.mcp-token`
- MCP write tools require Authorization header
- WebUI descriptions sandboxed in iframe

## 📝 Logs

Direct output:
```bash
./jira-dashboard-linux 2>&1 | tee logs.txt
```

Systemd:
```bash
journalctl -u jira-dashboard -f
```

## 🛠️ Rebuild

```bash
# From source directory
cd /home/pnlongdc/Documents/tools/jira

# Build binary only
npm run build:linux

# Build full package
bash build-package.sh
```

## ⚠️ Troubleshooting

### Port already in use
```bash
PORT=5555 ./jira-dashboard-linux
```

### Binary not executable
```bash
chmod +x ./jira-dashboard-linux
```

### Cannot connect to Jira
1. Edit `.env` - check credentials
2. Verify Jira site URL
3. Check if token expired

### Clean systemd service
```bash
sudo systemctl stop jira-dashboard
sudo systemctl disable jira-dashboard
sudo rm /etc/systemd/system/jira-dashboard.service
sudo systemctl daemon-reload
```

## 📚 Documentation

- `BUILD_GUIDE.md` - Full build & deployment guide
- `dist/jira-dashboard-package/README.md` - Setup instructions
- Source: `/home/pnlongdc/Documents/tools/jira`

## 🔄 Version Info

- Built with: `pkg@5.8.1`
- Node.js: `18.x`
- Compression: Brotli
- Architecture: x86-64 Linux
- Build date: October 15, 2026

---

**Next steps:**
1. Extract package or copy binary
2. Create `.env` file (optional)
3. Run `./setup.sh` or `./start.sh`
4. Open http://localhost:4747
5. Configure in Settings
