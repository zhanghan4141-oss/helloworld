-- helloworld 项目数据库初始化脚本
-- 使用方式: sudo mysql < init-db.sql
-- 或指定用户: mysql -u root -p < init-db.sql

CREATE DATABASE IF NOT EXISTS helloworld DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'helloworld'@'localhost' IDENTIFIED BY 'hw2026secure';
GRANT ALL PRIVILEGES ON helloworld.* TO 'helloworld'@'localhost';
FLUSH PRIVILEGES;

USE helloworld;

CREATE TABLE IF NOT EXISTS messages (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  content    TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
