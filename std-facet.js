/**
 * std-facet.js — vision-exp-tile 标准 Host Facet 入口（dsh-std 生态化 · v0.5.0）
 *
 * 本模块是 dsh-plugin.json（facets.host.entry）指向的标准组件入口，由宿主侧的
 * @dsh-std/adapter-dsh 动态 import 装载（await import(file://...)）：
 *
 *   - 默认导出 defineFacet(...) 的结果（FacetModule：activate / deactivate / snapshot）；
 *   - activate(context) 内把本插件的三个工具发布为 tools.dsh/v1alpha1 Tool 资源
 *     + ToolHandler（可执行定义），adapter 自动映射进 DSH 原生工具目录；
 *   - 构造与旧 src/index.js apply(ctx) 兼容的轻量 ctx 视图（logger/effect/tools），
 *     src 业务逻辑（tile-engine / pipeline / vision-client / ocr-* 等）零改动复用；
 *   - 配置由 src/settings-file.js 文件化（~/.dsh/vision-exp-tile.json），
 *     不再依赖宿主 dsh-settings 服务。
 *
 * 依赖（npm）：@dsh-std/sdk（defineFacet）、@dsh-std/tool（协议常量）。
 * 本模块只 import 协议包与相对模块，不 import 任何 @deepseek-ai/* 宿主包。
 *
 * @module vision-exp-tile/std-facet
 */

import { defineFacet } from '@dsh-std/sdk';
import { API_VERSION as TOOL_API_VERSION, KIND as TOOL_KIND } from '@dsh-std/tool';
import { setActiveExecEnv } from './src/host-io.js';
import { readPeerSettings } from './src/peer-config.js';
import * as plugin from './src/index.js';

/**
 * 把 v0.4.x 的裸工具对象适配为「标准可执行工具定义」（ExecutableToolDefinition）。
 *
 * 关键适配：
 *   - execute 入口注入标准 ToolExecutionContext（供 src/host-io 的相对路径委托），
 *     执行结束清空——避免跨调用串扰；
 *   - 旧 exec 只被 src 用作 exec.signal → 垫片 { signal } 即足够；
 *   - 返回 { data, content }：data = 工具结果 JSON；content = output.render 的
 *     模型可读文本（与标准 [ { type: 'text', text } ] 同构）。
 *
 * @param {object} tool - createSplitTool / createRecognizeTool / createRegionCropTool 的产物。
 * @returns {object} ExecutableToolDefinition。
 */
function toExecutableToolDefinition(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: tool.output?.schema ?? {},
    async execute(input, context) {
      // 向 host-io 注入本次执行的标准环境（相对路径 → readWorkspaceFile 语义）。
      setActiveExecEnv(context);
      try {
        // 旧工具对象的 execute 契约：(args, exec)；exec 只用到 signal。
        const legacyExec = { signal: context?.signal ?? undefined };
        const data = await tool.execute(input, legacyExec);
        // 复用工具的 render（若提供）：模型可读文本，标准 content 数组。
        const content = typeof tool.output?.render === 'function'
          ? (tool.output.render(input, data) ?? [])
          : [{ type: 'text', text: JSON.stringify(data) }];
        return { data, content };
      } finally {
        setActiveExecEnv(null);
      }
    },
    ...(typeof tool.isConcurrencySafe === 'function'
      ? { isConcurrencySafe: (input) => tool.isConcurrencySafe(input) }
      : {}),
  };
}

/**
 * 标准 Host Facet 激活：注册三工具 + 初始化文件化设置。
 * @param {object} context - ActivationContext（lifecycle 提供：identity/plan/scope/protocols/extensions）。
 */
export default defineFacet((context) => {
  const { scope } = context;

  // ── 1. 兼容旧 apply 的轻量 ctx 视图 ───────────────────────────────
  //     src/index.js 的 apply(ctx, configRaw) 只需 logger / effect / tools。
  const logger = {
    info: (...args) => console.info('[vision-exp-tile]', ...args),
    warn: (...args) => console.warn('[vision-exp-tile]', ...args),
  };

  const ctx = {
    logger,
    /** Cordis effect 垫片：立即执行 setup，cleanup 挂到激活作用域（卸载时回收）。 */
    effect(setup) {
      const cleanup = setup();
      if (typeof cleanup === 'function') {
        scope.add(() => {
          try { cleanup(); } catch { /* 忽略清理异常 */ }
        });
      }
      return cleanup;
    },
    tools: {
      /**
       * 注册工具 → 发布 Tool 资源 + ToolHandler。
       * adapter 用 extension.metadata.name 匹配 handler 与 manifest 声明
       * （dsh-plugin.json contributes["x-tools"].name），因此 name 必须一致。
       * @param {object} def - 裸工具对象。
       * @returns {() => void} 注销函数（卸载时调用）。
       */
      register(def) {
        const unregister = context.extensions.publish(
          { apiVersion: TOOL_API_VERSION, kind: TOOL_KIND },
          def.name,
          {
            // ToolHandler：resolve 返回可执行定义（每次实时构建，配置热生效）。
            resolve: () => toExecutableToolDefinition(def),
          },
        );
        scope.add(() => {
          try { unregister(); } catch { /* 忽略 */ }
        });
        return () => {
          try { unregister(); } catch { /* 忽略 */ }
        };
      },
      /**
       * 工具目录探测（旧 isPicturereaderPresent 用）：
       * 标准 ActivationContext 不提供全量工具目录客户端 → 恒 undefined，
       * 探测降级为「picturereader 不在场」= description 保持基线（回归红线）。
       * （picturereader 分工引导段于阶段二经协议目录查询恢复）
       */
      get() { return undefined; },
    },
  };

  // ── 2. 复用旧插件入口（内部完成：配置初始化 + 三工具注册 + 设备探测）──
  //     configRaw 传 undefined：设置一律走文件化配置（settings-file.js）。
  plugin.apply(ctx, undefined);
});
