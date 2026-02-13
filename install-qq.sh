#!/bin/bash

# --- 颜色定义 ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

# 路径定义
PLUGIN_DIR="/usr/lib/node_modules/openclaw/extensions"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"

echo -e "${GREEN}>>> 正在进行环境前置检查...${NC}"

# 1. 检查全局插件目录是否存在
if [ ! -d "$PLUGIN_DIR" ]; then
    echo -e "${RED}错误：未找到插件目录 $PLUGIN_DIR${NC}"
    echo -e "${YELLOW}请先全局安装 OpenClaw 核心程序。${NC}"
    exit 1
fi

# 2. 检查配置文件是否存在
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}错误：未找到配置文件 $CONFIG_FILE${NC}"
    echo -e "${YELLOW}请先运行一次 openclaw 以生成默认配置文件。${NC}"
    exit 1
fi

echo -e "${CYAN}环境检查通过，准备集成插件...${NC}"

# 3. 进入插件目录并下载/更新代码
cd "$PLUGIN_DIR" || exit
if [ -d "qq" ]; then
    echo -e "${YELLOW}检测到 qq 插件目录已存在，正在尝试更新...${NC}"
    sudo git -C qq pull
else
    echo -e "${CYAN}正在克隆 openclaw-napcat 仓库...${NC}"
    sudo git clone https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git qq
fi

# 4. 处理插件依赖
cd qq || exit
if ! command -v pnpm &> /dev/null; then
    echo -e "${YELLOW}正在安装 pnpm...${NC}"
    sudo npm install -g pnpm
fi

echo -e "${CYAN}正在安装项目依赖...${NC}"
sudo pnpm install

echo -e "\n${GREEN}>>> 正在启用并验证插件...${NC}"

# 5. 启用插件并检查列表
if command -v openclaw &> /dev/null; then
    openclaw plugins enable qq
    echo -e "\n${YELLOW}当前 OpenClaw 插件状态：${NC}"
    openclaw plugins list
else
    echo -e "${RED}未检测到 openclaw 命令，请确保已正确安装核心程序。${NC}"
fi

echo -e "\n${GREEN}-------------------------------------------${NC}"
echo -e "集成操作完成！"
echo -e "${YELLOW}请注意：你需要手动编辑 $CONFIG_FILE 来配置 NapCat 连接参数。${NC}"
echo -e "祝你开发顺利！"
echo -e "${GREEN}-------------------------------------------${NC}"
