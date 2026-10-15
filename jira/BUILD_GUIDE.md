# Build & Deploy Jira Dashboard trên Linux

## Tl;dr

Binary đã build xong: `dist/jira-dashboard-linux` (45 MB)
Package đầy đủ: `dist/jira-dashboard-linux-x64.tar.gz` (18 MB)

### Chạy ngay:
```bash
./dist/jira-dashboard-linux
# Hoặc có file config:
cd dist/jira-dashboard-package
./setup.sh   # Hướng dẫn setup
./start.sh   # Chạy server
```

---

## Các option build

### 1. Single Binary (Gợi ý)
```bash
npm run build:linux
# Output: dist/jira-dashboard-linux (45 MB, standalone)
```
**Ưu điểm:**
- File chạy độc lập, không cần Node.js
- Dễ deploy, copy-paste trực tiếp
- Đã compress với Brotli

**Nhược điểm:**
- File lớn (45 MB)
- Chứa toàn bộ Node runtime

### 2. Complete Package
```bash
bash build-package.sh
# Output: dist/jira-dashboard-linux-x64.tar.gz (18 MB)
```
**Chứa:**
- Binary
- Tất cả file config mẫu (.env.example, config.json.example)
- Script setup & start
- Systemd service template
- README

---

## Deploy trên server Linux khác

### Cách 1: Copy binary thôi
```bash
scp dist/jira-dashboard-linux user@server:/opt/jira-dashboard/
ssh user@server
cd /opt/jira-dashboard
PORT=4747 ./jira-dashboard-linux
# Mở: http://server:4747
```

### Cách 2: Copy package (recommended)
```bash
scp dist/jira-dashboard-linux-x64.tar.gz user@server:/opt/
ssh user@server
cd /opt
tar xzf jira-dashboard-linux-x64.tar.gz
cd jira-dashboard-package
./setup.sh
./start.sh
```

### Cách 3: Setup systemd service
```bash
cd /opt/jira-dashboard-package

# 1. Edit service file
sudo nano jira-dashboard.service
# Thay CHANGE_THIS_USER bằng username
# Thay CHANGE_THIS_PATH bằng full path (/opt/jira-dashboard-package)

# 2. Install service
sudo cp jira-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable jira-dashboard
sudo systemctl start jira-dashboard

# 3. Check status
sudo systemctl status jira-dashboard
```

---

## Cấu hình

### File .env
Tạo từ `.env.example` - chứa các biến môi trường:
```bash
cp .env.example .env
# Điền credentials
```

### File config.json
Được tạo/sửa từ Settings UI của dashboard:
```bash
# Sau lần chạy đầu
cat config.json
# Chứa: Jira site, JQL filters, git repos, v.v.
```

---

## Troubleshooting

### Port 4747 đang dùng
```bash
# Option 1: Thay port
PORT=5555 ./jira-dashboard-linux

# Option 2: Kill process cũ
lsof -i :4747
kill -9 <PID>
```

### Cannot connect to Jira
1. Check .env - Jira site URL, token
2. Verify token còn hạn (8 giờ nếu dùng Claude Code token)
3. Nếu muốn auto-refresh: bấm "Enable auto-refresh" trong dashboard → đăng nhập OAuth 1 lần

### Binary không chạy
```bash
# Check file
file ./jira-dashboard-linux
# Phải là: ELF 64-bit LSB executable

# Make executable
chmod +x ./jira-dashboard-linux

# Run with debug
./jira-dashboard-linux 2>&1 | head -20
```

---

## Architecture

- **server.js**: HTTP server (Node.js)
- **lib/**: Backend logic (config, auth, Jira/Confluence API, git ops)
- **lib/mcp-server.js**: MCP protocol endpoint (cho Claude/Cursor)
- **public/**: Frontend (HTML/CSS/JS, không dùng bundler)
- **public/js/git/**: Git flow UI

---

## Security notes

- Server nghe chỉ `127.0.0.1`, không public
- Token không bao giờ gửi xuống browser
- MCP write tools cần header Authorization (token từ `.mcp-token`)
- Sandbox iframe cho description/comments từ Jira

---

## Build commands

```bash
# Single binary (all targets)
npm run build

# Linux x64 only
npm run build:linux

# Full package + tarball
bash build-package.sh

# Start dev (with hot reload)
npm start
```

---

## File sizes

```
jira-dashboard-linux:           45 MB (standalone binary)
jira-dashboard-linux-x64.tar.gz: 18 MB (package)
Extracted:                       ~200 MB (with lib + public)
```

---

## Advanced: Docker

Nếu muốn docker, tạo `Dockerfile`:

```dockerfile
FROM scratch
COPY dist/jira-dashboard-linux /jira-dashboard
EXPOSE 4747
CMD ["/jira-dashboard"]
```

Build:
```bash
docker build -t jira-dashboard .
docker run -p 4747:4747 jira-dashboard
```

---

Có gì cần help, xem log:
```bash
./start.sh 2>&1 | tee jira-dashboard.log
```
