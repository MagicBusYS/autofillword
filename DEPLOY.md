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
sudo certbot --nginx -d autofill.example.com
# 按提示填邮箱、同意条款，选择"重定向 HTTP 到 HTTPS"
```

证书自动续期（certbot 已装定时器，验证一下）：

```bash
sudo certbot renew --dry-run
```

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

**7. 想彻底清空服务器数据**
```bash
sudo systemctl stop autofill
sudo rm -rf /var/lib/autofill/data/jobs.json /var/lib/autofill/uploads /var/lib/autofill/outputs
sudo systemctl start autofill
```
（`settings.json` 是 AI 配置，删了要重新配）
