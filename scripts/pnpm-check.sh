#!/bin/bash
# pnpm disk usage inspection script

echo "======================================"
echo "pnpm disk usage analyzer"
echo "======================================"
echo ""

# Ensure pnpm is installed
if ! command -v pnpm &> /dev/null; then
    echo "❌ pnpm not found; install it first"
    echo "   npm install -g pnpm"
    exit 1
fi

echo "✅ pnpm version: $(pnpm --version)"
echo ""

# Read PROJECT_SOURCE_DIR from env file
get_project_dir_from_env() {
    local env_name=${1:-"development"}
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local project_root="$(dirname "$script_dir")"
    local env_file="$project_root/env.$env_name"
    
    if [ -f "$env_file" ]; then
        local project_dir=$(grep "^PROJECT_SOURCE_DIR=" "$env_file" | cut -d'=' -f2)
        if [ -n "$project_dir" ]; then
            echo "$project_dir"
            return 0
        fi
    fi
    
    return 1
}

# Store path
echo "📁 pnpm store path:"
STORE_PATH=$(pnpm store path 2>/dev/null)
STORE_FILESYSTEM=""
if [ -n "$STORE_PATH" ]; then
    echo "   $STORE_PATH"
    
    if [ -d "$STORE_PATH" ]; then
        STORE_SIZE=$(du -sh "$STORE_PATH" 2>/dev/null | awk '{print $1}')
        echo "   Store size: $STORE_SIZE"
        
        STORE_FILESYSTEM=$(df "$STORE_PATH" 2>/dev/null | tail -n 1 | awk '{print $1}')
        if [ -n "$STORE_FILESYSTEM" ]; then
            echo "   Filesystem: $STORE_FILESYSTEM"
        fi
    fi
else
    echo "   ⚠️  Could not resolve store path"
fi
echo ""

# Store status
echo "📊 pnpm store status:"
STORE_STATUS_OUTPUT=$(pnpm store status 2>&1)
STORE_STATUS_EXIT_CODE=$?

if [ $STORE_STATUS_EXIT_CODE -eq 0 ]; then
    echo "$STORE_STATUS_OUTPUT"
else
    if echo "$STORE_STATUS_OUTPUT" | grep -q "ENOENT"; then
        echo "   ⚠️  Store index missing or corrupted"
        echo "   💡 Try:"
        echo "      pnpm store prune"
    else
        echo "   ⚠️  Could not read store status"
        echo "   Error: $(echo "$STORE_STATUS_OUTPUT" | head -n 1)"
    fi
fi
echo ""

# Project directory resolution
# Priority: 1) CLI arg 2) PROJECT_SOURCE_DIR 3) env file 4) prompt
PROJECT_DIR=""
AUTO_DETECTED_DIR=""
SOURCE_INFO=""

if [ -n "$1" ]; then
    AUTO_DETECTED_DIR="$1"
    SOURCE_INFO="command-line argument"
elif [ -n "$PROJECT_SOURCE_DIR" ]; then
    AUTO_DETECTED_DIR="$PROJECT_SOURCE_DIR"
    SOURCE_INFO="env PROJECT_SOURCE_DIR"
else
    ENV_NAME="${NODE_ENV:-development}"
    AUTO_DETECTED_DIR=$(get_project_dir_from_env "$ENV_NAME")
    
    if [ -z "$AUTO_DETECTED_DIR" ]; then
        for env in development production test; do
            AUTO_DETECTED_DIR=$(get_project_dir_from_env "$env")
            if [ -n "$AUTO_DETECTED_DIR" ]; then
                ENV_NAME="$env"
                break
            fi
        done
    fi
    
    if [ -n "$AUTO_DETECTED_DIR" ]; then
        SOURCE_INFO="config file env.$ENV_NAME"
    fi
fi

if [ -n "$AUTO_DETECTED_DIR" ]; then
    echo ""
    echo "📂 Detected project directory (source: $SOURCE_INFO)"
    echo "   Path: $AUTO_DETECTED_DIR"
    echo ""
    read -p "👉 Press Enter to use this path, or type a different path: " USER_INPUT
    
    if [ -n "$USER_INPUT" ]; then
        PROJECT_DIR="$USER_INPUT"
        echo "📝 Using entered project directory: $PROJECT_DIR"
    else
        PROJECT_DIR="$AUTO_DETECTED_DIR"
        echo "✅ Using detected project directory"
    fi
else
    echo ""
    echo "⚠️  Could not auto-detect project directory"
    echo ""
    echo "💡 You can:"
    echo "  - Pass a path: $0 /path/to/projects"
    echo "  - Set env: PROJECT_SOURCE_DIR=/path/to/projects $0"
    echo "  - Set NODE_ENV: NODE_ENV=development $0"
    echo ""
    
    read -p "📝 Project directory path (Enter to skip project scan): " USER_INPUT
    
    if [ -n "$USER_INPUT" ]; then
        PROJECT_DIR="$USER_INPUT"
        echo "📂 Using entered project directory"
    else
        echo ""
        echo "Skipping project scan..."
    fi
fi

if [ -n "$PROJECT_DIR" ] && [ ! -d "$PROJECT_DIR" ]; then
    echo ""
    echo "⚠️  Project directory does not exist: $PROJECT_DIR"
    echo ""
    echo "Skipping project scan..."
    PROJECT_DIR=""
fi

if [ -n "$PROJECT_DIR" ]; then
    echo ""
    echo "🔍 Scanning project directory: $PROJECT_DIR"
    echo ""
    
    if [ -d "$PROJECT_DIR" ]; then
        PROJECT_FILESYSTEM=$(df "$PROJECT_DIR" 2>/dev/null | tail -n 1 | awk '{print $1}')
        if [ -n "$PROJECT_FILESYSTEM" ]; then
            echo "💾 Filesystem check:"
            echo "   Project filesystem: $PROJECT_FILESYSTEM"
            if [ -n "$STORE_FILESYSTEM" ]; then
                echo "   Store filesystem:   $STORE_FILESYSTEM"
                echo ""
                if [ "$PROJECT_FILESYSTEM" = "$STORE_FILESYSTEM" ]; then
                    echo "   ✅ Project and store are on the same filesystem"
                    echo "   💡 Hard links work; disk savings apply"
                else
                    echo "   ⚠️  Project and store are on different filesystems"
                    echo "   ❌ Hard links cannot cross filesystems; pnpm will copy files"
                fi
            else
                echo "   ⚠️  Could not determine store filesystem"
            fi
            echo ""
        fi
    fi
    
    echo "📦 Per-project node_modules (apparent size):"
    echo "   ⚠️  Note: du double-counts hard links; real usage is lower"
    TOTAL_SIZE_KB=0
    COUNT=0
    MAX_DISPLAY=5
    
    while IFS= read -r dir; do
        SIZE_HUMAN=$(du -sh "$dir" 2>/dev/null | awk '{print $1}')
        SIZE_KB=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
        PROJECT_NAME=$(echo "$dir" | sed "s|$PROJECT_DIR/||" | sed 's|/node_modules||')
        
        if [ $COUNT -lt $MAX_DISPLAY ]; then
            echo "   [$PROJECT_NAME] $SIZE_HUMAN (includes hard-link double counting)"
        fi
        
        TOTAL_SIZE_KB=$((TOTAL_SIZE_KB + SIZE_KB))
        ((COUNT++))
    done < <(find "$PROJECT_DIR" -name "node_modules" -type d -maxdepth 3 2>/dev/null)
    
    if [ $COUNT -gt $MAX_DISPLAY ]; then
        echo "   ... $((COUNT - MAX_DISPLAY)) more not shown"
    fi
    
    if [ $TOTAL_SIZE_KB -gt 0 ]; then
        if [ $TOTAL_SIZE_KB -gt 1048576 ]; then
            TOTAL_SIZE_HUMAN=$(awk "BEGIN {printf \"%.1fG\", $TOTAL_SIZE_KB/1048576}")
        elif [ $TOTAL_SIZE_KB -gt 1024 ]; then
            TOTAL_SIZE_HUMAN=$(awk "BEGIN {printf \"%.1fM\", $TOTAL_SIZE_KB/1024}")
        else
            TOTAL_SIZE_HUMAN="${TOTAL_SIZE_KB}K"
        fi
        echo "   Total apparent size: $TOTAL_SIZE_HUMAN (real usage is lower)"
    fi
    echo "   Found $COUNT node_modules directories"
    echo ""
    
    echo "🗂️  Per-project .pnpm folders (apparent size):"
    echo "   ⚠️  Note: entries under .pnpm are hard links; little extra space per copy"
    PNPM_COUNT=0
    PNPM_TOTAL_SIZE_KB=0
    
    while IFS= read -r dir; do
        SIZE_HUMAN=$(du -sh "$dir" 2>/dev/null | awk '{print $1}')
        SIZE_KB=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
        PROJECT_NAME=$(echo "$dir" | sed "s|$PROJECT_DIR/||" | sed 's|/node_modules/.pnpm||')
        
        if [ $PNPM_COUNT -lt $MAX_DISPLAY ]; then
            echo "   [$PROJECT_NAME] $SIZE_HUMAN (hard links, shared in store)"
        fi
        
        PNPM_TOTAL_SIZE_KB=$((PNPM_TOTAL_SIZE_KB + SIZE_KB))
        ((PNPM_COUNT++))
    done < <(find "$PROJECT_DIR" -type d -path "*/node_modules/.pnpm" -maxdepth 4 2>/dev/null)
    
    if [ $PNPM_COUNT -gt $MAX_DISPLAY ]; then
        echo "   ... $((PNPM_COUNT - MAX_DISPLAY)) more not shown"
    fi
    
    if [ $PNPM_TOTAL_SIZE_KB -gt 0 ]; then
        if [ $PNPM_TOTAL_SIZE_KB -gt 1048576 ]; then
            PNPM_TOTAL_SIZE_HUMAN=$(awk "BEGIN {printf \"%.1fG\", $PNPM_TOTAL_SIZE_KB/1048576}")
        elif [ $PNPM_TOTAL_SIZE_KB -gt 1024 ]; then
            PNPM_TOTAL_SIZE_HUMAN=$(awk "BEGIN {printf \"%.1fM\", $PNPM_TOTAL_SIZE_KB/1024}")
        else
            PNPM_TOTAL_SIZE_HUMAN="${PNPM_TOTAL_SIZE_KB}K"
        fi
        echo "   Total apparent size: $PNPM_TOTAL_SIZE_HUMAN (all hard-linked to store)"
    fi
    echo "   Found $PNPM_COUNT .pnpm directories"
    echo ""
    
    echo "💾 Filesystem usage (df):"
    echo "   Whole filesystem is more accurate than summing du:"
    df -h "$PROJECT_DIR" | tail -n 1 | awk '{print "   Filesystem: "$1, "| Used: "$3, "| Avail: "$4, "| Use: "$5}'
    echo ""
fi

echo "======================================"
echo "💡 Important:"
echo "======================================"
echo ""
echo "⚠️  du counts hard-linked files multiple times!"
echo "   Files under each project’s .pnpm are hard links into the store."
echo "   Real disk use ≈ store size + small symlink/metadata overhead."
echo "   Often ~30–50% of what naive du sums suggest."
echo ""
echo "✅ Ways to see real usage:"
echo "   1. pnpm store size (shown above)"
echo "   2. df -h for the whole filesystem"
echo "   3. Compare df before and after installs"
echo ""
echo "======================================"
echo "💡 Recommendations:"
echo "======================================"
echo ""
echo "1. Prune unused packages from the store:"
echo "   pnpm store prune"
echo ""
echo "2. Prefer one store and projects on the same filesystem:"
echo "   Keep projects and the store on the same volume when possible"
echo ""
echo "3. Tune per-project .npmrc for your registry and link strategy"
echo ""

if [ -n "$PROJECT_DIR" ] && [ -d "$PROJECT_DIR" ]; then
    echo ""
    read -p "🔍 Verify hard links between two projects? (y to start, Enter to skip): " VERIFY_HARDLINK
    
    if [[ "$VERIFY_HARDLINK" =~ ^[Yy]$ ]]; then
        echo ""
        echo "======================================"
        echo "🔗 Hard link verification"
        echo "======================================"
        echo ""
        echo "💡 Project layout: $PROJECT_DIR/{projectId}"
        echo ""
        
        echo "📋 Project IDs under this directory (up to 5):"
        PROJECT_IDS=$(find "$PROJECT_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null | head -5)
        if [ -n "$PROJECT_IDS" ]; then
            echo "$PROJECT_IDS" | while read -r pid; do
                echo "   - $pid"
            done
        else
            echo "   (none)"
        fi
        echo ""
        
        read -p "👉 First project ID: " PROJECT_1_ID
        
        if [ -z "$PROJECT_1_ID" ]; then
            echo "❌ Project ID cannot be empty"
        else
            read -p "👉 Second project ID: " PROJECT_2_ID
            
            if [ -z "$PROJECT_2_ID" ]; then
                echo "❌ Project ID cannot be empty"
            elif [ "$PROJECT_1_ID" = "$PROJECT_2_ID" ]; then
                echo "❌ Enter two different project IDs"
            else
                echo ""
                
                PROJECT_1="$PROJECT_DIR/$PROJECT_1_ID"
                PROJECT_2="$PROJECT_DIR/$PROJECT_2_ID"
                PROJECT_1_NAME="$PROJECT_1_ID"
                PROJECT_2_NAME="$PROJECT_2_ID"
                
                if [ ! -d "$PROJECT_1" ]; then
                    echo "❌ Project directory not found: $PROJECT_1"
                elif [ ! -d "$PROJECT_2" ]; then
                    echo "❌ Project directory not found: $PROJECT_2"
                else
                    
                    echo "🔍 Comparing projects:"
                    echo "   • $PROJECT_1_NAME"
                    echo "   • $PROJECT_2_NAME"
                    echo ""
                    
                    PNPM_DIR_1="$PROJECT_1/node_modules/.pnpm"
                    PNPM_DIR_2="$PROJECT_2/node_modules/.pnpm"
                    
                    if [ ! -d "$PNPM_DIR_1" ]; then
                        echo "⚠️  $PROJECT_1_NAME: no node_modules/.pnpm"
                        echo "   Path: $PNPM_DIR_1"
                    elif [ ! -d "$PNPM_DIR_2" ]; then
                        echo "⚠️  $PROJECT_2_NAME: no node_modules/.pnpm"
                        echo "   Path: $PNPM_DIR_2"
                    else
                        echo "🔎 Looking for overlapping dependencies..."
                        
                        PACKAGES_1=($(find "$PNPM_DIR_1" -maxdepth 1 -type d -name "*@*" 2>/dev/null | xargs -I {} basename {}))
                        PACKAGES_2=($(find "$PNPM_DIR_2" -maxdepth 1 -type d -name "*@*" 2>/dev/null | xargs -I {} basename {}))
                        
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
                            echo "⚠️  No shared packages between the two projects"
                        else
                            echo "📦 Found ${#COMMON_PACKAGES[@]} shared package(s); verifying..."
                            echo ""
                            
                            VERIFIED_COUNT=0
                            SAME_INODE_COUNT=0
                            
                            for pkg in "${COMMON_PACKAGES[@]:0:5}"; do
                                PKG_FILE_1=$(find "$PNPM_DIR_1/$pkg" -name "package.json" -path "*/node_modules/*/package.json" 2>/dev/null | head -n 1)
                                PKG_FILE_2=$(find "$PNPM_DIR_2/$pkg" -name "package.json" -path "*/node_modules/*/package.json" 2>/dev/null | head -n 1)
                                
                                if [ -n "$PKG_FILE_1" ] && [ -f "$PKG_FILE_1" ] && [ -n "$PKG_FILE_2" ] && [ -f "$PKG_FILE_2" ]; then
                                    INODE_1=$(ls -i "$PKG_FILE_1" | awk '{print $1}')
                                    INODE_2=$(ls -i "$PKG_FILE_2" | awk '{print $1}')
                                    
                                    PKG_DISPLAY=$(echo "$pkg" | sed 's/@[^@]*$//')
                                    
                                    if [ "$INODE_1" = "$INODE_2" ]; then
                                        echo "   ✅ $PKG_DISPLAY: inode=$INODE_1 (same)"
                                        ((SAME_INODE_COUNT++))
                                    else
                                        echo "   ❌ $PKG_DISPLAY: $INODE_1 vs $INODE_2 (different)"
                                    fi
                                    
                                    ((VERIFIED_COUNT++))
                                fi
                            done
                            
                            echo ""
                            echo "======================================"
                            
                            if [ $VERIFIED_COUNT -eq 0 ]; then
                                echo "⚠️  Could not verify package files"
                            elif [ $SAME_INODE_COUNT -eq $VERIFIED_COUNT ]; then
                                echo "✅ Hard links look good"
                                echo "   Checked $VERIFIED_COUNT package(s); all inodes match"
                                echo "   Same physical files → disk savings from deduplication"
                            elif [ $SAME_INODE_COUNT -eq 0 ]; then
                                echo "❌ Hard links not shared"
                                echo "   Checked $VERIFIED_COUNT package(s); inodes all differ"
                                echo ""
                                echo "   Possible causes:"
                                echo "   - Projects on different filesystems"
                                echo "   - Filesystem without working hard links (e.g. some network mounts)"
                                echo "   - pnpm / store configuration"
                            else
                                echo "⚠️  Mixed results"
                                echo "   Checked $VERIFIED_COUNT package(s); $SAME_INODE_COUNT inode match(es)"
                                echo "   May indicate inconsistent config or partial reinstalls"
                            fi
                        fi
                    fi
                fi
            fi
        fi
        echo ""
    fi
fi

echo "✅ Done"

