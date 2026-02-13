#!/bin/bash

# --- 颜色定义 ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}>>> 正在进行 OpenClaw NapCat 插件环境检查...${NC}"

# 1. 动态路径识别
NPM_ROOT=$(npm config get prefix)
PLUGIN_DIR="$NPM_ROOT/lib/node_modules/openclaw/extensions"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"
export PATH="$NPM_ROOT/bin:$PATH"

# 2. 核心：配置 Git 在本次会话中自动接受 GitHub 指纹
# 这样就不会弹出 (yes/no) 的提示了
export GIT_SSH_COMMAND="ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no"

# 检查并创建目录
if [ ! -d "$PLUGIN_DIR" ]; then
    echo -e "${YELLOW}提示：创建插件目录: $PLUGIN_DIR${NC}"
    mkdir -p "$PLUGIN_DIR"
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}错误：未找到 $CONFIG_FILE${NC}"
    exit 1
fi

# 3. 克隆或更新代码 (强制使用 HTTPS 减少 SSH 权限问题)
cd "$PLUGIN_DIR" || exit
if [ -d "qq" ]; then
    echo -e "${YELLOW}检测到 qq 插件，正在更新...${NC}"
    # 使用 -c 选项临时跳过配置检查
    git -c core.sshCommand="$GIT_SSH_COMMAND" -C qq pull
else
    echo -e "${CYAN}正在克隆仓库 (通过代理)...${NC}"
    # 建议使用 HTTPS 链接，它比 SSH 更少出指纹问题
    git clone https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git qq
fi

# 4. 安装依赖
echo -e "${CYAN}安装依赖中...${NC}"
cd qq || exit
if command -v pnpm &> /dev/null; then
    pnpm install
else
    npm install
fi

# 5. 启用插件
echo -e "\n${GREEN}>>> 正在启用插件...${NC}"
if command -v openclaw &> /dev/null; then
    openclaw plugins enable qq
    echo -e "${GREEN}-------------------------------------------${NC}"
    echo -e "${GREEN}安装并启用成功！${NC}"
    echo -e "${YELLOW}请重启 OpenClaw 以应用配置。${NC}"
    echo -e "${GREEN}-------------------------------------------${NC}"
    openclaw plugins list
else
    echo -e "${RED}错误：找不到 openclaw 命令。${NC}"
fi
