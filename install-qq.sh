#!/bin/bash

# --- 颜色定义 ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}>>> 正在进行 OpenClaw NapCat 插件环境检查...${NC}"

# 1. 动态获取 NPM 全局安装路径，适配不同用户环境
NPM_ROOT=$(npm config get prefix)
PLUGIN_DIR="$NPM_ROOT/lib/node_modules/openclaw/extensions"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"

# 2. 自动将全局 bin 目录加入 PATH，确保脚本内能直接调用 openclaw
export PATH="$NPM_ROOT/bin:$PATH"

# 检查插件目录是否存在，不存在则创建
if [ ! -d "$PLUGIN_DIR" ]; then
    echo -e "${YELLOW}提示：未找到插件目录，正在创建: $PLUGIN_DIR${NC}"
    mkdir -p "$PLUGIN_DIR"
fi

# 检查 OpenClaw 配置文件是否存在
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}错误：未找到配置文件 $CONFIG_FILE${NC}"
    echo -e "${YELLOW}请确认 OpenClaw 是否已正确安装并运行过初始化。${NC}"
    exit 1
fi

echo -e "${CYAN}环境检查通过，准备集成插件到: $PLUGIN_DIR${NC}"

# 3. 克隆或更新插件代码
cd "$PLUGIN_DIR" || exit
if [ -d "qq" ]; then
    echo -e "${YELLOW}检测到 qq 插件目录已存在，正在拉取最新代码...${NC}"
    git -C qq pull
else
    echo -e "${CYAN}正在克隆 openclaw-napcat 仓库...${NC}"
    # 使用代理确保 NAS 网络环境稳定
    git clone https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git qq
fi

# 4. 安装插件依赖
echo -e "${CYAN}正在安装插件依赖...${NC}"
cd qq || exit
if command -v pnpm &> /dev/null; then
    pnpm install
else
    echo -e "${YELLOW}未找到 pnpm，尝试使用 npm 安装...${NC}"
    npm install
fi

# 5. 启用插件并验证
echo -e "\n${GREEN}>>> 正在启用并配置插件...${NC}"

if command -v openclaw &> /dev/null; then
    # 直接启用插件，OpenClaw 会自动在 extensions 目录下识别文件夹名为 qq 的插件
    openclaw plugins enable qq
    
    echo -e "${GREEN}-------------------------------------------${NC}"
    echo -e "${GREEN}安装并启用成功！${NC}"
    echo -e "${YELLOW}重要：请重启 OpenClaw (例如运行 openclaw restart) 以应用更改。${NC}"
    echo -e "${GREEN}-------------------------------------------${NC}"
    
    # 显示当前插件列表状态
    openclaw plugins list
else
    echo -e "${RED}错误：安装完成后仍无法调用 openclaw 命令，请检查环境变量。${NC}"
fi

echo -e "\n${CYAN}脚本运行完毕，祝你开发顺利！${NC}"
