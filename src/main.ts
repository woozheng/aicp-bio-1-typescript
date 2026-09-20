/**
 * AICP-TS 入口
 *
 * 启动流程：
 * 1. 读配置（aicp.yaml + 环境变量）
 * 2. 创建 SystemServer
 * 3. 创建 LLM
 * 4. 加载所有插件
 * 5. 启动热重载 watcher
 * 6. 启动 gateway
 * 7. 启动 file_receiver
 * 8. 启动 websocket
 */

import { SystemServer } from "./runtime/system.js";
import { LLM } from "./runtime/llm.js";
import { PluginLoader } from "./runtime/plugin_loader.js";
import { startHotReloadWatcher } from "./runtime/hot_reload_watcher.js";
import { loadConfig } from "./runtime/config.js";
import { Envelop } from "./core/Envelop.js";
import { installLogger } from "./runtime/logger.js";

// 在 main 之前安装 logger，确保所有日志都被捕获
installLogger();

async function main() {
  console.log("[AICP-TS] Starting...");

  // 1. 读配置
  const config = loadConfig();
  console.log(
    `[AICP-TS] Config: host=${config.host} port=${config.port} plugins=${config.plugins_dir}`
  );

  // 2. SystemServer
  const system = new SystemServer({
    config,
    dataDir: config.data_dir,
    baseUrl: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`,
  });

  // 3. LLM（配置解析收在 LLM 内部）
  const llm = new LLM(config.models ?? {});
  system.setLLM(llm);

  // 4. 加载插件
  const loader = new PluginLoader(system, config.plugins_dir);
  const loaded = await loader.loadAll();
  console.log(`[AICP-TS] Loaded ${loaded} plugins`);

  // 5. 启动热重载 watcher
  startHotReloadWatcher({
    system,
    pluginsDir: config.plugins_dir,
    interval: 2,
  });
  console.log("[AICP-TS] Hot reload watcher started");

  // 6. 启动 gateway
  const gatewayResult = await system.call(
    new Envelop({
      sender: "main",
      receiver: "os/_gateway",
      payload: {
        action: "START",
        port: config.port,
        host: config.host,
      },
    })
  );
  if (gatewayResult?.payload?.status !== "listening") {
     throw new Error(`Gateway 启动失败: ${gatewayResult?.payload?.error}`);
  }
  console.log("[AICP-TS] Gateway started:", gatewayResult.payload);

  // 7. 启动 file_receiver（port + 2）
  const fileResult = await system.call(
    new Envelop({
      sender: "main",
      receiver: "os/_file_receiver",
      payload: {
        action: "START",
        port: config.port + 2,
        host: config.host,
      },
    })
  );
  if (fileResult?.payload?.status !== "listening") {
    throw new Error(`FileReceiver 启动失败: ${fileResult?.payload?.error ?? "未知错误"}`);
  }
  console.log("[AICP-TS] FileReceiver started:", fileResult.payload);

  // 8. 启动 websocket（port + 1）
  const wsResult = await system.call(
    new Envelop({
      sender: "main",
      receiver: "os/_websocket",
      payload: {
        action: "START",
        port: config.port + 1,
        host: config.host,
      },
    })
  );
   if (wsResult?.payload?.status !== "listening") {
    throw new Error(`WebSocket 启动失败: ${wsResult?.payload?.error ?? "未知错误"}`);
  }
  console.log("[AICP-TS] WebSocket started:", wsResult.payload);

  console.log("[AICP-TS] All services started.");
}

main().catch((e) => {
  console.error("[AICP-TS] Fatal:", e);
  process.exit(1);
});