#!/usr/bin/env bash
# helloworld 项目数据库初始化脚本（替代旧版把密码写死的 init-db.sql）
#
# 用法：
#   1) 自动生成随机强密码：        bash init-db.sh
#   2) 复用你指定/已有的密码：     DB_PASS=你的密码 bash init-db.sh
#
# 执行完成后，用脚本输出的密码启动服务：
#     DB_PASS=<输出的密码> node server.js
# 或写入环境（systemd/pm2/export）。
#
# 注意：
#   - 用户已存在时密码不会被本脚本修改（CREATE IF NOT EXISTS），
#     想改密码用：mysql -u root -p -e "ALTER USER 'helloworld'@'localhost' IDENTIFIED BY '新密码'"
#   - 仓库里不存放任何密码，避免凭据随代码公开。

set -euo pipefail

PASSWORD="${DB_PASS:-$(openssl rand -hex 16)}"

echo "==> 数据库密码: ${PASSWORD}"
echo "    （首次创建将使用该密码；用户已存在则保持不变。启动服务时设为环境变量 DB_PASS）"

mysql -u root -p <<SQL
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

echo "==> 初始化完成。启动示例："
echo "    DB_PASS='${PASSWORD}' node server.js"