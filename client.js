/**
 * client.js — vision-exp-tile 的 Web 设置页（DSH 0.2.0 客户端插件形态）
 *
 * 形态说明（照官方模板 templates/decoration + 官方设置页范例写成）：
 *   - 浏览器侧「懒加载工厂」：window.__ModuleLoader__.load({ id, factory })，
 *     id 必须等于包名（vision-exp-tile），React 由浏览器模块表提供（require('react')），
 *     因此本文件是**手写 JS、无需构建步骤**。
 *   - 页面注册：把一张「设置卡片」注册进插件页的 `plugins.item` slot
 *     （DSH Web 侧栏「插件」页 → 分组内卡片），与官方设置页同构。
 *   - 数据通道：`ctx.configForms.get('vision-exp-tile')` —— 0.2.0 的设置域服务，
 *     以 profile 条目 id 定位插件配置（即 src/plugin-config.js 里 volatile 字段），
 *     读写经 Host 校验并持久化到 profile 的 Cordis patch。
 *
 * ⚠ 与旧版的差异：v0.4.x 用的是 `ctx.settingsScope.bind(...)`，该 API 在 0.2.0
 *   已被移除（全量扫描宿主程序 0 命中），因此本文件按新机制重写。
 *
 * ⚠ 官方明确劝阻第三方插件 require 宿主客户端 UI 包（@deepseek-ai/dsh-client-ui-*），
 *   故本页**不使用任何 UI 包**：控件、暂存、保存全部自绘，样式继承宿主主题变量，
 *   样式表以 React 元素形式随组件挂载/卸载（不污染宿主）。
 */
window.__ModuleLoader__.load({
  id: 'vision-exp-tile',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** profile 条目 id（= package.json 包名 = cordis.patch.yml 里的插入行 id）。 */
    const ENTRY_ID = 'vision-exp-tile';

    /**
     * 字段表：与 src/plugin-config.js 的 Config（volatile 字段）**一一对应**
     * （数量与键名不一致会被 scripts/client-settings-smoke.mjs 的双向一致性断言拦下）。
     *
     * type 决定控件：text / password（敏感项，如 API 密钥直填）/ number / boolean / select；
     * numeric 表示该 select 的值要按数字提交（如 rotate 的 0/90/180/270）；
     * group 决定分组（见 GROUPS）。
     */
    const GROUPS = [
      { id: 'core', title: '识别与接口' },
      { id: 'tile', title: '切块与输出' },
      { id: 'perf', title: '性能与 OCR 池' },
      { id: 'gpu', title: 'GPU 加速' },
      { id: 'device', title: '设备适配' },
      { id: 'debug', title: '调试与测试' }
    ];

    /** 选项简写：第一项恒为「（默认）」= 未设置（回落配置文件/内置默认）。 */
    const opt = (value, label) => ({ value, label });
    const dft = (label) => ({ value: '', label: label || '（默认）' });

    const FIELDS = [
      // ── 识别与接口 ──
      { key: 'base_url', group: 'core', type: 'text', label: '视觉 API 地址', hint: '留空 = 内置默认（https://api.deepseek.com）' },
      { key: 'api_key_env', group: 'core', type: 'text', label: '密钥环境变量名', hint: '默认 DEEPSEEK_API_KEY；留空 = 用默认' },
      // v1.0.0 大更新③：多模态端点泛化（分组「识别与接口」）
      {
        key: 'provider', group: 'core', type: 'select', label: '端点画像',
        options: [dft('（默认 auto）'), opt('auto', 'auto（按地址自动判定）'), opt('deepseek', 'deepseek（DeepSeek 端点）'),
          opt('openai', 'openai（OpenAI 兼容 / 本地 vLLM、Ollama、LM Studio）'), opt('minimal', 'minimal（极简兼容，只发最小请求体）')],
        hint: 'auto：地址含 deepseek 走 DeepSeek 画像，其余走 OpenAI 兼容画像'
      },
      { key: 'api_path', group: 'core', type: 'text', label: '接口路径覆盖', hint: '留空 = 画像默认 /chat/completions；可含 query（如 Azure 的 ?api-version=）' },
      {
        key: 'api_key', group: 'core', type: 'password', label: 'API 密钥（直填）',
        hint: '优先级高于环境变量名；本地端点可留空。保存后仅以密文回显，日志中会打码'
      },
      { key: 'model', group: 'core', type: 'text', label: '视觉模型', hint: '留空 = 内置默认模型' },
      { key: 'max_tokens', group: 'core', type: 'number', label: '输出 token 上限', hint: '单次识别返回的最大 token 数' },
      { key: 'timeout_ms', group: 'core', type: 'number', label: '请求超时（毫秒）', hint: '留空 = 内置默认' },
      {
        key: 'ocr_engine', group: 'core', type: 'select', label: '本地 OCR 引擎',
        options: [dft('（默认 auto）'), opt('auto', 'auto（优先 rapid，自动降级）'), opt('windows', 'windows（系统 OCR）'),
          opt('paddle', 'paddle（PaddleOCR）'), opt('rapid', 'rapid（RapidOCR）'), opt('gpu', 'gpu（GPU 加速）')],
        hint: 'pipeline 模式的文字识别引擎'
      },
      {
        key: 'preprocess', group: 'core', type: 'select', label: '图片预处理',
        options: [dft('（默认 auto）'), opt('auto', 'auto（自动反色/二值化/放大）'), opt('off', 'off（关闭）'),
          opt('auto-enlarge-off', 'auto-enlarge-off（不自动放大）')],
        hint: '深底/低对比/手写场景的预处理策略'
      },
      {
        key: 'handwrite_route', group: 'core', type: 'select', label: '手写识别路由',
        options: [dft('（默认 smart）'), opt('smart', 'smart（智能选择）'), opt('visual', 'visual（视觉模型直读）'),
          opt('local', 'local（本地 OCR）'), opt('off', 'off（不特殊处理）')],
        hint: '检测到手写时的处理方式'
      },
      {
        key: 'upgrade', group: 'core', type: 'select', label: '低置信度升级',
        options: [dft('（默认 full）'), opt('full', 'full（低置信/手写/深底都升级）'), opt('low', 'low（仅低置信升级）'),
          opt('off', 'off（不升级）')],
        hint: '本地 OCR 结果不佳时是否改用视觉 API 重读'
      },
      // v1.0.0 大更新③：端点高级逃生口（分组「识别与接口」）
      {
        key: 'extra_headers', group: 'core', type: 'text', label: '附加请求头（JSON）',
        hint: '如 {"api-key":"..."}；留空 = 不发。非法 JSON 会被忽略（不会导致报错）'
      },
      {
        key: 'extra_body', group: 'core', type: 'text', label: '附加请求体（JSON）',
        hint: '如 {"temperature":0.2}；不允许覆盖 messages。非法 JSON 会被忽略'
      },
      {
        key: 'image_detail', group: 'core', type: 'select', label: '图片 detail 策略',
        options: [dft('（默认 auto）'), opt('auto', 'auto（按画像）'), opt('off', 'off（不发 detail）'),
          opt('low', 'low（省 token）'), opt('high', 'high'), opt('original', 'original（非 DeepSeek 画像降级为 high）')],
        hint: '不通用字段：OpenAI / 本地端点按画像是「不发」还是「降级」'
      },
      {
        key: 'thinking_mode', group: 'core', type: 'select', label: 'thinking 下发策略',
        options: [dft('（默认 auto）'), opt('auto', 'auto（仅 DeepSeek 画像下发）'), opt('on', 'on（总是下发）'), opt('off', 'off（总是不发）')],
        hint: '部分厂商收到 thinking 会直接 400，默认只对 DeepSeek 下发'
      },
      {
        key: 'max_tokens_field', group: 'core', type: 'select', label: 'token 上限字段名',
        options: [dft('（默认 auto）'), opt('auto', 'auto（按画像，400 时自动回退）'), opt('max_tokens', 'max_tokens'),
          opt('max_completion_tokens', 'max_completion_tokens（OpenAI 推理模型）')],
        hint: '留空 = auto：报 400 提到字段名时自动换字段重试一次'
      },

      // ── 切块与输出 ──
      { key: 'block_size', group: 'tile', type: 'number', label: '切块边长（像素）', hint: '官方缩放甜蜜点为 800' },
      { key: 'cut_threshold', group: 'tile', type: 'number', label: '切块阈值（长边）', hint: '长边超过此值才切块' },
      { key: 'overlap', group: 'tile', type: 'number', label: '相邻块交叠（像素）', hint: '推荐 64，防止跨块切断内容' },
      { key: 'group_size', group: 'tile', type: 'number', label: '分层聚合组大小', hint: '每多少个块合并成一次请求' },
      {
        key: 'format', group: 'tile', type: 'select', label: '块格式',
        options: [dft('（默认 png）'), opt('png', 'png（无损）'), opt('jpeg', 'jpeg（省体积）')],
        hint: '仅 full 模式切块时有效'
      },
      { key: 'quality', group: 'tile', type: 'number', label: 'jpeg 质量', hint: '40..100，仅 format=jpeg 有效' },
      { key: 'with_overview', group: 'tile', type: 'boolean', label: '输出布局参考图（overview）', hint: '在切块结果旁生成网格编号总览图' },
      { key: 'out_dir', group: 'tile', type: 'text', label: '输出目录', hint: '留空 = 源图同目录；相对路径基于源图目录' },
      {
        key: 'rotate', group: 'tile', type: 'select', numeric: true, label: '图片旋转（度）',
        options: [dft('（默认 0）'), opt('90', '90°'), opt('180', '180°'), opt('270', '270°')],
        hint: '图片横倒/倒置时使用'
      },
      {
        key: 'mode', group: 'tile', type: 'select', label: '请求编排模式',
        options: [dft('（默认 auto）'), opt('auto', 'auto（按图片数自动）'), opt('single', 'single（单请求）'),
          opt('layered', 'layered（分层聚合）')],
        hint: '块数较多时 layered 更稳'
      },
      { key: 'json', group: 'tile', type: 'boolean', label: 'JSON 结构化返回', hint: '仅 full 模式有效' },

      // ── 性能与 OCR 池 ──
      { key: 'interest_concurrency', group: 'perf', type: 'number', label: '兴趣点并行数', hint: '1..4，默认 2；调高更快但更吃资源' },
      { key: 'ocr_pool', group: 'perf', type: 'number', label: 'OCR 进程池大小', hint: '留空 = 按设备档位自动' },
      { key: 'ocr_cache', group: 'perf', type: 'boolean', label: '启用 OCR 结果缓存', hint: '同一图重复识别时省时间' },
      { key: 'ocr_preproc', group: 'perf', type: 'boolean', label: '启用 OCR 前预处理', hint: '深底/低对比时先做图像增强' },
      { key: 'ocr_pool_timeout_ms', group: 'perf', type: 'number', label: 'OCR 池单请求超时（毫秒）', hint: '慢机可调大' },
      {
        key: 'performance_tier', group: 'perf', type: 'select', label: '性能档位',
        options: [dft('（默认 auto）'), opt('auto', 'auto（按设备自动）'), opt('fast', 'fast（高性能）'),
          opt('normal', 'normal（均衡）'), opt('slow', 'slow（低性能/省电）')],
        hint: '影响并发、超时与 GPU 开关推荐'
      },
      // v1.0.0 大更新④：性能与结果缓存（分组「性能与 OCR 池」）
      { key: 'api_concurrency', group: 'perf', type: 'number', label: '组间并发上限', hint: '0..4；0 = 自动（按算力预算，默认）' },
      { key: 'result_cache', group: 'perf', type: 'boolean', label: '启用识别结果缓存', hint: '默认开启；预检/区域识别结果落盘复用，重复跑同图直接命中' },
      { key: 'result_cache_ttl_hours', group: 'perf', type: 'number', label: '结果缓存有效期（小时）', hint: '1..8760，默认 168（7 天）；0 视为非法并回落默认' },
      { key: 'result_cache_max_mb', group: 'perf', type: 'number', label: '结果缓存体积上限（MB）', hint: '16..10240，默认 512；超限从最旧开始清理' },

      // ── GPU 加速 ──
      {
        key: 'gpu_provider', group: 'gpu', type: 'select', label: 'GPU 提供者',
        options: [dft('（默认 auto）'), opt('auto', 'auto（自动选择）'), opt('cuda', 'cuda（NVIDIA）'),
          opt('dml', 'dml（DirectML）'), opt('openvino', 'openvino'), opt('off', 'off（关闭 GPU）')],
        hint: '按需开启；失败会自动回退 CPU'
      },
      { key: 'gpu_python', group: 'gpu', type: 'text', label: 'GPU 版 Python 路径', hint: '留空 = 内置约定（~/rapid_gpu_venv）' },
      { key: 'gpu_device', group: 'gpu', type: 'text', label: 'GPU 设备', hint: '留空 = 自动选择设备' },
      { key: 'gpu_fallback', group: 'gpu', type: 'boolean', label: 'GPU 失败回退 CPU', hint: '建议保持开启（默认）' },

      // ── 设备适配 ──
      { key: 'device_benchmark', group: 'device', type: 'boolean', label: '启动时跑设备基准', hint: '用于档位推荐；关闭可略快启动' },
      { key: 'device_power_probe', group: 'device', type: 'boolean', label: '启动时探测电源', hint: '电池/交流影响档位推荐' },
      {
        key: 'platform_fallback', group: 'device', type: 'select', label: '平台降级策略',
        options: [dft('（默认 auto）'), opt('auto', 'auto'), opt('on', 'on（总是启用）'), opt('off', 'off（关闭）')],
        hint: '非 Windows 平台或缺失依赖时的降级行为'
      },
      { key: 'slow_net_adapt', group: 'device', type: 'boolean', label: '慢网自适应', hint: '网络慢时降低请求体积/并发' },

      // ── 调试与测试 ──
      { key: 'debug', group: 'debug', type: 'boolean', label: '调试日志', hint: '输出更详细的运行日志' },
      { key: 'test_timeout_factor', group: 'debug', type: 'number', label: '测试超时倍率', hint: '自检脚本用；一般无需改' },
      { key: 'test_skip_timing', group: 'debug', type: 'boolean', label: '测试跳过时序断言', hint: '慢机跑自检时用' }
    ];

    /** 页面样式：继承宿主主题（currentColor / color-mix），随组件挂载。 */
    const STYLE = `
      .vet-card { display: block; }
      .vet-desc { margin: 0 0 12px; opacity: .75; font-size: 13px; line-height: 1.6; }
      .vet-grid { display: grid; grid-template-columns: minmax(140px, 220px) 1fr; gap: 10px 16px; align-items: center; }
      .vet-label { font-size: 13px; }
      .vet-hint { font-size: 12px; opacity: .6; margin-top: 2px; }
      .vet-input { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px;
        border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
        background: color-mix(in srgb, currentColor 5%, transparent); color: inherit; font: inherit; }
      .vet-input:disabled { opacity: .5; }
      .vet-row-check { display: flex; align-items: center; gap: 8px; font-size: 13px; }
      .vet-actions { display: flex; align-items: center; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
      .vet-btn { padding: 6px 14px; border-radius: 8px; cursor: pointer; font: inherit;
        border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
        background: color-mix(in srgb, currentColor 8%, transparent); color: inherit; }
      .vet-btn.primary { background: #247bbf; border-color: #247bbf; color: #fff; }
      .vet-btn:disabled { opacity: .5; cursor: default; }
      .vet-status { font-size: 12px; opacity: .8; }
      .vet-error { color: #d9534f; font-size: 12px; margin-top: 8px; }
      .vet-group { margin: 0 0 18px; }
      .vet-group-title { margin: 0 0 8px; font-size: 13px; font-weight: 600; opacity: .85; }
      .vet-note { font-size: 12px; opacity: .6; margin-top: 12px; line-height: 1.6; }
    `;

    /** 把输入框里的字符串按字段类型转成要提交的值；空串表示「未设置」（回落默认）。 */
    function parseValue(field, raw) {
      const text = String(raw ?? '');
      if (text.trim() === '') return undefined;
      // numeric：数字输入框，以及值为数字的枚举（如 rotate 的 0/90/180/270）
      if (field.type === 'number' || field.numeric) {
        const n = Number(text);
        return Number.isFinite(n) ? n : undefined;
      }
      return text;
    }

    /** 把 Host 里的值渲染成控件可用的文本。 */
    function toText(value) {
      return value === undefined || value === null ? '' : String(value);
    }

    /** select 的当前值必须是选项中存在的字符串（否则回落到空选项）。 */
    function selectValue(text) {
      return typeof text === 'string' ? text : '';
    }

    /**
     * 设置卡片：暂存编辑 → 点保存才写入（与官方设置页交互一致）。
     * @param {object} props - slot 注入的视图参数 + 由 apply 闭包传入的 form（configForms 表单）。
     */
    function SettingsCard(props) {
      const form = props.form;
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
      /** 暂存：{ [key]: 文本值 | boolean }；null 表示无未保存改动。 */
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [savedAt, setSavedAt] = React.useState(null);

      // 订阅 Host 侧快照（写入被接受后会推来新快照）
      React.useEffect(() => {
        const unsubscribe = form.subscribe(() => setSnapshot(form.getSnapshot()));
        return () => { try { unsubscribe && unsubscribe(); } catch { /* 忽略 */ } };
      }, [form]);

      const value = snapshot.value ?? {};
      const writable = snapshot.writable && snapshot.mode === 'host' && snapshot.status === 'ready';
      /**
       * 诊断串：不可写时显示在卡片底部，便于定位卡在哪一环
       * （设置域服务未就绪 / 只读部署 / 条目无法唯一定位 / 无 schema 字段）。
       */
      const diag = 'status=' + snapshot.status + ' mode=' + snapshot.mode + ' writable=' + snapshot.writable
        + ' revision=' + (snapshot.revision === undefined ? '-' : snapshot.revision)
        + ' 生效字段=' + Object.keys(value).length;

      /** 当前显示值：优先暂存值，其次 Host 生效值。 */
      const shown = (field) => {
        if (draft && Object.prototype.hasOwnProperty.call(draft, field.key)) return draft[field.key];
        if (field.type === 'boolean') return Boolean(value[field.key]);
        return toText(value[field.key]);
      };

      const edit = (field, next) => {
        setSavedAt(null);
        setError(null);
        setDraft((prev) => Object.assign({}, prev || {}, { [field.key]: next }));
      };

      const dirty = !!(draft && Object.keys(draft).length > 0);

      /** 保存：逐个字段 set（有值）或 unset（清空 = 恢复默认）。 */
      const save = async () => {
        if (!dirty) return;
        setBusy(true);
        setError(null);
        try {
          for (const field of FIELDS) {
            if (!Object.prototype.hasOwnProperty.call(draft, field.key)) continue;
            const raw = draft[field.key];
            let ok;
            if (field.type === 'boolean') {
              // 复选框：勾选 = 显式 true；取消勾选 = 清除覆盖（回落配置文件/默认）
              ok = raw ? await form.set(field.key, true) : await form.unset(field.key);
            } else {
              const parsed = parseValue(field, raw);
              ok = parsed === undefined ? await form.unset(field.key) : await form.set(field.key, parsed);
            }
            if (!ok) throw new Error('保存被 Host 拒绝：' + field.key);
          }
          setDraft(null);
          setSavedAt(new Date());
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      };

      /** 丢弃草稿（恢复为 Host 当前生效值）。 */
      const discard = () => { setDraft(null); setError(null); setSavedAt(null); };

      /** 全部恢复默认：清空所有字段的覆盖。 */
      const resetAll = async () => {
        setBusy(true);
        setError(null);
        try {
          for (const field of FIELDS) await form.unset(field.key);
          setDraft(null);
          setSavedAt(new Date());
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      };

      // 插件页折叠态只需要一句摘要
      if (props.view === 'summary') return '大图切块识别插件：视觉端点、切块与本地 OCR 设置。';

      /** 渲染单个字段 → [标签元素, 控件元素]。 */
      const renderField = (field) => [
        h('div', { key: field.key + '-label' },
          h('div', { className: 'vet-label' }, field.label),
          field.hint ? h('div', { className: 'vet-hint' }, field.hint) : null
        ),
        field.type === 'boolean'
          ? h('label', { key: field.key + '-input', className: 'vet-row-check' },
              h('input', {
                type: 'checkbox',
                checked: Boolean(shown(field)),
                disabled: !writable || busy,
                onChange: (event) => edit(field, event.target.checked)
              }),
              h('span', null, Boolean(shown(field)) ? '开启' : '关闭（默认）')
            )
          : field.type === 'select'
            ? h('select', {
                key: field.key + '-input',
                className: 'vet-input',
                value: selectValue(shown(field)),
                disabled: !writable || busy,
                onChange: (event) => edit(field, event.target.value)
              }, ...field.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
            : h('input', {
                key: field.key + '-input',
                className: 'vet-input',
                // password = 密码型控件（敏感项，如 API 密钥直填）：浏览器不回显明文
                type: field.type === 'number' ? 'number' : (field.type === 'password' ? 'password' : 'text'),
                value: shown(field),
                disabled: !writable || busy,
                placeholder: '（默认）',
                autoComplete: field.type === 'password' ? 'new-password' : undefined,
                onChange: (event) => edit(field, event.target.value)
              })
      ];

      return h('div', { className: 'vet-card' },
        h('style', null, STYLE),
        h('p', { className: 'vet-desc' },
          '这里的设置会写入 DSH profile 并立即生效；留空的项沿用插件配置文件与内置默认值。'),
        // 按分组渲染（组内字段顺序 = FIELDS 声明顺序）
        ...GROUPS.map((group) => h('section', { key: group.id, className: 'vet-group' },
          h('h4', { className: 'vet-group-title' }, group.title),
          h('div', { className: 'vet-grid' },
            ...FIELDS.filter((field) => field.group === group.id).flatMap(renderField)
          )
        )),
        h('div', { className: 'vet-actions' },
          h('button', { className: 'vet-btn primary', disabled: !writable || busy || !dirty, onClick: save }, busy ? '保存中…' : '保存'),
          h('button', { className: 'vet-btn', disabled: !writable || busy || !dirty, onClick: discard }, '放弃改动'),
          h('button', { className: 'vet-btn', disabled: !writable || busy, onClick: resetAll }, '全部恢复默认'),
          h('span', { className: 'vet-status' },
            !writable ? '（当前不可写入：' + diag + '）'
              : savedAt ? '已保存 ' + savedAt.toLocaleTimeString()
                : dirty ? '有未保存的改动' : ''
          )
        ),
        error ? h('div', { className: 'vet-error' }, error) : null,
        h('p', { className: 'vet-note' },
          '本页已覆盖插件全部可配置项（分六组）。仍可直接编辑配置文件 ',
          h('code', null, '~/.dsh/vision-exp-tile.json'),
          ' 或用环境变量设置（优先级：本页设置 > 配置文件 > 环境变量 > 内置默认）；',
          '设备画像（device_profile）由插件自动维护，为只读项，不在本页展示。')
      );
    }

    return {
      /** 需要的宿主客户端服务（只做激活顺序，不 require 任何宿主 UI 包）。 */
      inject: ['slots', 'configForms'],
      /**
       * 注册设置卡片到「插件」页。
       * @param {object} ctx - 浏览器侧插件上下文。
       */
      apply(ctx) {
        const form = ctx.configForms.get(ENTRY_ID);
        ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: ENTRY_ID,
          order: 30,
          label: () => '图像分块识别'
        }, (props) => h(SettingsCard, Object.assign({}, props, { form })))), 'vision-exp-tile: settings card');
      }
    };
  }
});
