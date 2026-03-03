#!/bin/bash
# pnpm 磁盘空间检查脚本

echo "======================================"
echo "pnpm 磁盘空间分析工具"
echo "======================================"
echo ""

# 检查 pnpm 是否安装
if ! command -v pnpm &> /dev/null; then
    echo "❌ 未检测到 pnpm，请先安装 pnpm"
    echo "   安装命令: npm install -g pnpm"
    exit 1
fi

echo "✅ pnpm 版本: $(pnpm --version)"
echo ""

# 函数：从环境配置文件读取 PROJECT_SOURCE_DIR
get_project_dir_from_env() {
    local env_name=${1:-"development"}
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local project_root="$(dirname "$script_dir")"
    local env_file="$project_root/env.$env_name"
    
    if [ -f "$env_file" ]; then
        # 从 env 文件中读取 PROJECT_SOURCE_DIR
        local project_dir=$(grep "^PROJECT_SOURCE_DIR=" "$env_file" | cut -d'=' -f2)
        if [ -n "$project_dir" ]; then
            echo "$project_dir"
            return 0
        fi
    fi
    
    return 1
}

# 检查 store 路径
echo "📁 pnpm Store 路径:"
STORE_PATH=$(pnpm store path 2>/dev/null)
STORE_FILESYSTEM=""
if [ -n "$STORE_PATH" ]; then
    echo "   $STORE_PATH"
    
    # 检查 store 大小
    if [ -d "$STORE_PATH" ]; then
        STORE_SIZE=$(du -sh "$STORE_PATH" 2>/dev/null | awk '{print $1}')
        echo "   Store 大小: $STORE_SIZE"
        
        # 获取 store 所在的文件系统
        STORE_FILESYSTEM=$(df "$STORE_PATH" 2>/dev/null | tail -n 1 | awk '{print $1}')
        if [ -n "$STORE_FILESYSTEM" ]; then
            echo "   文件系统: $STORE_FILESYSTEM"
        fi
    fi
else
    echo "   ⚠️  无法获取 store 路径"
fi
echo ""

# 检查 store 状态
echo "📊 pnpm Store 状态:"
STORE_STATUS_OUTPUT=$(pnpm store status 2>&1)
STORE_STATUS_EXIT_CODE=$?

if [ $STORE_STATUS_EXIT_CODE -eq 0 ]; then
    echo "$STORE_STATUS_OUTPUT"
else
    # 检查是否是 ENOENT 错误（索引损坏）
    if echo "$STORE_STATUS_OUTPUT" | grep -q "ENOENT"; then
        echo "   ⚠️  Store 索引文件损坏或不完整"
        echo "   💡 建议执行以下命令修复："
        echo "      pnpm store prune"
    else
        echo "   ⚠️  无法获取 store 状态"
        echo "   错误信息: $(echo "$STORE_STATUS_OUTPUT" | head -n 1)"
    fi
fi
echo ""

# 获取项目目录
# 优先级: 1. 命令行参数 2. 环境变量 3. 从配置文件读取 4. 提示用户
PROJECT_DIR=""
AUTO_DETECTED_DIR=""
SOURCE_INFO=""

# 1. 检查命令行参数
if [ -n "$1" ]; then
    AUTO_DETECTED_DIR="$1"
    SOURCE_INFO="命令行参数"
# 2. 检查环境变量
elif [ -n "$PROJECT_SOURCE_DIR" ]; then
    AUTO_DETECTED_DIR="$PROJECT_SOURCE_DIR"
    SOURCE_INFO="环境变量 PROJECT_SOURCE_DIR"
# 3. 从配置文件读取
else
    # 尝试按优先级读取环境配置
    ENV_NAME="${NODE_ENV:-development}"
    AUTO_DETECTED_DIR=$(get_project_dir_from_env "$ENV_NAME")
    
    if [ -z "$AUTO_DETECTED_DIR" ]; then
        # 尝试其他环境
        for env in development production test; do
            AUTO_DETECTED_DIR=$(get_project_dir_from_env "$env")
            if [ -n "$AUTO_DETECTED_DIR" ]; then
                ENV_NAME="$env"
                break
            fi
        done
    fi
    
    if [ -n "$AUTO_DETECTED_DIR" ]; then
        SOURCE_INFO="配置文件 env.$ENV_NAME"
    fi
fi

# 4. 交互式确认或输入
if [ -n "$AUTO_DETECTED_DIR" ]; then
    echo ""
    echo "📂 检测到项目目录（来源：$SOURCE_INFO）"
    echo "   路径: $AUTO_DETECTED_DIR"
    echo ""
    read -p "👉 按 Enter 确认使用此路径，或输入新路径: " USER_INPUT
    
    if [ -n "$USER_INPUT" ]; then
        PROJECT_DIR="$USER_INPUT"
        echo "📝 使用输入的项目目录: $PROJECT_DIR"
    else
        PROJECT_DIR="$AUTO_DETECTED_DIR"
        echo "✅ 已确认使用检测到的项目目录"
    fi
else
    echo ""
    echo "⚠️  无法自动确定项目目录"
    echo ""
    echo "💡 提示："
    echo "  - 您可以传递目录参数: $0 /path/to/projects"
    echo "  - 或设置环境变量: PROJECT_SOURCE_DIR=/path/to/projects $0"
    echo "  - 或设置 NODE_ENV: NODE_ENV=development $0"
    echo ""
    
    read -p "📝 请输入项目目录路径（按 Enter 跳过项目扫描）: " USER_INPUT
    
    if [ -n "$USER_INPUT" ]; then
        PROJECT_DIR="$USER_INPUT"
        echo "📂 使用输入的项目目录"
    else
        echo ""
        echo "跳过项目扫描..."
    fi
fi

# 5. 验证目录是否存在
if [ -n "$PROJECT_DIR" ] && [ ! -d "$PROJECT_DIR" ]; then
    echo ""
    echo "⚠️  项目目录不存在: $PROJECT_DIR"
    echo ""
    echo "跳过项目扫描..."
    PROJECT_DIR=""
fi

# 6. 开始扫描
if [ -n "$PROJECT_DIR" ]; then
    echo ""
    echo "🔍 扫描项目目录: $PROJECT_DIR"
    echo ""
    
    # 检查项目目录和 store 的文件系统
    if [ -d "$PROJECT_DIR" ]; then
        PROJECT_FILESYSTEM=$(df "$PROJECT_DIR" 2>/dev/null | tail -n 1 | awk '{print $1}')
        if [ -n "$PROJECT_FILESYSTEM" ]; then
            echo "💾 文件系统检查:"
            echo "   项目目录文件系统: $PROJECT_FILESYSTEM"
            if [ -n "$STORE_FILESYSTEM" ]; then
                echo "   Store 文件系统:   $STORE_FILESYSTEM"
                echo ""
                if [ "$PROJECT_FILESYSTEM" = "$STORE_FILESYSTEM" ]; then
                    echo "   ✅ 项目目录和 Store 在同一文件系统"
                    echo "   💡 硬链接可以正常工作，节省磁盘空间"
                else
                    echo "   ⚠️  项目目录和 Store 在不同文件系统"
                    echo "   ❌ 硬链接无法跨文件系统工作，pnpm 将复制文件"
                fi
            else
                echo "   ⚠️  无法获取 Store 文件系统信息"
            fi
            echo ""
        fi
    fi
    
    # 统计 node_modules 占用
    echo "📦 各项目 node_modules 占用（表面大小）:"
    echo "   ⚠️  注意：du 命令会重复计算硬链接，实际占用远小于此"
    TOTAL_SIZE_KB=0
    COUNT=0
    MAX_DISPLAY=5
    
    # 查找所有 node_modules 目录（最大深度为 3 层）
    while IFS= read -r dir; do
        SIZE_HUMAN=$(du -sh "$dir" 2>/dev/null | awk '{print $1}')
        SIZE_KB=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
        PROJECT_NAME=$(echo "$dir" | sed "s|$PROJECT_DIR/||" | sed 's|/node_modules||')
        
        # 只显示前几个
        if [ $COUNT -lt $MAX_DISPLAY ]; then
            echo "   [$PROJECT_NAME] $SIZE_HUMAN (包含硬链接重复计算)"
        fi
        
        # 累加大小
        TOTAL_SIZE_KB=$((TOTAL_SIZE_KB + SIZE_KB))
        ((COUNT++))
    done < <(find "$PROJECT_DIR" -name "node_modules" -type d -maxdepth 3 2>/dev/null)
    
    if [ $COUNT -gt $MAX_DISPLAY ]; then
        echo "   ... 还有 $((COUNT - MAX_DISPLAY)) 个项目未显示"
    fi
    
    # 转换总大小为人类可读格式
    if [ $TOTAL_SIZE_KB -gt 0 ]; then
        if [ $TOTAL_SIZE_KB -gt 1048576 ]; then
            TOTAL_SIZE_HUMAN=$(awk "BEGIN {printf \"%.1fG\", $TOTAL_SIZE_KB/1048576}")
        elif [ $TOTAL_SIZE_KB -gt 1024 ]; then
            TOTAL_SIZE_HUMAN=$(awk "BEGIN {printf \"%.1fM\", $TOTAL_SIZE_KB/1024}")
        else
            TOTAL_SIZE_HUMAN="${TOTAL_SIZE_KB}K"
        fi
        echo "   总表面大小: $TOTAL_SIZE_HUMAN (实际占用远小于此)"
    fi
    echo "   共找到 $COUNT 个 node_modules 目录"
    echo ""
    
    # 统计 .pnpm 文件夹占用
    echo "🗂️  各项目 .pnpm 文件夹占用（表面大小）:"
    echo "   ⚠️  注意：.pnpm 中都是硬链接，实际不占额外空间"
    PNPM_COUNT=0
    PNPM_TOTAL_SIZE_KB=0
    
    while IFS= read -r dir; do
        SIZE_HUMAN=$(du -sh "$dir" 2>/dev/null | awk '{print $1}')
        SIZE_KB=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
        PROJECT_NAME=$(echo "$dir" | sed "s|$PROJECT_DIR/||" | sed 's|/node_modules/.pnpm||')
        
        # 只显示前几个
        if [ $PNPM_COUNT -lt $MAX_DISPLAY ]; then
            echo "   [$PROJECT_NAME] $SIZE_HUMAN (硬链接，实际共享)"
        fi
        
        # 累加大小
        PNPM_TOTAL_SIZE_KB=$((PNPM_TOTAL_SIZE_KB + SIZE_KB))
        ((PNPM_COUNT++))
    done < <(find "$PROJECT_DIR" -type d -path "*/node_modules/.pnpm" -maxdepth 4 2>/dev/null)
    
    if [ $PNPM_COUNT -gt $MAX_DISPLAY ]; then
        echo "   ... 还有 $((PNPM_COUNT - MAX_DISPLAY)) 个项目未显示"
    fi
    
    # 转换总大小为人类可读格式
    if [ $PNPM_TOTAL_SIZE_KB -gt 0 ]; then
        if [ $PNPM_TOTAL_SIZE_KB -gt 1048576 ]; then
            PNPM_TOTAL_SIZE_HUMAN=$(awk "BEGIN {printf \"%.1fG\", $PNPM_TOTAL_SIZE_KB/1048576}")
        elif [ $PNPM_TOTAL_SIZE_KB -gt 1024 ]; then
            PNPM_TOTAL_SIZE_HUMAN=$(awk "BEGIN {printf \"%.1fM\", $PNPM_TOTAL_SIZE_KB/1024}")
        else
            PNPM_TOTAL_SIZE_HUMAN="${PNPM_TOTAL_SIZE_KB}K"
        fi
        echo "   总表面大小: $PNPM_TOTAL_SIZE_HUMAN (全部是硬链接，实际共享)"
    fi
    echo "   共找到 $PNPM_COUNT 个 .pnpm 目录"
    echo ""
    
    # 查看实际磁盘占用
    echo "💾 实际磁盘占用情况:"
    echo "   使用 df 命令查看整个文件系统（更准确）:"
    df -h "$PROJECT_DIR" | tail -n 1 | awk '{print "   文件系统: "$1, "| 已用: "$3, "| 可用: "$4, "| 使用率: "$5}'
    echo ""
fi

# 提供优化建议
echo "======================================"
echo "💡 重要说明:"
echo "======================================"
echo ""
echo "⚠️  du 命令显示的大小会重复计算硬链接！"
echo "   多个项目的 .pnpm 文件夹中的文件都是硬链接"
echo "   实际磁盘占用 = pnpm store 大小 + 一些软链接开销"
echo "   通常只占 du 显示大小的 30-50%"
echo ""
echo "✅ 查看真实占用的方法："
echo "   1. 查看 pnpm store 大小（上面已显示）"
echo "   2. 使用 df -h 查看整个文件系统占用"
echo "   3. 对比安装前后的 df 差异"
echo ""
echo "======================================"
echo "💡 优化建议:"
echo "======================================"
echo ""
echo "1. 清理未使用的包:"
echo "   pnpm store prune"
echo ""
echo "2. 检查是否所有项目使用同一个 store:"
echo "   确保所有项目在同一文件系统上"
echo ""
echo "3. 为项目添加 .npmrc 配置文件以优化 pnpm 行为"
echo ""

# 交互式验证硬链接
if [ -n "$PROJECT_DIR" ] && [ -d "$PROJECT_DIR" ]; then
    echo ""
    read -p "🔍 是否验证硬链接是否生效？(输入 y 开始验证，按 Enter 跳过): " VERIFY_HARDLINK
    
    if [[ "$VERIFY_HARDLINK" =~ ^[Yy]$ ]]; then
        echo ""
        echo "======================================"
        echo "🔗 验证硬链接状态"
        echo "======================================"
        echo ""
        echo "💡 项目路径格式: $PROJECT_DIR/{项目ID}"
        echo ""
        
        # 自动列举现有的项目ID（最多5个）
        echo "📋 当前项目目录下的项目ID（最多5个）："
        PROJECT_IDS=$(find "$PROJECT_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null | head -5)
        if [ -n "$PROJECT_IDS" ]; then
            echo "$PROJECT_IDS" | while read -r pid; do
                echo "   - $pid"
            done
        else
            echo "   （暂无项目）"
        fi
        echo ""
        
        # 输入第一个项目ID
        read -p "👉 请输入第一个项目ID: " PROJECT_1_ID
        
        if [ -z "$PROJECT_1_ID" ]; then
            echo "❌ 项目ID不能为空"
        else
            # 输入第二个项目ID
            read -p "👉 请输入第二个项目ID: " PROJECT_2_ID
            
            if [ -z "$PROJECT_2_ID" ]; then
                echo "❌ 项目ID不能为空"
            elif [ "$PROJECT_1_ID" = "$PROJECT_2_ID" ]; then
                echo "❌ 请输入两个不同的项目ID"
            else
                echo ""
                
                PROJECT_1="$PROJECT_DIR/$PROJECT_1_ID"
                PROJECT_2="$PROJECT_DIR/$PROJECT_2_ID"
                PROJECT_1_NAME="$PROJECT_1_ID"
                PROJECT_2_NAME="$PROJECT_2_ID"
                
                # 检查项目目录是否存在
                if [ ! -d "$PROJECT_1" ]; then
                    echo "❌ 项目目录不存在: $PROJECT_1"
                elif [ ! -d "$PROJECT_2" ]; then
                    echo "❌ 项目目录不存在: $PROJECT_2"
                else
                    
                    echo "🔍 正在对比项目:"
                    echo "   • $PROJECT_1_NAME"
                    echo "   • $PROJECT_2_NAME"
                    echo ""
                    
                    # 检查两个项目的 .pnpm 目录
                    PNPM_DIR_1="$PROJECT_1/node_modules/.pnpm"
                    PNPM_DIR_2="$PROJECT_2/node_modules/.pnpm"
                    
                    if [ ! -d "$PNPM_DIR_1" ]; then
                        echo "⚠️  项目 $PROJECT_1_NAME 未找到 node_modules/.pnpm 目录"
                        echo "   路径: $PNPM_DIR_1"
                    elif [ ! -d "$PNPM_DIR_2" ]; then
                        echo "⚠️  项目 $PROJECT_2_NAME 未找到 node_modules/.pnpm 目录"
                        echo "   路径: $PNPM_DIR_2"
                    else
                        # 查找两个项目的公共包
                        echo "🔎 正在查找公共依赖包..."
                        
                        # 获取两个项目的包列表
                        PACKAGES_1=($(find "$PNPM_DIR_1" -maxdepth 1 -type d -name "*@*" 2>/dev/null | xargs -I {} basename {}))
                        PACKAGES_2=($(find "$PNPM_DIR_2" -maxdepth 1 -type d -name "*@*" 2>/dev/null | xargs -I {} basename {}))
                        
                        # 找公共包
                        COMMON_PACKAGES=()
                        for pkg1 in "${PACKAGES_1[@]}"; do
                            for pkg2 in "${PACKAGES_2[@]}"; do
                                if [ "$pkg1" = "$pkg2" ]; then
                                    COMMON_PACKAGES+=("$pkg1")
                                    break
                                fi
                            done
                        done
                        
                        if [ ${#COMMON_PACKAGES[@]} -eq 0 ]; then
                            echo "⚠️  两个项目没有公共依赖包"
                        else
                            echo "📦 找到 ${#COMMON_PACKAGES[@]} 个公共包，正在验证..."
                            echo ""
                            
                            # 验证前 5 个公共包
                            VERIFIED_COUNT=0
                            SAME_INODE_COUNT=0
                            
                            for pkg in "${COMMON_PACKAGES[@]:0:5}"; do
                                # 查找包的 package.json
                                PKG_FILE_1=$(find "$PNPM_DIR_1/$pkg" -name "package.json" -path "*/node_modules/*/package.json" 2>/dev/null | head -n 1)
                                PKG_FILE_2=$(find "$PNPM_DIR_2/$pkg" -name "package.json" -path "*/node_modules/*/package.json" 2>/dev/null | head -n 1)
                                
                                if [ -n "$PKG_FILE_1" ] && [ -f "$PKG_FILE_1" ] && [ -n "$PKG_FILE_2" ] && [ -f "$PKG_FILE_2" ]; then
                                    INODE_1=$(ls -i "$PKG_FILE_1" | awk '{print $1}')
                                    INODE_2=$(ls -i "$PKG_FILE_2" | awk '{print $1}')
                                    
                                    # 提取包名（去掉版本号）
                                    PKG_DISPLAY=$(echo "$pkg" | sed 's/@[^@]*$//')
                                    
                                    if [ "$INODE_1" = "$INODE_2" ]; then
                                        echo "   ✅ $PKG_DISPLAY: inode=$INODE_1 (相同)"
                                        ((SAME_INODE_COUNT++))
                                    else
                                        echo "   ❌ $PKG_DISPLAY: $INODE_1 vs $INODE_2 (不同)"
                                    fi
                                    
                                    ((VERIFIED_COUNT++))
                                fi
                            done
                            
                            echo ""
                            echo "======================================"
                            
                            if [ $VERIFIED_COUNT -eq 0 ]; then
                                echo "⚠️  无法验证包文件"
                            elif [ $SAME_INODE_COUNT -eq $VERIFIED_COUNT ]; then
                                echo "✅ 硬链接生效！"
                                echo "   验证了 $VERIFIED_COUNT 个包，所有 inode 都相同"
                                echo "   这意味着文件指向同一个物理位置，节省了磁盘空间"
                            elif [ $SAME_INODE_COUNT -eq 0 ]; then
                                echo "❌ 硬链接未生效"
                                echo "   验证了 $VERIFIED_COUNT 个包，所有 inode 都不同"
                                echo ""
                                echo "   可能原因："
                                echo "   - 项目不在同一文件系统上"
                                echo "   - 使用了不支持硬链接的文件系统（如跨网络存储）"
                                echo "   - pnpm 配置问题"
                            else
                                echo "⚠️  部分硬链接生效"
                                echo "   验证了 $VERIFIED_COUNT 个包，其中 $SAME_INODE_COUNT 个 inode 相同"
                                echo "   这可能表示配置不一致或部分包被重新安装"
                            fi
                        fi
                    fi
                fi
            fi
        fi
        echo ""
    fi
fi

echo "✅ 分析完成"


