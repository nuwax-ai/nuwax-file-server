#!/bin/bash

#===============================================================================
# nuwax-file-server CLI 自动化测试脚本
#
# 功能: 自动化测试 nuwax-file-server CLI 的启动、状态查询、健康检查、重启、停止等功能
#
# 使用方法:
#   chmod +x test-cli.sh
#   ./test-cli.sh                    # 模式一: pnpm link 全局命令
#   ./test-cli.sh --direct          # 模式二: 直接用 node 运行 dist 目录
#   ./test-cli.sh --installed      # 模式三: 已全局安装，跳过所有安装步骤
#
# 环境要求:
#   - bash shell
#   - curl
#   - jq (用于格式化 JSON 输出)
#   - pnpm
#   - node (v22+)
#
# 脚本行为:
#   模式一 (默认): pnpm install + pnpm link 后测试
#   模式二 (--direct): 直接用 node 运行 dist/，无需全局链接
#   模式三 (--installed): 已全局安装，直接测试，跳过所有安装步骤
#===============================================================================

set -e

# 项目根目录（脚本位于 scripts/ 下，根目录为上级目录）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${PROJECT_ROOT}/dist"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 测试模式: "link", "direct" 或 "installed"
TEST_MODE="link"

# 日志函数
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_section() {
    echo ""
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN}  $1${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""
}

#-------------------------------------------------------------------------------
# 模式一: 本地安装 - 安装依赖并全局链接，使 nuwax-file-server 命令可用
#-------------------------------------------------------------------------------
do_local_install() {
    log_info "模式一: 本地安装模式"
    log_info "进入项目根目录 ${PROJECT_ROOT}"
    cd "${PROJECT_ROOT}"

    log_info "执行 pnpm install..."
    pnpm install

    log_info "执行 pnpm run build（编译 CLI 到 dist/）..."
    pnpm run build

    log_info "执行 pnpm link --global（全局链接）..."
    pnpm link --global

    log_success "本地安装完成，nuwax-file-server 命令已可用"
}

#-------------------------------------------------------------------------------
# 模式二: 直接运行 - 检查 dist 目录是否存在，直接用 node 运行
#-------------------------------------------------------------------------------
check_direct_mode() {
    if [ ! -d "${DIST_DIR}" ]; then
        log_error "dist 目录不存在，请先运行: npm run build"
        log_info "或者使用默认模式: ./test-cli.sh"
        exit 1
    fi

    if [ ! -f "${DIST_DIR}/cli.js" ]; then
        log_error "dist/cli.js 不存在，请先运行: npm run build"
        exit 1
    fi

    log_success "模式二: 直接运行模式"
    log_info "将使用 'node ${DIST_DIR}/cli.js' 执行测试"
}

#-------------------------------------------------------------------------------
# 模式三: 已安装 - 跳过所有安装步骤，直接使用全局命令测试
#-------------------------------------------------------------------------------
check_installed_mode() {
    if ! command -v nuwax-file-server &> /dev/null; then
        log_error "未找到 nuwax-file-server 命令，请先全局安装:"
        log_info "  npm install -g nuwax-file-server"
        log_info "或者使用其他模式:"
        log_info "  ./test-cli.sh              # 模式一: pnpm link"
        log_info "  ./test-cli.sh --direct     # 模式二: node 直接运行"
        exit 1
    fi

    log_success "模式三: 已安装模式"
    log_info "检测到 nuwax-file-server 全局命令"
    log_info "将直接使用 'nuwax-file-server' 执行测试"
}

# 测试函数
test_command() {
    local cmd=$1
    local description=$2
    log_info "测试: ${description}"
    log_info "命令: ${cmd}"
    eval "${cmd}"
    local exit_code=$?
    if [ $exit_code -eq 0 ]; then
        log_success "✓ 完成: ${description}"
        return 0
    else
        log_error "✗ 失败: ${description} (退出码: ${exit_code})"
        return 1
    fi
}

# 默认配置
PORT=${PORT:-60000}
HEALTH_URL="http://localhost:${PORT}/health"
PROJECT_DIR=${PROJECT_DIR:-./test-projects}
NGINX_DIR=${NGINX_DIR:-./test-nginx}
UPLOAD_DIR=${UPLOAD_DIR:-./test-uploads}

# 显示配置
show_config() {
    log_section "测试配置"
    echo "  测试模式:    ${TEST_MODE_LABEL}"
    echo "  端口:        ${PORT}"
    echo "  健康检查:    ${HEALTH_URL}"
    echo "  项目目录:    ${PROJECT_DIR}"
    echo "  Nginx目录:   ${NGINX_DIR}"
    echo "  上传目录:     ${UPLOAD_DIR}"
    echo ""
}

# 获取模式标签
get_mode_label() {
    case "${TEST_MODE}" in
        link)
            TEST_MODE_LABEL="pnpm link 全局命令"
            ;;
        direct)
            TEST_MODE_LABEL="node 直接运行"
            ;;
        installed)
            TEST_MODE_LABEL="已全局安装"
            ;;
    esac
}

# 检查依赖
check_dependencies() {
    log_info "检查依赖..."

    local missing_deps=()

    if ! command -v curl &> /dev/null; then
        missing_deps+=("curl")
    fi

    if ! command -v jq &> /dev/null; then
        missing_deps+=("jq")
    fi

    # 模式一和模式二需要 pnpm
    if [ "${TEST_MODE}" != "installed" ]; then
        if ! command -v pnpm &> /dev/null; then
            missing_deps+=("pnpm")
        fi
    fi

    if ! command -v node &> /dev/null; then
        missing_deps+=("node")
    fi

    if [ ${#missing_deps[@]} -gt 0 ]; then
        log_error "缺少依赖: ${missing_deps[*]}"
        log_info "请安装后再运行，例如: brew install ${missing_deps[*]}"
        exit 1
    fi

    log_success "依赖已满足"
}

# 获取当前模式下的命令前缀
get_cmd_prefix() {
    case "${TEST_MODE}" in
        link)
            echo "nuwax-file-server"
            ;;
        direct)
            echo "node ${DIST_DIR}/cli.js"
            ;;
        installed)
            echo "nuwax-file-server"
            ;;
    esac
}

# 清理函数：停止服务
cleanup() {
    log_info "清理环境（停止服务）..."
    local cmd_prefix=$(get_cmd_prefix)
    ${cmd_prefix} stop 2>/dev/null || true
    sleep 1
}

# 退出时清理
cleanup_exit() {
    local exit_code=$?

    # 只在模式一下取消全局链接
    if [ "${TEST_MODE}" = "link" ]; then
        log_info "取消全局链接: pnpm unlink --global"
        (cd "${PROJECT_ROOT}" && pnpm unlink --global) 2>/dev/null || true
    fi

    if [ $exit_code -ne 0 ]; then
        exit $exit_code
    fi
}

# 测试健康检查端点
test_health_endpoint() {
    log_info "测试健康检查端点..."

    local response=$(curl -s "${HEALTH_URL}")
    local status=$(echo "${response}" | jq -r '.status' 2>/dev/null || echo "error")

    if [ "${status}" = "ok" ]; then
        log_success "健康检查通过"
        log_info "响应: ${response}"
        return 0
    else
        log_error "健康检查失败，状态: ${status}"
        log_info "响应: ${response}"
        return 1
    fi
}

# 测试服务状态查询
test_status_command() {
    log_info "测试服务状态查询..."
    local cmd_prefix=$(get_cmd_prefix)
    ${cmd_prefix} status
    log_success "状态查询完成"
}

# 主测试流程
run_tests() {
    get_mode_label
    show_config
    check_dependencies

    log_section "开始测试"

    # 根据模式执行不同的初始化
    case "${TEST_MODE}" in
        link)
            do_local_install
            ;;
        direct)
            check_direct_mode
            ;;
        installed)
            check_installed_mode
            ;;
    esac

    # 清理环境（停止可能残留的服务）
    cleanup

    # ========== 测试 1: 启动服务 ==========
    log_section "测试 1: 启动服务"
    local cmd_prefix=$(get_cmd_prefix)
    test_command "${cmd_prefix} start --env production --port ${PORT}" "启动服务"
    sleep 3

    # ========== 测试 2: 健康检查 ==========
    log_section "测试 2: 健康检查"
    test_health_endpoint

    # ========== 测试 3: 状态查询 ==========
    log_section "测试 3: 状态查询"
    test_status_command

    # ========== 测试 4: 重启服务 ==========
    log_section "测试 4: 重启服务"
    test_command "${cmd_prefix} restart" "重启服务"
    sleep 3

    # ========== 测试 5: 重启后健康检查 ==========
    log_section "测试 5: 重启后健康检查"
    test_health_endpoint

    # ========== 测试 6: 停止服务 ==========
    log_section "测试 6: 停止服务"
    test_command "${cmd_prefix} stop" "停止服务"

    # ========== 完成 ==========
    log_section "测试完成"
    log_success "所有 CLI 测试通过!"

    # 根据模式显示不同的后续提示
    echo ""
    case "${TEST_MODE}" in
        link)
            echo "已测试全局命令 'nuwax-file-server'"
            ;;
        direct)
            echo "已测试 'node ${DIST_DIR}/cli.js' 直接运行"
            ;;
        installed)
            echo "已测试全局安装版本"
            ;;
    esac
    echo ""
}

# 显示帮助信息
show_help() {
    echo "nuwax-file-server CLI 测试脚本"
    echo ""
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  -p, --port <端口>     指定测试端口 (默认: 60000)"
    echo "  --direct              模式二: 直接用 node 运行 dist/"
    echo "  --installed           模式三: 已全局安装，跳过所有安装步骤"
    echo "  --project-dir <目录>   指定项目目录"
    echo "  --nginx-dir <目录>    指定 Nginx 目录"
    echo "  --upload-dir <目录>    指定上传目录"
    echo "  -h, --help            显示帮助信息"
    echo ""
    echo "三种测试模式:"
    echo "  1. 默认模式 (pnpm link):  ./test-cli.sh"
    echo "     - 执行 pnpm install + pnpm run build + pnpm link"
    echo "     - 使用全局命令 'nuwax-file-server'"
    echo ""
    echo "  2. 直接运行模式:         ./test-cli.sh --direct"
    echo "     - 无需 pnpm link"
    echo "     - 使用 'node dist/cli.js' 运行"
    echo ""
    echo "  3. 已安装模式:           ./test-cli.sh --installed"
    echo "     - 跳过所有安装步骤"
    echo "     - 直接使用已全局安装的命令"
    echo ""
    echo "示例:"
    echo "  $0                       # 模式一: pnpm link 全局命令"
    echo "  $0 --direct              # 模式二: node 直接运行"
    echo "  $0 --installed          # 模式三: 已全局安装"
    echo "  $0 --port 60001        # 指定端口"
    echo "  $0 --installed -p 60001 # 组合使用"
    echo ""
}

# 解析命令行参数
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -p|--port)
                PORT="$2"
                shift 2
                ;;
            --direct)
                TEST_MODE="direct"
                shift
                ;;
            --installed)
                TEST_MODE="installed"
                shift
                ;;
            --project-dir)
                PROJECT_DIR="$2"
                shift 2
                ;;
            --nginx-dir)
                NGINX_DIR="$2"
                shift 2
                ;;
            --upload-dir)
                UPLOAD_DIR="$2"
                shift 2
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                log_error "未知参数: $1"
                show_help
                exit 1
                ;;
        esac
    done
}

# 脚本入口
main() {
    parse_args "$@"

    # 无论正常结束、失败或 Ctrl+C，退出时都执行清理
    trap 'cleanup_exit' EXIT

    run_tests
}

# 执行主函数
main "$@"
