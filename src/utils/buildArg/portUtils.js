import fs from "fs";
import net from "net";
import { execSync } from "child_process";
import { log } from "../log/logUtils.js";

// 从脚本字符串解析端口号（支持 --port/-p 以及内联 PORT=）
function parsePortFromScript(script) {
  if (!script || typeof script !== "string") return undefined;
  let m = script.match(/--port\s+(\d{2,5})/);
  if (m) return Number(m[1]);
  m = script.match(/-p\s+(\d{2,5})/);
  if (m) return Number(m[1]);
  m = script.match(/PORT\s*=\s*(\d{2,5})/);
  if (m) return Number(m[1]);
  return undefined;
}

// 获取可用端口（传入首选端口，不可用则递增寻找）
function getAvailablePort(preferred) {
  return new Promise((resolve) => {
    const start = Number(preferred) || 3000;
    const maxAttempts = 2000; // 端口向上探测范围

    function tryPort(p, attempts) {
      if (attempts > maxAttempts) {
        // 超出探测范围，回退到起始端口返回
        resolve(start);
        return;
      }

      // 先用 lsof 检查是否已被占用（覆盖 IPv4/IPv6 监听差异）
      if (isPortListening(p)) {
        tryPort(p + 1, attempts + 1);
        return;
      }

      const server = net.createServer();
      server.unref();
      let resolved = false;
      server.on("error", () => {
        if (resolved) return;
        resolved = true;
        // 被占用或其他错误，尝试下一个
        tryPort(p + 1, attempts + 1);
      });
      server.listen(p, () => {
        if (resolved) {
          try {
            server.close();
          } catch (_) {}
          return;
        }
        resolved = true;
        const assigned = server.address().port;
        server.close(() => resolve(assigned));
      });
    }

    tryPort(start, 0);
  });
}

// 判断端口是否处于监听状态（优先ss，然后netstat，最后lsof）
function isPortListening(port) {
  // 策略1: 优先使用 ss 命令（Linux，性能最好）
  if (tryIsPortListeningUsingSs(port)) {
    return true;
  }

  // 策略2: 使用 netstat 命令（跨平台，性能较好）
  if (tryIsPortListeningUsingNetstat(port)) {
    return true;
  }
  return false;
  
  // 策略3: 兜底使用 lsof 命令（兼容性最好）
  //return tryIsPortListeningUsingLsof(port);
}

// 使用 ss 命令检查端口是否监听
function tryIsPortListeningUsingSs(port) {
  try {
    // ss -ltn 显示监听的 TCP 端口
    // 输出格式: State Recv-Q Send-Q Local Address:Port Peer Address:Port
    const cmd = `ss -ltn 2>/dev/null | grep ":${Number(port)} "`;
    const buf = execSync(cmd, { 
      stdio: ["ignore", "pipe", "ignore"],
      shell: "/bin/sh",
      timeout: 2000, // 2秒超时
      killSignal: "SIGKILL"
    });
    const out = String(buf || "");
    // 检查是否有 LISTEN 状态的端口
    return out.trim().length > 0 && out.includes("LISTEN");
  } catch (_) {
    return false;
  }
}

// 使用 netstat 命令检查端口是否监听
function tryIsPortListeningUsingNetstat(port) {
  try {
    let cmd;
    
    // 根据操作系统选择不同的 netstat 命令
    if (process.platform === "linux") {
      // Linux: netstat -ltn
      cmd = `netstat -ltn 2>/dev/null | grep ":${Number(port)} "`;
    } else if (process.platform === "darwin") {
      // macOS: netstat -an
      cmd = `netstat -an 2>/dev/null | grep "LISTEN" | grep "\\.${Number(port)} "`;
    } else {
      // 其他系统暂不支持
      return false;
    }

    const buf = execSync(cmd, { 
      stdio: ["ignore", "pipe", "ignore"],
      shell: "/bin/sh",
      timeout: 2000, // 2秒超时
      killSignal: "SIGKILL"
    });
    const out = String(buf || "");
    return out.trim().length > 0;
  } catch (_) {
    return false;
  }
}

// 使用 lsof 命令检查端口是否监听（兜底方案）
function tryIsPortListeningUsingLsof(port) {
  try {
    const cmd = `lsof -Pi :${Number(port)} -sTCP:LISTEN -n`;
    const buf = execSync(cmd, { 
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000, // 2秒超时
      killSignal: "SIGKILL"
    });
    const out = String(buf || "");
    return out.trim().length > 0;
  } catch (_) {
    return false;
  }
}

// 获取进程的所有子进程ID（兼容Linux和macOS）
function getChildPids(pid) {
  try {
    // 方法1: 使用pgrep -P (Linux和macOS都支持)
    try {
      const cmd = `pgrep -P ${pid}`;
      const buf = execSync(cmd, { 
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000, // 2秒超时
        killSignal: "SIGKILL"
      });
      const out = String(buf || "");
      const childPids = out
        .trim()
        .split("\n")
        .filter((p) => p)
        .map((p) => Number(p));
      if (childPids.length > 0) {
        return childPids;
      }
    } catch (e) {
      // pgrep失败，尝试其他方法
    }

    // 方法2: 使用ps命令查找子进程 (兼容性更好)
    try {
      const cmd = `ps -eo pid,ppid | awk '$2==${pid} {print $1}'`;
      const buf = execSync(cmd, { 
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000, // 2秒超时
        killSignal: "SIGKILL"
      });
      const out = String(buf || "");
      const childPids = out
        .trim()
        .split("\n")
        .filter((p) => p)
        .map((p) => Number(p));
      return childPids;
    } catch (e) {
      // ps命令也失败
    }

    // 方法3: Linux特有的/proc文件系统
    if (process.platform === "linux") {
      try {
        const childrenFile = `/proc/${pid}/task/${pid}/children`;
        if (fs.existsSync(childrenFile)) {
          const content = fs.readFileSync(childrenFile, "utf8");
          const childPids = content
            .trim()
            .split(" ")
            .filter((p) => p)
            .map((p) => Number(p));
          return childPids;
        }
      } catch (e) {
        // /proc方法失败
      }
    }

    return [];
  } catch (e) {
    return [];
  }
}

// 通过进程ID查询该进程及其子进程监听的端口，返回端口和对应的进程ID
function getPortsByPid(pid, projectId = "default") {
  try {
    // 首先检查进程是否存在
    const checkCmd = `ps -p ${pid} -o pid=`;
    try {
      execSync(checkCmd, { 
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000, // 2秒超时
        killSignal: "SIGKILL"
      });
    } catch (e) {
      // 进程不存在
      return [];
    }

    // 使用递归查找获取端口映射
    const portPidMap = getPortsRecursively(pid, new Set(), projectId);

    // 返回端口数组（按端口号排序）
    return Array.from(portPidMap.keys()).sort((a, b) => a - b);
  } catch (e) {
    return [];
  }
}

// 递归查找进程及其所有后代进程监听的端口
function getPortsRecursively(pid, visitedPids = new Set(), projectId = "default") {
  const portPidMap = new Map();

  // 避免循环引用
  if (visitedPids.has(pid)) {
    return portPidMap;
  }
  visitedPids.add(pid);

  try {
    // 查询当前进程的端口
    const currentPorts = getPortsBySinglePid(pid, projectId);
    currentPorts.forEach((port) => {
      portPidMap.set(port, pid);
    });

    // 如果当前进程有端口，直接返回（优先返回最近的进程）
    if (currentPorts.length > 0) {
      return portPidMap;
    }

    // 递归查询子进程的端口
    const childPids = getChildPids(pid);
    for (const childPid of childPids) {
      const childPortMap = getPortsRecursively(childPid, visitedPids, projectId);
      childPortMap.forEach((childPid, port) => {
        portPidMap.set(port, childPid);
      });
    }

    return portPidMap;
  } catch (e) {
    return portPidMap;
  }
}

// 通过进程ID查询该进程及其子进程监听的端口，返回端口和进程ID的映射
function getPortsAndPidsByPid(pid, projectId = "default") {
  try {
    log(projectId, "DEBUG", `检查进程是否存在`, { pid });
    
    // 首先检查进程是否存在
    const checkCmd = `ps -p ${pid} -o pid=`;
    try {
      execSync(checkCmd, { 
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000, // 2秒超时
        killSignal: "SIGKILL"
      });
      log(projectId, "DEBUG", `进程存在，开始递归查询端口`, { pid });
    } catch (e) {
      // 进程不存在
      log(projectId, "DEBUG", `进程不存在`, { pid });
      return new Map();
    }

    // 递归查找所有后代进程的端口
    return getPortsRecursively(pid, new Set(), projectId);
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    log(projectId, "ERROR", `getPortsAndPidsByPid异常`, { pid, error: errMsg });
    return new Map();
  }
}

// 查询单个进程的端口（内部函数）
function getPortsBySinglePid(pid, projectId = "default") {
  const startTime = Date.now();
  
  // 策略1: 优先使用 ss 命令（Linux，性能最好）
  const portsFromSs = tryGetPortsUsingSs(pid, projectId);
  if (portsFromSs.length > 0) {
    const duration = Date.now() - startTime;
    log(projectId, "INFO", `使用ss查询到端口`, {
      pid,
      ports: portsFromSs,
      duration: `${duration}ms`,
      method: "ss"
    });
    return portsFromSs;
  }

  // 策略2: 使用 netstat 命令（跨平台，性能较好）
  const portsFromNetstat = tryGetPortsUsingNetstat(pid, projectId);
  if (portsFromNetstat.length > 0) {
    const duration = Date.now() - startTime;
    log(projectId, "INFO", `使用netstat查询到端口`, {
      pid,
      ports: portsFromNetstat,
      duration: `${duration}ms`,
      method: "netstat"
    });
    return portsFromNetstat;
  }
  return [];

  // 策略3: 兜底使用 lsof 命令（兼容性最好,但可能造成进程卡死）
  /* 
  const portsFromLsof = tryGetPortsUsingLsof(pid, projectId);
  const duration = Date.now() - startTime;
  
  if (portsFromLsof.length > 0) {
    log(projectId, "INFO", `使用lsof查询到端口`, {
      pid,
      ports: portsFromLsof,
      duration: `${duration}ms`,
      method: "lsof"
    });
  } else {
    log(projectId, "INFO", `未查询到端口`, {
      pid,
      duration: `${duration}ms`,
      methods: "ss->netstat->lsof"
    });
  }
  
  return portsFromLsof;
  */
}

// 使用 ss 命令获取端口（Linux）
function tryGetPortsUsingSs(pid, projectId = "default") {
  const startTime = Date.now();
  try {
    log(projectId, "DEBUG", `尝试使用ss命令查询端口`, { pid });
    
    // ss -ltnp 显示监听的 TCP 端口及进程信息
    // 输出格式: State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
    const cmd = `ss -ltnp 2>/dev/null | grep "pid=${pid},"`;
    const buf = execSync(cmd, { 
      stdio: ["ignore", "pipe", "ignore"],
      shell: "/bin/sh",
      timeout: 3000, // 3秒超时
      killSignal: "SIGKILL"
    });
    const out = String(buf || "");
    const lines = out.trim().split("\n");

    const ports = [];
    for (const line of lines) {
      if (!line) continue;

      // 解析 Local Address:Port 列，格式如: 0.0.0.0:3000 或 [::]:3000 或 127.0.0.1:3000
      const portMatch = line.match(/(?:0\.0\.0\.0|\[::\]|127\.0\.0\.1|\*):(\d+)/);
      if (portMatch) {
        const port = Number(portMatch[1]);
        if (port && !ports.includes(port)) {
          ports.push(port);
        }
      }
    }

    const duration = Date.now() - startTime;
    log(projectId, "DEBUG", `ss命令执行完成`, { pid, portsCount: ports.length, duration: `${duration}ms` });
    return ports;
  } catch (e) {
    const duration = Date.now() - startTime;
    const errMsg = e && e.message ? e.message : String(e);
    log(projectId, "DEBUG", `ss命令执行失败`, { pid, error: errMsg, duration: `${duration}ms` });
    return [];
  }
}

// 使用 netstat 命令获取端口（跨平台）
function tryGetPortsUsingNetstat(pid, projectId = "default") {
  const startTime = Date.now();
  try {
    let cmd;
    
    // 根据操作系统选择不同的 netstat 命令
    if (process.platform === "linux") {
      log(projectId, "DEBUG", `尝试使用netstat命令查询端口`, { pid });
      // Linux: netstat -ltnp
      cmd = `netstat -ltnp 2>/dev/null | grep "${pid}/"`;
    } else if (process.platform === "darwin") {
      // macOS: netstat 不支持 -p，需要先用 netstat 获取端口，再验证进程
      // 这里直接跳过，让 lsof 处理 macOS 的情况
      log(projectId, "DEBUG", `macOS系统跳过netstat`, { pid });
      return [];
    } else {
      // 其他系统暂不支持
      log(projectId, "DEBUG", `${process.platform}系统不支持netstat`, { pid });
      return [];
    }

    const buf = execSync(cmd, { 
      stdio: ["ignore", "pipe", "ignore"],
      shell: "/bin/sh",
      timeout: 3000, // 3秒超时
      killSignal: "SIGKILL"
    });
    const out = String(buf || "");
    const lines = out.trim().split("\n");

    const ports = [];
    for (const line of lines) {
      if (!line) continue;

      // 解析 Local Address 列，格式如: 0.0.0.0:3000 或 :::3000 或 127.0.0.1:3000
      const portMatch = line.match(/(?:0\.0\.0\.0|:::|\*:|127\.0\.0\.1:)(\d+)/);
      if (portMatch) {
        const port = Number(portMatch[1]);
        if (port && !ports.includes(port)) {
          ports.push(port);
        }
      }
    }

    const duration = Date.now() - startTime;
    log(projectId, "DEBUG", `netstat命令执行完成`, { pid, portsCount: ports.length, duration: `${duration}ms` });
    return ports;
  } catch (e) {
    const duration = Date.now() - startTime;
    const errMsg = e && e.message ? e.message : String(e);
    log(projectId, "DEBUG", `netstat命令执行失败`, { pid, error: errMsg, duration: `${duration}ms` });
    return [];
  }
}

// 使用 lsof 命令获取端口（兜底方案）
function tryGetPortsUsingLsof(pid, projectId = "default") {
  const startTime = Date.now();
  try {
    log(projectId, "DEBUG", `尝试使用lsof命令查询端口`, { pid });
    
    const cmd = `lsof -Pan -p ${pid} -iTCP -sTCP:LISTEN -n`;
    const buf = execSync(cmd, { 
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000, // 3秒超时
      killSignal: "SIGKILL"
    });
    const out = String(buf || "");
    const lines = out.trim().split("\n");

    // 跳过标题行
    if (lines.length <= 1) {
      const duration = Date.now() - startTime;
      log(projectId, "DEBUG", `lsof命令未找到监听端口`, { pid, duration: `${duration}ms` });
      return [];
    }

    const ports = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // 解析lsof输出格式: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
      // NAME列包含端口信息，格式如: *:3000 (LISTEN) 或 localhost:3000 (LISTEN)
      const nameMatch = line.match(
        /(\*|localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)\s*\(LISTEN\)/
      );
      if (nameMatch) {
        const port = Number(nameMatch[2]);
        if (port && !ports.includes(port)) {
          ports.push(port);
        }
      }
    }

    const duration = Date.now() - startTime;
    log(projectId, "DEBUG", `lsof命令执行完成`, { pid, portsCount: ports.length, duration: `${duration}ms` });
    return ports;
  } catch (e) {
    const duration = Date.now() - startTime;
    const errMsg = e && e.message ? e.message : String(e);
    log(projectId, "DEBUG", `lsof命令执行失败`, { pid, error: errMsg, duration: `${duration}ms` });
    return [];
  }
}

// 查询监听特定端口的所有进程ID
function getPidsByPort(port) {
  try {
    const cmd = `lsof -ti:${port}`;
    const buf = execSync(cmd, { 
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000, // 2秒超时
      killSignal: "SIGKILL"
    });
    const out = String(buf || "");
    const pids = out
      .trim()
      .split("\n")
      .filter((pid) => pid)
      .map((pid) => Number(pid));
    return pids;
  } catch (e) {
    return [];
  }
}

// 等待进程开始监听端口，带超时，返回端口和对应的进程ID
function waitPortFromPid(pid, timeoutMs = 10000, intervalMs = 500, projectId = "default") {
  return new Promise((resolve) => {
    let resolved = false;
    let attempts = 0;
    const maxAttempts = Math.ceil(timeoutMs / intervalMs);

    log(projectId, "INFO", `开始等待监听端口`, {
      pid,
      timeoutMs,
      intervalMs,
      maxAttempts
    });

    function checkOnce() {
      if (resolved) return;
      attempts++;

      log(projectId, "INFO", `查询监听端口 (第${attempts}/${maxAttempts}次)`, {
        pid,
        attempts
      });

      try {
        log(projectId, "DEBUG", `开始调用getPortsAndPidsByPid`, { pid });
        const queryStartTime = Date.now();
        const portPidMap = getPortsAndPidsByPid(pid, projectId);
        const queryDuration = Date.now() - queryStartTime;
        
        log(projectId, "DEBUG", `getPortsAndPidsByPid调用完成`, { 
          pid, 
          mapSize: portPidMap.size,
          duration: `${queryDuration}ms`
        });

        if (portPidMap.size > 0) {
          resolved = true;
          // 返回第一个监听的端口和对应的进程ID
          const firstPort = Array.from(portPidMap.keys()).sort(
            (a, b) => a - b
          )[0];
          const actualPid = portPidMap.get(firstPort);
          
          log(projectId, "INFO", `成功检测到监听端口`, {
            pid,
            actualPid,
            port: firstPort,
            attempts,
            allPorts: Array.from(portPidMap.keys())
          });
          
          resolve({ port: firstPort, pid: Number(actualPid) });
          return;
        }
        
        log(projectId, "DEBUG", `本次查询未找到监听端口`, { pid, attempts });
      } catch (e) {
        const errMsg = e && e.message ? e.message : String(e);
        log(projectId, "ERROR", `查询端口时发生异常`, { 
          pid, 
          attempts,
          error: errMsg,
          stack: e && e.stack ? e.stack : ""
        });
      }
    }

    // 初次尝试
    checkOnce();
    if (resolved) return;

    const interval = setInterval(() => {
      if (resolved) return;
      checkOnce();
      if (resolved) {
        clearInterval(interval);
        clearTimeout(timer);
      }
    }, intervalMs);

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      clearInterval(interval);
      
      log(projectId, "WARN", `等待监听端口超时`, {
        pid,
        timeoutMs,
        attempts
      });
      
      resolve(undefined);
    }, timeoutMs);
  });
}

// 轮询等待端口进入监听状态
function waitPortListening(port, timeoutMs = 10000, intervalMs = 300) {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    function tick() {
      if (isPortListening(port)) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, intervalMs);
    }

    tick();
  });
}

// 从日志文件中提取首次出现的端口号，带超时
function waitPortFromLog(logPath, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let resolved = false;

    function extractPortFromContent(content) {
      // 按行分割，从最新内容开始查找端口
      const lines = content.split("\n").reverse();

      for (const line of lines) {
        // 跳过时间戳行（包含 [YYYY/M/D H:MM:SS] 格式）
        if (line.match(/^\[[\d\/\s:]+\]/)) continue;

        // 跳过明确错误/占用语句，避免误把错误中的 :端口 解析为成功端口
        if (/(EADDRINUSE|address already in use|Error:\s*listen)/i.test(line)) {
          continue;
        }

        // 跳过错误对象字段，如 "port: 10001"、"code: 'EADDRINUSE'" 等
        if (/^(\s|\t)*(code|errno|syscall|address|port)\s*:/i.test(line)) {
          continue;
        }

        // 1. 优先匹配 URL 格式: http://localhost:5173/ 或 https://127.0.0.1:3000
        const urlMatch = line.match(/https?:\/\/[^\s:]+:(\d{2,5})/);
        if (urlMatch) return Number(urlMatch[1]);

        // 2. 匹配带有动词的端口声明，避免匹配裸 "port: 3000"
        const portTextMatch = line.match(
          /(?:listening|running|started)[^\n]*\bport\b\s*:?\s*(\d{2,5})/i
        );
        if (portTextMatch) return Number(portTextMatch[1]);

        // 3. 匹配 "listening on :3000" 或 "server running on :8080"
        const listenMatch = line.match(
          /(?:listening|running|started)\s+on\s*:(\d{2,5})/i
        );
        if (listenMatch) return Number(listenMatch[1]);

        // 4. 匹配 "Local: http://localhost:3000" 或 "Network: http://192.168.1.1:3000"
        const localMatch = line.match(
          /(?:Local|Network|local|network):\s*https?:\/\/[^\s:]+:(\d{2,5})/i
        );
        if (localMatch) return Number(localMatch[1]);

        // 5. Next.js: ready - started server on 0.0.0.0:3000, url: ...
        const nextReadyMatch = line.match(
          /ready\s*-\s*started\s*server[^:]*:(\d{2,5})/i
        );
        if (nextReadyMatch) return Number(nextReadyMatch[1]);

        // 取消泛化兜底：避免把报错里的 :端口 当成成功端口
      }

      return undefined;
    }

    function checkOnce() {
      if (resolved) return;
      try {
        if (!fs.existsSync(logPath)) return;
        const stats = fs.statSync(logPath);
        const readSize = Math.min(64 * 1024, stats.size);
        const fd = fs.openSync(logPath, "r");
        const buffer = Buffer.alloc(readSize);
        fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
        fs.closeSync(fd);
        const text = buffer.toString("utf8");
        const port = extractPortFromContent(text);
        if (port) {
          resolved = true;
          resolve(port);
        }
      } catch (_) {}
    }

    // 初次尝试
    checkOnce();
    if (resolved) return;

    const interval = setInterval(() => {
      if (resolved) return;
      checkOnce();
      if (resolved) {
        clearInterval(interval);
        clearTimeout(timer);
      }
    }, 500);

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      clearInterval(interval);
      resolve(undefined);
    }, timeoutMs);
  });
}

// 根据脚本推断应传递的端口参数
function buildPortArgsForScript(script, port) {
  const args = [];
  const p = String(port);
  if (!script || typeof script !== "string") return args;
  const lower = script.toLowerCase();

  // Vite: 如果指定了端口，强制使用该端口，并开启严格模式（端口占用则失败）
  if (lower.includes("vite")) {
    if (port) {
        args.push("--port", p, "--strictPort");
    }
    return args;
  }
  // 常见工具：vite、webpack-dev-server、vitepress、umi、serve
  if (
    lower.includes("webpack") ||
    lower.includes("vitepress") ||
    lower.includes("umi") ||
    lower.includes("serve")
  ) {
    args.push("--port", p);
    return args;
  }
  // next/nuxt 一般支持 -p/--port
  if (lower.includes("next") || lower.includes("nuxt")) {
    // Next/Nuxt 使用 CLI 端口参数，避免使用环境变量 PORT
    args.push("-p", p);
    return args;
  }
  // 兜底：--port
  args.push("--port", p);
  return args;
}

export {
  parsePortFromScript,
  getAvailablePort,
  waitPortFromLog,
  buildPortArgsForScript,
  isPortListening,
  waitPortListening,
  getPortsByPid,
  waitPortFromPid,
  getPidsByPort,
  getChildPids,
  getPortsAndPidsByPid,
};
