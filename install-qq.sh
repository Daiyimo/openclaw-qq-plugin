#!/bin/bash

# --- 颜色定义 ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}>>> 正在进行环境前置检查...${NC}"

# 1. 动态获取 NPM 全局安装路径 (最核心的修改)
NPM_ROOT=$(npm config get prefix)
PLUGIN_DIR="$NPM_ROOT/lib/node_modules/openclaw/extensions"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"

# 2. 自动修正 PATH，确保能找到 openclaw 命令
export PATH="$NPM_ROOT/bin:$PATH"

# 检查插件目录是否存在
if [ ! -d "$PLUGIN_DIR" ]; then
    echo -e "${YELLOW}提示：未找到插件目录 $PLUGIN_DIR，尝试创建...${NC}"
    mkdir -p "$PLUGIN_DIR"
fi

# 检查配置文件
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}错误：未找到配置文件 $CONFIG_FILE${NC}"
    exit 1
fi

echo -e "${CYAN}环境检查通过，当前路径: $PLUGIN_DIR${NC}"

# 3. 下载/更新代码
cd "$PLUGIN_DIR" || exit
if [ -d "qq" ]; then
    echo -e "${YELLOW}更新已存在的 qq 插件...${NC}"
    git -C qq pull
else
    echo -e "${CYAN}克隆 openclaw-napcat 仓库...${NC}"
    git clone https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git qq
fi

# 4. 安装依赖
cd qq || exit
echo -e "${CYAN}正在安装依赖...${NC}"
if command -v pnpm &> /dev/null; then
    pnpm install
else
    npm install
fi

# 5. 自动启用并注册
echo -e "\n${GREEN}>>> 正在启用插件...${NC}"
if command -v openclaw &> /dev/null; then
    # 这一步非常关键：手动添加路径
    openclaw plugins add "$PLUGIN_DIR/qq"
    openclaw plugins enable qq
    echo -e "${GREEN}安装并启用成功！${NC}"
    openclaw plugins list
else
    echo -e "${RED}错误：找不到 openclaw 命令，请检查安装。${NC}"
fi
