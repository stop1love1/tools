#!/bin/bash
# Build và đóng gói Jira dashboard thành package chạy được trên Linux

set -e

echo "Building Linux binary..."
npm run build:linux

echo ""
echo "Creating distribution package..."

# Tạo thư mục package
PKG_DIR="dist/jira-dashboard-package"
rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR"

# Copy binary
cp dist/jira-dashboard-linux "$PKG_DIR/"

# Copy các file static (public/)
cp -r public "$PKG_DIR/"

# Copy các lib cần thiết
cp -r lib "$PKG_DIR/"

# Copy file config mẫu
cp .env.example "$PKG_DIR/"
cp config.json "$PKG_DIR/config.json.example" 2>/dev/null || echo "{}" > "$PKG_DIR/config.json.example"

# Tạo README cho package
cat > "$PKG_DIR/README.md" << 'EOF'
# Jira Dashboard - Linux Binary

## Cài đặt nhanh

1. Giải nén package này vào thư mục bất kỳ
2. Tạo file `.env` từ `.env.example` và điền thông tin
3. Chạy: `./jira-dashboard-linux`
4. Mở browser: http://localhost:4747

## Cấu hình

- File `.env`: cấu hình môi trường (optional)
- File `config.json`: cấu hình chi tiết (tạo từ Settings UI)
- Thư mục `public/`: static files (HTML/CSS/JS)
- Thư mục `lib/`: server logic

## Yêu cầu

- Linux x86_64
- Không cần cài Node.js (đã bundle sẵn)

## Chạy như service

Tạo systemd service file: `/etc/systemd/system/jira-dashboard.service`

```
[Unit]
Description=Jira Dashboard
After=network.target

[Service]
Type=simple
User=yourusername
WorkingDirectory=/path/to/jira-dashboard-package
ExecStart=/path/to/jira-dashboard-package/jira-dashboard-linux
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Sau đó:
```bash
sudo systemctl daemon-reload
sudo systemctl enable jira-dashboard
sudo systemctl start jira-dashboard
```

## Port

Mặc định: 4747. Đổi trong Settings hoặc biến `PORT` trong `.env`
EOF

# Tạo script khởi động
cat > "$PKG_DIR/start.sh" << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
./jira-dashboard-linux "$@"
EOF
chmod +x "$PKG_DIR/start.sh"

# Tạo file systemd service mẫu
cat > "$PKG_DIR/jira-dashboard.service" << 'EOF'
[Unit]
Description=Jira Dashboard
After=network.target

[Service]
Type=simple
User=CHANGE_THIS_USER
WorkingDirectory=CHANGE_THIS_PATH
ExecStart=CHANGE_THIS_PATH/jira-dashboard-linux
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

echo ""
echo "Creating tarball..."
cd dist
tar czf jira-dashboard-linux-x64.tar.gz jira-dashboard-package/
cd ..

echo ""
echo "✓ Build completed!"
echo ""
echo "Output files:"
echo "  - dist/jira-dashboard-linux (standalone binary)"
echo "  - dist/jira-dashboard-linux-x64.tar.gz (complete package)"
echo ""
echo "Package size:"
ls -lh dist/jira-dashboard-linux-x64.tar.gz
echo ""
echo "To deploy:"
echo "  1. Copy dist/jira-dashboard-linux-x64.tar.gz to target server"
echo "  2. tar xzf jira-dashboard-linux-x64.tar.gz"
echo "  3. cd jira-dashboard-package"
echo "  4. ./start.sh"
