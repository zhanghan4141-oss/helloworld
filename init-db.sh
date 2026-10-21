#!/usr/bin/env bash
# helloworld 项目数据库初始化脚本（凭据持久化，不锁死在外）
#
# 用法：
#   1) 指定密码：           DB_PASS=你的密码 bash init-db.sh
#   2) 自动生成随机强密码： bash init-db.sh   （密码写入同目录 .env，ubuntu 下 chmod 600）
#   3) 重复执行是幂等的：   已有 .env 则复用其中密码，不会换掉原来的库密码
#
# 密码保存：项目目录下 .env（已被 .gitignore 忽略，不会上传仓库）。
#   服务启动时自动读 .env（server.js 内置轻量加载），终端丢了也没关系。
#
# 兜底恢复：密码不是唯一的钥匙，管理员 root 随时可重置，无需知道旧密码：
#   mysql -u root -p -e "ALTER USER 'helloworld'@'localhost' IDENTIFIED BY '新密码'"
#   然后把新密码写进 .env 或 DB_PASS 环境变量后重启服务。

set -euo pipefail
umask 077
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"

# 读取 .env 里已有的密码（没有则空）
OLD_PASS="$(grep -E '^DB_PASS=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d '\r' || true)"

if [ -n "${DB_PASS:-}" ]; then
  PASSWORD="${DB_PASS}"
  echo "==> 使用你通过 DB_PASS 指定的密码"
elif [ -n "$OLD_PASS" ]; then
  PASSWORD="$OLD_PASS"
  echo "==> 复用 .env 中已有的密码（幂等重跑）"
else
  PASSWORD="$(openssl rand -hex 16)"
  echo "==> 自动生成随机强密码"
fi

printf 'DB_PASS=%s\n' "$PASSWORD" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "==> 密码已写入 $ENV_FILE（gitignore，不上传仓库；权限 600）"

sudo mysql <<SQL
CREATE DATABASE IF NOT EXISTS helloworld DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'helloworld'@'localhost' IDENTIFIED BY '${PASSWORD}';
GRANT ALL PRIVILEGES ON helloworld.* TO 'helloworld'@'localhost';
FLUSH PRIVILEGES;
USE helloworld;
CREATE TABLE IF NOT EXISTS messages (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  content    TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SQL

echo "==> 初始化完成。直接启动即可（服务会自动读 .env）："
echo "    node server.js   # 或 pm2 start server.js --name helloworld"