# 部署到 Ubuntu 云服务器

适用于 Ubuntu 20.04 / 22.04 / 24.04。下面以域名 `autofill.example.com` 为例，部署目录 `/opt/autofill`，数据目录 `/var/lib/autofill`。

> 架构要点：**知识库存在访问者浏览器里**，服务器只保存 AI 配置和临时文件。所以服务器不需要数据库，也不存用户资料。

---

## 一、准备

```bash
# 1) 更新系统
sudo apt update && sudo apt upgrade -y

# 2) 安装基础工具
sudo apt install -y curl git nginx

# 3) 域名解析（如果要用域名 + HTTPS）
#    在域名服务商把 autofill.example.com 的 A 记录指向服务器公网 IP
```

防火墙（阿里云/腾讯云还需在控制台"安全组"放行 80、443）：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

---

## 二、安装 Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # 应为 v20.x
npm -v
```

> 不建议用 Ubuntu 自带的 `apt install nodejs`（版本偏旧）。

---

## 三、上传代码

### 方式 A：从 GitHub 克隆（推荐）

```bash
sudo git clone https://github.com/MagicBusYS/autofillword /tmp/autofill-src
```

私有仓库需要凭据（Deploy Key 或 Personal Access Token）：

```bash
# 用 PAT（替换成你的 token）
sudo git clone https://<用户名>:<token>@github.com/MagicBusYS/autofillword /tmp/autofill-src
```

后续升级直接 `cd /opt/autofill && sudo git pull` 即可（见第十节）。

### 方式 B：从本地直接上传

在**本地**项目目录执行（Windows 用 PowerShell / Git Bash）：

```bash
scp -r package.json package-lock.json server public deploy README.md \
    root@服务器IP:/tmp/autofill-src
```

然后在服务器上建立目录并授权：

```bash
# 运行账号（不能用 root 跑 Node 服务）
sudo useradd --system --create-home --shell /usr/sbin/nologin autofill || true

# 代码目录
sudo mkdir -p /opt/autofill
sudo cp -r /tmp/autofill-src/. /opt/autofill/
sudo chown -R autofill:autofill /opt/autofill

# 数据目录（放配置和临时文件，升级代码不会覆盖）
sudo mkdir -p /var/lib/autofill
sudo chown -R autofill:autofill /var/lib/autofill
sudo chmod 750 /var/lib/autofill
```

---

## 四、安装依赖

```bash
cd /opt/autofill
sudo -u autofill npm ci --omit=dev
```

> `--omit=dev` 跳过测试用的 form-data，生产环境不需要。
> 国内服务器如果下载慢，先切镜像：`sudo -u autofill npm config set registry https://registry.npmmirror.com`

---

## 五、配置 systemd 守护进程

```bash
sudo cp /opt/autofill/deploy/autofill.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now autofill
sudo systemctl status autofill --no-pager
```

看到 `active (running)` 即可。本机自测：

```bash
curl http://127.0.0.1:3000/api/health
# {"ok":true,"uptime":1,"storage":"/var/lib/autofill"}
```

常用命令：

```bash
sudo systemctl restart autofill     # 重启
sudo journalctl -u autofill -f      # 看日志
sudo journalctl -u autofill -n 100  # 最近 100 行
```

---

## 六、配置 Nginx 反向代理

```bash
sudo cp /opt/autofill/deploy/nginx.conf /etc/nginx/sites-available/autofill
# 把域名改成你自己的；没有域名就写服务器公网 IP，或改成 `_`
sudo sed -i 's/autofill.example.com/你的域名或IP/g' /etc/nginx/sites-available/autofill

sudo ln -sf /etc/nginx/sites-available/autofill /etc/nginx/sites-enabled/autofill
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

浏览器打开 `http://你的域名或IP`，应能看到填充工作台。没有域名时跳过第七步的 HTTPS。

配置里已处理三件容易踩坑的事：

| 配置 | 原因 |
|---|---|
| `proxy_set_header Host $host;` | 设置页按 Host 判断是否本机访问，**必须透传** |
| `client_max_body_size 60m;` | 应用允许 50MB 上传，Nginx 默认 1MB 会 413 |
| `proxy_read_timeout 180s;` | AI 分析可能较慢，默认 60s 会 504 |

---

## 七、启用 HTTPS（强烈建议）

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d magicbus.asia -d www.magicbus.asia
# 按提示填邮箱、同意条款，选择"重定向 HTTP 到 HTTPS"
```

证书自动续期（certbot 已装定时器，验证一下）：

```bash
sudo certbot renew --dry-run
```

### 用域名 magicbus.asia 时还要改什么

**1) Nginx 的 server_name**（已默认写好 `magicbus.asia www.magicbus.asia`）

如果不是从仓库的 `deploy/nginx.conf` 拷贝的，手动改：

```bash
sudo sed -i 's/server_name .*;/server_name magicbus.asia www.magicbus.asia;/' /etc/nginx/sites-available/autofill
sudo nginx -t && sudo systemctl reload nginx
```

**2) 阿里云安全组放行 80 / 443**（控制台 → ECS → 安全组 → 入方向）

只放 80/443 就够，业务端口 3000 不要对公网开放。

**3) 服务器时区设为北京时间**

否则跨零点时自动填的"填表日期"会差一天（应用已改为优先用访问者浏览器的日期，但仍建议设置）：

```bash
sudo timedatectl set-timezone Asia/Shanghai
timedatectl    # 确认 Time zone: Asia/Shanghai (CST, +0800)
```

**4) ICP 备案（中国大陆地域的服务器必须）**

> ⚠️ 这是域名能否访问的前提，不是可选项。

- 阿里云**大陆地域**的 ECS：域名解析到公网 IP 后，**未备案的域名访问 80/443 会被阿里云拦截**（出现"该网站尚未备案"的提示页），与代码无关。需先在阿里云备案系统提交，通常 7~20 个工作日。
- `.asia` 后缀：工信部已批复，可以备案；但**北京管局明确不受理 .asia**（按国别域名处理），备案主体在北京建议换 `.com` / `.cn`。
- 阿里云**香港或海外地域**的 ECS：不需要备案，解析生效即可访问。

备案通过前想先用：直接访问 `http://服务器公网IP`（IP 访问通常不受备案拦截，但 HTTPS 证书需要域名，且部分服务商会提示）。

**5) 备案/证书未就绪时的临时方案**

用 IP 访问 + 自签证书，或先只开 80 做功能验证；证书可用 DNS-01 方式签发（不依赖 80 端口）：

```bash
sudo apt install -y python3-certbot-dns-aliyun  # 需配置阿里云 AccessKey
sudo certbot certonly --authenticator dns-aliyun \
  --dns-aliyun-credentials /etc/letsencrypt/aliyun.ini \
  -d magicbus.asia -d www.magicbus.asia
```

**6) 用域名访问后，设置页与监控台需要登录（默认）**

设置页（AI 配置）和监控台（访问统计）对公网开放但受密码保护，只有持有密码的你能进入。

**① 在服务器上设置管理密码**

```bash
sudo bash -c 'cat > /etc/autofill.env' <<'EOF'
ADMIN_PASSWORD=换成你自己的强密码
EOF
sudo chmod 600 /etc/autofill.env
sudo systemctl restart autofill
```

> ⚠️ 密码必须以**明文经 HTTPS** 提交才安全。**务必先完成第七步的 HTTPS**，否则密码会以明文在网络上传输。
> 密码至少 12 位，建议字母+数字+符号；不需要记忆复杂的话用一句长短语（如 `autofill-2026-MagicBus`）。

**② 访问方式**

浏览器直接打开：

- 设置页：`https://magicbus.asia/settings.html`
- 监控台：`https://magicbus.asia/admin.html`

未登录会自动跳到 `https://magicbus.asia/admin-login.html`，输入密码后 7 天内免登录（签名 Cookie），导航栏会出现「退出登录」。

**③ 忘记密码 / 关闭远程管理**

```bash
# 改密码（旧会话立即失效）
sudo sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=新密码/' /etc/autofill.env
sudo systemctl restart autofill

# 彻底关闭远程管理（恢复"仅本机"）
sudo rm -f /etc/autofill.env && sudo systemctl restart autofill
```

**④ 安全机制**

| 机制 | 说明 |
| --- | --- |
| 密码存储 | 只在环境变量里，不写数据库、不进代码仓库 |
| 会话 | HMAC-SHA256 签名 Cookie，7 天有效，改密码即失效 |
| 防爆破 | 同 IP 连续 5 次密码错误，锁定 10 分钟 |
| 传输 | 勾选 Secure（HTTPS 下才发送），HttpOnly 防 XSS 读取 |
| 本机 | `localhost` / `127.0.0.1` 访问仍然免登录，方便服务器上直接操作 |

**⑤ 备用方式：SSH 隧道（不设密码时可用）**

```bash
ssh -N -L 127.0.0.1:3001:127.0.0.1:3000 root@服务器IP
# 本地打开 http://127.0.0.1:3001/admin.html
```

访问统计保存在 `$STORAGE_DIR/data/metrics.json`，可随 AI 配置一起备份。

---

## 八、配置 AI（服务器上做一次）

应用**默认不允许远程访问设置页**（避免 AI Key 被看到或改动）。在服务器上通过本机地址配置：

```bash
# 方式 A：直接调接口（推荐，最快）
curl -X POST http://127.0.0.1:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{"baseUrl":"https://api.deepseek.com","model":"deepseek-chat","apiKey":"sk-你的key"}'

# 验证
curl -X POST http://127.0.0.1:3000/api/settings/test
# {"ok":true,"message":"连接成功（deepseek-chat），模型回复：正常"}
```

方式 B：SSH 端口转发，用浏览器打开设置页：

```bash
# 在你本地电脑执行
ssh -L 3000:127.0.0.1:3000 root@服务器IP
# 然后本地浏览器访问 http://localhost:3000/settings.html
```

> 为什么远程打不开设置页：`/settings.html` 和 `/api/settings*` 只允许 Host 为 localhost/127.0.0.1 的请求，其余返回 403。这是刻意设计。

---

## 九、上线检查清单

| 检查项 | 命令 / 操作 | 期望 |
|---|---|---|
| 服务在跑 | `systemctl status autofill` | active (running) |
| 健康检查 | `curl -s 你的域名/api/health` | `{"ok":true,...}` |
| 首页可访问 | 浏览器打开 `https://你的域名` | 显示填充工作台 |
| 设置页已隐藏 | 导航栏 | 只有「填充工作台」「知识库」 |
| 设置页被拦截 | 直接访问 `/settings.html` | 红色提示「仅限本机访问」 |
| 上传能过 Nginx | 传一个 10MB 文件 | 不报 413 |
| AI 可用 | 上传模板后看提示 | 「AI 已分析 N 个候选位置」 |
| 临时文件会清 | `sudo ls /var/lib/autofill/uploads` | 写回后为空 |

---

## 十、日常运维

### 升级代码

```bash
# 方式 A：GitHub 仓库（推荐）
cd /opt/autofill
sudo -u autofill git pull
sudo -u autofill npm ci --omit=dev
sudo systemctl restart autofill

# 方式 B：本地 rsync 上传
sudo rsync -av --exclude node_modules --exclude storage /tmp/autofill-src/ /opt/autofill/
cd /opt/autofill && sudo -u autofill npm ci --omit=dev
sudo systemctl restart autofill
```

`STORAGE_DIR=/var/lib/autofill` 保证升级不会覆盖 AI 配置。

### 备份

需要备份的只有 AI 配置：

```bash
sudo cp /var/lib/autofill/data/settings.json ~/autofill-settings-$(date +%F).json
```

**知识库不需要在服务器备份**——它在每个用户的浏览器里。请告知用户使用知识库页面的「导出备份」。

### 日志

```bash
sudo journalctl -u autofill --since "1 hour ago" --no-pager
```

### 限流（可选）

公网开放后建议给上传接口加限流，防止被刷：

```nginx
# 在 nginx.conf 的 http {} 块外定义：limit_req_zone $binary_remote_addr zone=api:10m rate=30r/m;
location /api/fill {
    limit_req zone=api burst=5 nodelay;
    proxy_pass http://127.0.0.1:3000;
    # ... 其余 proxy_* 同 location /
}
```

---

## 十一、Docker 方式（可选）

服务器上装好 Docker 后：

```bash
cd /opt/autofill
sudo docker compose -f deploy/docker-compose.yml up -d --build
sudo docker compose -f deploy/docker-compose.yml logs -f
```

容器内 `HOST=0.0.0.0`，端口只映射到宿主机 `127.0.0.1:3000`，仍由宿主机 Nginx 对外。数据卷 `autofill-data` 对应 `/var/lib/autofill`。

---

## 十二、常见问题

**1. 打开页面 502 Bad Gateway**
Node 服务没起来。`sudo journalctl -u autofill -n 50` 看报错，常见是 `EADDRINUSE`（端口被占）或依赖没装。

**2. 上传大文件报 413**
Nginx `client_max_body_size` 没生效，确认改的是 `sites-enabled` 实际引用的那个文件，改完 `sudo nginx -t && sudo systemctl reload nginx`。

**3. AI 分析超时 / 504**
确认 `proxy_read_timeout` ≥ 180s；若用的是很慢的模型（如 reasoning 类），可调到 300s。

**4. 设置页在远程也能打开（不应该）**
说明反代把 Host 改写成了 localhost。检查 `proxy_set_header Host $host;`，不要写成固定值。

**5. 中文文件名变乱码**
应用已做编码修正；若仍异常，检查 Nginx 未对 URL 做二次编码（本配置不涉及）。

**6. 上传后提示 EACCES**
`/var/lib/autofill` 权限不对：
```bash
sudo chown -R autofill:autofill /var/lib/autofill
```

**6. 更新前端后样式不对 / 按钮位置变了**
八成是服务器上的 `style.css` 没更新，或浏览器用了旧缓存（旧版 Nginx 配置给 `/assets/` 设了 7 天缓存）。

```bash
# ① 确认服务器上的文件是新的
grep -c "confirm-actions" /opt/autofill/public/index.html
grep -c "confirm-actions" /opt/autofill/public/assets/style.css
# 两个都应 ≥1；若有一边是 0，说明代码没拉全
cd /opt/autofill && sudo -u autofill git pull && sudo systemctl restart autofill

# ② 让浏览器强制刷新
#    Windows: Ctrl + F5（或 Ctrl + Shift + R）
#    或 F12 打开开发者工具 → Network 勾选 "Disable cache" 后刷新
```

Nginx 配置已改为 `/assets/` 不缓存（`no-cache` + ETag 协商），避免以后再出现"代码更新了但页面样式没变"。

**7. 想彻底清空服务器数据**
```bash
sudo systemctl stop autofill
sudo rm -rf /var/lib/autofill/data/jobs.json /var/lib/autofill/uploads /var/lib/autofill/outputs
sudo systemctl start autofill
```
（`settings.json` 是 AI 配置，删了要重新配）
