/**
 * runtime/atomic_write — 统一原子写
 *
 * 所有落盘的地方都调这个，避免两套逻辑。
 *
 * 功能：
 * - {project} 占位符替换（路径 + 内容）
 * - 路径校正（plugins/ → src/plugins/ 等）
 * - app_id 应用（www/ → www/{appId}/）
 * - 安全检查（防 .. 逃逸和绝对路径）
 * - 原子写（.xxx.tmp → rename）
 */

import { mkdir, rename } from "node:fs/promises";
import { dirname, basename, resolve, relative } from "node:path";

const PROJECT_ROOT = process.cwd();

// ============================================================
// 路径处理
// ============================================================

function normalizePath(filepath: string): string {
  filepath = filepath.replace(/^\/+/, "");
  filepath = filepath.replace(/^\.\//, "");
  filepath = filepath.replace(/\\/g, "/");

  if (filepath.startsWith("src/plugins/") || filepath.startsWith("www/")) {
    return filepath;
  }
  if (filepath.startsWith("plugins/")) {
    return `src/${filepath}`;
  }
  return `src/plugins/applications/${filepath}`;
}

function applyAppId(filepath: string, appId: string): string {
  if (!appId) return filepath;

  // 只处理 www/ 开头（没有项目层的）
  if (filepath.startsWith("www/") && !filepath.startsWith(`www/${appId}/`)) {
    const rest = filepath.replace(/^www\//, "");
    return `www/${appId}/${rest}`;
  }

  return filepath;
}

function isSafePath(filepath: string): boolean {
  if (filepath.includes("..")) return false;
  if (filepath.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(filepath)) return false;
  return true;
}

// ============================================================
// 原子写
// ============================================================

/**
 * 原子写：写 .xxx.tmp → rename 到目标文件
 *
 * @param path 目标路径（可含 {project} 占位符）
 * @param content 文件内容（可含 {project} 占位符）
 * @param appId 项目名（可选，用于 {project} 替换和 www/ 补全）
 * @returns 实际落盘的路径
 */
export async function atomicWrite(
  path: string,
  content: string,
  appId: string = ""
): Promise<string> {
  // 1. {project} 替换（路径 + 内容）
  if (appId) {
    path = path.replace(/\{project\}/g, appId);
    content = content.replace(/\{project\}/g, appId);
  }

  // 2. 路径校正
  path = normalizePath(path);

  // 3. app_id 应用
  path = applyAppId(path, appId);

  // 4. 安全检查
  if (!isSafePath(path)) {
    throw new Error(`不安全的路径: ${path}`);
  }

  // 5. 解析绝对路径，确认在项目内
  const absPath = resolve(PROJECT_ROOT, path);
  const relPath = relative(PROJECT_ROOT, absPath);
  if (relPath.startsWith("..")) {
    throw new Error(`路径逃逸: ${path}`);
  }

  // 6. 原子写
  await mkdir(dirname(absPath), { recursive: true });

  const dir = dirname(absPath);
  const name = basename(absPath);
  const tmpPath = `${dir}/.${name}.tmp`;

  await Bun.write(tmpPath, content);
  await rename(tmpPath, absPath);

  return path;
}