#!/bin/bash

# --- 颜色定义 ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

# --- 动态路径定义 ---
# 使用 $HOME 变量自动获取当前用户目录
GLOBAL_NPM_DIR="$HOME/.npm-global"
PLUGIN_DIR="$GLOBAL_NPM_DIR/lib/node_modules/openclaw/extensions"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"

echo -e "${GREEN}>>> 正在为用户 ${CYAN}$(whoami)${NC}${GREEN} 配置 OpenClaw NapCat 插件...${NC}"

# 1. 检查并创建插件目录
if [ ! -d "$PLUGIN_DIR" ]; then
    echo -e "${YELLOW}提示：目录 $PLUGIN_DIR 不存在，正在尝试创建...${NC}"
    mkdir -p "$PLUGIN_DIR"
    if [ $? -ne 0 ]; then
        echo -e "${RED}错误：无法创建目录，请检查权限。${NC}"
        exit 1
    fi
fi

# 2. 检查配置文件
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}错误：未找到配置文件 $CONFIG_FILE${NC}"
    echo -e "${YELLOW}请先运行一次 openclaw 以确保初始化完成。${NC}"
    exit 1
fi

# 3. 集成代码
echo -e "${CYAN}进入插件目录: $PLUGIN_DIR${NC}"
cd "$PLUGIN_DIR" || exit

if [ -d "qq" ]; then
    echo -e "${YELLOW}检测到 qq 文件夹已存在，准备更新代码...${NC}"
    git -C qq pull
else
    echo -e "${CYAN}正在克隆 openclaw-napcat 仓库...${NC}"
    # 使用代理克隆
    git clone https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git qq
fi

# 4. 安装依赖
echo -e "${CYAN}安装插件依赖...${NC}"
cd qq || exit

# 优先使用 pnpm，如果没有则退回到 npm
if command -v pnpm &> /dev/null; then
    pnpm install
else
    npm install
fi

# 5. 强制注册插件
echo -e "\n${GREEN}>>> 正在同步 OpenClaw 配置...${NC}"

if command -v openclaw &> /dev/null; then
    # 使用 add 命令手动关联，解决 Invalid config 问题
    openclaw plugins add "$PLUGIN_DIR/qq"
    echo -e "${GREEN}插件关联成功！${NC}"
    
    echo -e "\n${YELLOW}当前插件列表：${NC}"
    openclaw plugins list
else
    # 如果找不到 openclaw，尝试搜寻用户自定义的 bin 目录
    echo -e "${RED}未在 PATH 中找到 openclaw 命令。${NC}"
    echo -e "${YELLOW}请确保 $GLOBAL_NPM_DIR/bin 已加入环境变量。${NC}"
fi

echo -e "\n${GREEN}-------------------------------------------${NC}"
echo -e "集成完成！"
echo -e "用户: ${CYAN}$(whoami)${NC}"
echo -e "位置: ${CYAN}$PLUGIN_DIR/qq${NC}"
echo -e "${GREEN}-------------------------------------------${NC}"
