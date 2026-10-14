/**
 * dep_utils.ts — 依赖解析与安装工具
 *
 * 职责：
 * 1. stripStringLiterals(source) — 剥掉字符串字面量（防止 prompt 里的示例被误读）
 * 2. parseDeps(source) — 从源码解析 @DEPS 声明
 * 3. ensureDeps(deps) — 检查缺失并 npm install
 *
 * ★ 关键约束：
 * - parseDeps 先 stripStringLiterals，再扫前 30 行的注释行
 * - stripStringLiterals 保留行注释和块注释（@DEPS 在注释里）
 * - stripStringLiterals 剥单/双/反引号字符串内容（模板字符串整体剥）
 *
 * 说明：
 * - 这个 stripStringLiterals 是"简化版"：不处理 ${...} 嵌套、不处理正则字面量
 * - 对 @DEPS 解析足够
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ============================================================
// 缓存与锁
// ============================================================

/** 已安装的包缓存（避免重复 npm install） */
const _installed = new Set<string>();

/** 安装锁（避免并发安装冲突） */
let _installLock: Promise<void> | null = null;

/** 安装超时（2 分钟） */
const INSTALL_TIMEOUT_MS = 120_000;

/** @DEPS 只扫文件的前 N 行 */
const DEPS_SCAN_LINES = 30;

// ============================================================
// ★ 剥字符串字面量
// ============================================================

/**
 * 剥掉源码里的字符串字面量。
 *
 * 处理：
 * - 单引号 '...'
 * - 双引号 "..."
 * - 反引号 `...`（模板字符串，整体剥，不处理 ${...}）
 * - 保留行注释 // ... 和块注释 /* ... * /（@DEPS 在注释里）
 * - 保留换行符（保持行数不变）
 *
 * 用途：
 * - parseDeps 用它先剥字符串，防止 prompt 里的示例 @DEPS 被当真
 */
export function stripStringLiterals(source: string): string {
  if (!source) return "";

  let result = "";
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];

    // ---------- 单引号字符串 ----------
    if (ch === "'") {
      result += "'";
      i++;
      while (i < len) {
        const c = source[i];
        if (c === "\\") {
          result += "  ";
          i += 2;
          continue;
        }
        if (c === "'") {
          result += "'";
          i++;
          break;
        }
        result += c === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }

    // ---------- 双引号字符串 ----------
    if (ch === '"') {
      result += '"';
      i++;
      while (i < len) {
        const c = source[i];
        if (c === "\\") {
          result += "  ";
          i += 2;
          continue;
        }
        if (c === '"') {
          result += '"';
          i++;
          break;
        }
        result += c === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }

    // ---------- 反引号（模板字符串，整体剥） ----------
    if (ch === "`") {
      result += "`";
      i++;
      while (i < len) {
        const c = source[i];
        if (c === "\\") {
          result += "  ";
          i += 2;
          continue;
        }
        if (c === "`") {
          result += "`";
          i++;
          break;
        }
        result += c === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }

    // ---------- 行注释（保留内容，@DEPS 在这里） ----------
    if (ch === "/" && source[i + 1] === "/") {
      result += "//";
      i += 2;
      while (i < len && source[i] !== "\n") {
        result += source[i];
        i++;
      }
      continue;
    }

    // ---------- 块注释（保留内容，@DEPS 也可能在这里） ----------
    if (ch === "/" && source[i + 1] === "*") {
      result += "/*";
      i += 2;
      while (i < len) {
        if (source[i] === "*" && source[i + 1] === "/") {
          result += "*/";
          i += 2;
          break;
        }
        result += source[i];
        i++;
      }
      continue;
    }

    // ---------- 普通字符 ----------
    result += ch;
    i++;
  }

  return result;
}

// ============================================================
// @DEPS 解析
// ============================================================

/**
 * 从源码里提取所有依赖。
 *
 * 支持的格式（必须在文件顶部 30 行内，必须是注释行）：
 *   // @DEPS: zod
 *   // @DEPS zod
 *   // @DEPS: zod@3.22.0
 *   // @DEPS: zod axios
 *   // @DEPS: @scope/pkg@1.2.3
 *   * @DEPS: zod          （JSDoc 风格）
 *   /** @DEPS: zod *&#47;   （单行 JSDoc）
 *
 * 不支持：
 *   - 30 行之后的 @DEPS
 *   - 非注释行的 @DEPS
 *   - 字符串里的 @DEPS（先 stripStringLiterals 剥掉）
 */
export function parseDeps(source: string): string[] {
  const deps: string[] = [];
  const seen = new Set<string>();

  if (!source) return deps;

  // ★ 先剥字符串字面量（防止 prompt 里的示例 @DEPS 被当真）
  const stripped = stripStringLiterals(source);

  // ★ 只扫前 30 行
  const lines = stripped.split(/\r?\n/).slice(0, DEPS_SCAN_LINES);

  // ★ 每行必须以注释开头，严格匹配 @DEPS
  const lineRe = /^\s*(?:\/\/|\*|\/\*\*?)\s*@DEPS:?\s*(.+?)\s*$/i;

  // 包名模式：scoped 包 或 普通包，可带 @version
  const pkgRe =
    /(@[a-zA-Z0-9_.\-]+\/[a-zA-Z0-9_.\-]+(?:@[a-zA-Z0-9_.\-]+)?|[a-zA-Z0-9_.\-]+(?:@[a-zA-Z0-9_.\-]+)?)/g;

  for (const line of lines) {
    const m = lineRe.exec(line);
    if (!m) continue;

    let content = m[1];

    // 去掉行尾 */
    content = content.replace(/\*\/\s*$/, "").trim();

    // 抓所有包名
    let pkgMatch: RegExpExecArray | null;
    pkgRe.lastIndex = 0;
    while ((pkgMatch = pkgRe.exec(content)) !== null) {
      let pkg = pkgMatch[1].trim();
      pkg = pkg.replace(/[.,;)}\]]+$/, "");

      if (isValidPkgName(pkg) && !seen.has(pkg)) {
        seen.add(pkg);
        deps.push(pkg);
      }
    }
  }

  return deps;
}

/**
 * 判断是不是合法的包名。
 * 排除一些常见误抓：
 * - 纯数字
 * - import / export / from / const 等关键字
 * - 中文（"包名"、"版本"）
 */
function isValidPkgName(pkg: string): boolean {
  if (!pkg) return false;

  // 纯数字
  if (/^\d+$/.test(pkg)) return false;

  // 保留字 / 常见关键字
  const reserved = new Set([
    "import", "export", "from", "const", "let", "var",
    "function", "return", "if", "else", "for", "while",
    "class", "extends", "new", "this", "super",
    "true", "false", "null", "undefined",
    "as", "type", "interface", "enum",
    "package", "version", "pkg", "name",
  ]);
  if (reserved.has(pkg.toLowerCase())) return false;

  // 必须含字母
  if (!/[a-zA-Z]/.test(pkg)) return false;

  // 长度限制（npm 包名上限 214）
  if (pkg.length > 214) return false;

  return true;
}

// ============================================================
// 依赖检查 + 安装
// ============================================================

/**
 * 检查缺失的依赖并安装。
 */
export async function ensureDeps(deps: string[]): Promise<void> {
  if (!deps || deps.length === 0) return;

  // 1. 检查哪些缺失
  const missing: string[] = [];
  for (const dep of deps) {
    if (_installed.has(dep)) continue;
    if (isInstalled(dep)) {
      _installed.add(dep);
      continue;
    }
    missing.push(dep);
  }

  if (missing.length === 0) return;

  // 2. 串行安装
  if (_installLock) {
    await _installLock;
    const stillMissing = missing.filter(
      (d) => !_installed.has(d) && !isInstalled(d)
    );
    if (stillMissing.length === 0) return;
    await doInstall(stillMissing);
  } else {
    const p = doInstall(missing);
    _installLock = p;
    try {
      await p;
    } finally {
      _installLock = null;
    }
  }
}

/**
 * 检查包是否已装（node_modules 里存在即可）。
 */
export function isInstalled(pkg: string): boolean {
  const name = extractPkgName(pkg);
  if (!name) return false;

  const pkgPath = join(process.cwd(), "node_modules", name);
  return existsSync(pkgPath);
}

/**
 * 从 "pkg@1.2.3" 里提取包名 "pkg"。
 * 支持 scoped: "@scope/name@1.2.3" → "@scope/name"
 */
export function extractPkgName(pkg: string): string {
  if (!pkg) return "";
  if (pkg.startsWith("@")) {
    const parts = pkg.split("@");
    if (parts.length >= 2) {
      return "@" + parts[1];
    }
    return "";
  }
  return pkg.split("@")[0];
}

async function doInstall(deps: string[]): Promise<void> {
  console.log(`[dep_utils] Installing: ${deps.join(", ")}`);

  try {
    const quoted = deps.map((d) => `"${d}"`).join(" ");
    await execAsync(`npm install ${quoted}`, {
      cwd: process.cwd(),
      timeout: INSTALL_TIMEOUT_MS,
    });

    for (const dep of deps) {
      _installed.add(dep);
    }
    console.log(`[dep_utils] Installed: ${deps.join(", ")}`);
  } catch (e: any) {
    console.error(`[dep_utils] Install failed: ${e.message}`);
    // 不抛异常，让后续 import 报更精确的错误
  }
}
