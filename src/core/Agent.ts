/**
 * Agent — 能力容器
 * 与 Python 版 core.py 的 Agent 完全对应
 *
 * 注意：它不是执行引擎，不是路由表，只是"挂东西的地方"。
 */

export class Agent {
  [key: string]: any;

  constructor(kwargs: Record<string, any> = {}) {
    for (const [key, value] of Object.entries(kwargs)) {
      (this as any)[key] = value;
    }
  }

  get(key: string, defaultValue: any = null): any {
    return (this as any)[key] ?? defaultValue;
  }
}