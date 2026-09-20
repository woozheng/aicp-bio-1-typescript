/**
 * Config Loader — 读 aicp.yaml，解析环境变量，深合并默认配置
 *
 * 与 Python 版 aicp/config.py 对应。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { load as yamlLoad } from "js-yaml";

// ============================================================
// 默认配置
// ============================================================

export const DEFAULT_CONFIG = {
  host: "0.0.0.0",
  port: 9000,
  plugins_dir: "src/plugins",
  data_dir: "data",
  static_dir: null as string | null,
  models: {
    default: "gpt-3.5-turbo",
    max_retries: 3,
    request_timeout: 60,
    stream_timeout: 300,
    max_concurrent: 10,
    providers: {} as Record<string, any>,
  },
  robots: [] as any[],
  groups: [] as any[],
};

// ============================================================
// 环境变量解析
// ============================================================

const ENV_VAR_PATTERN = /\$\{(\w+)\}/g;

function resolveEnvVars(value: any): any {
  if (typeof value !== "string") return value;

  return value.replace(ENV_VAR_PATTERN, (_, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      console.warn(`  ⚠️  Environment variable '${varName}' not set, using empty string`);
      return "";
    }
    return envValue;
  });
}

function walkAndResolve(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(walkAndResolve);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = walkAndResolve(v);
    }
    return result;
  }
  if (typeof obj === "string") {
    return resolveEnvVars(obj);
  }
  return obj;
}

// ============================================================
// 深合并
// ============================================================

function deepMerge(base: Record<string, any>, override: Record<string, any>): void {
  for (const [key, value] of Object.entries(override)) {
    if (
      key in base &&
      typeof base[key] === "object" &&
      base[key] !== null &&
      !Array.isArray(base[key]) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      deepMerge(base[key], value);
    } else {
      base[key] = value;
    }
  }
}

function deepCopy<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// ============================================================
// 主入口
// ============================================================

export interface Config {
  host: string;
  port: number;
  plugins_dir: string;
  data_dir: string;
  static_dir: string | null;
  models: Record<string, any>;
  robots: any[];
  groups: any[];
  [key: string]: any;
}

export function loadConfig(configPath?: string): Config {
  const config = deepCopy(DEFAULT_CONFIG) as Config;

  const path = configPath ? resolve(configPath) : resolve("aicp.yaml");

  if (existsSync(path)) {
    console.log(`   Loading: ${path}`);
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = yamlLoad(raw);   // ← 改这里
      if (parsed && typeof parsed === "object") {
        const resolved = walkAndResolve(parsed);
        deepMerge(config, resolved);
      }
    } catch (e: any) {
      console.error(`   Failed to load config: ${e.message}`);
    }
  } else {
    console.log(`   No config file found, using defaults`);
    createDefaultConfig(path);
  }

  return config;
}

function createDefaultConfig(path: string): void {
  const defaultYaml = `# AICP Configuration

host: 0.0.0.0
port: 9000

models:
  default: gpt-3.5-turbo
  max_retries: 3
  request_timeout: 60
  stream_timeout: 300
  max_concurrent: 10
  providers:
    openai:
      base_url: https://api.openai.com/v1
      api_key: \${OPENAI_API_KEY}
      models:
        - id: gpt-3.5-turbo
          max_tokens: 4096
          temperature: 0.7
          default: true
`;

  try {
    writeFileSync(path, defaultYaml, "utf-8");
    console.log(`   Created default config: ${path}`);
  } catch {
    // ignore
  }
}