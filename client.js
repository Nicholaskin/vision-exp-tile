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
     * 字段表：与 src/plugin-config.js 的 Config（volatile 字段）一一对应。
     * type 决定控件：text / number / boolean / select。
     */
    const FIELDS = [
      { key: 'base_url', type: 'text', label: '视觉 API 地址', hint: '留空 = 使用内置默认（https://api.deepseek.com）' },
      { key: 'api_key_env', type: 'text', label: '密钥环境变量名', hint: '默认 DEEPSEEK_API_KEY；留空 = 用默认' },
      { key: 'model', type: 'text', label: '视觉模型', hint: '留空 = 使用内置默认模型' },
      { key: 'max_tokens', type: 'number', label: '输出 token 上限', hint: '单次识别返回的最大 token 数' },
      { key: 'block_size', type: 'number', label: '切块边长（像素）', hint: '官方缩放甜蜜点为 800' },
      { key: 'cut_threshold', type: 'number', label: '切块阈值（长边）', hint: '长边超过此值才切块' },
      { key: 'overlap', type: 'number', label: '相邻块交叠（像素）', hint: '推荐 64，防止跨块切断内容' },
      {
        key: 'format', type: 'select', label: '块格式',
        options: [{ value: '', label: '（默认 png）' }, { value: 'png', label: 'png（无损）' }, { value: 'jpeg', label: 'jpeg（省体积）' }],
        hint: '仅 full 模式切块时有效'
      },
      { key: 'quality', type: 'number', label: 'jpeg 质量', hint: '40..100，仅 format=jpeg 有效' },
      { key: 'with_overview', type: 'boolean', label: '输出布局参考图（overview）', hint: '在切块结果旁生成网格编号总览图' },
      {
        key: 'ocr_engine', type: 'select', label: '本地 OCR 引擎',
        options: [
          { value: '', label: '（默认 auto）' },
          { value: 'auto', label: 'auto（优先 rapid，自动降级）' },
          { value: 'rapid', label: 'rapid（RapidOCR）' },
          { value: 'paddle', label: 'paddle（PaddleOCR）' },
          { value: 'windows', label: 'windows（系统 OCR）' }
        ],
        hint: 'pipeline 模式的文字识别引擎'
      },
      { key: 'out_dir', type: 'text', label: '输出目录', hint: '留空 = 源图同目录；相对路径基于源图目录' }
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
      .vet-note { font-size: 12px; opacity: .6; margin-top: 12px; line-height: 1.6; }
    `;

    /** 把输入框里的字符串按字段类型转成要提交的值；空串表示「未设置」（回落默认）。 */
    function parseValue(field, raw) {
      const text = String(raw ?? '');
      if (text.trim() === '') return undefined;
      if (field.type === 'number') {
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

      return h('div', { className: 'vet-card' },
        h('style', null, STYLE),
        h('p', { className: 'vet-desc' },
          '这里的设置会写入 DSH profile 并立即生效；留空的项沿用插件配置文件与内置默认值。'),
        h('div', { className: 'vet-grid' },
          ...FIELDS.flatMap((field) => [
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
                  }, ...field.options.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label)))
                : h('input', {
                    key: field.key + '-input',
                    className: 'vet-input',
                    type: field.type === 'number' ? 'number' : 'text',
                    value: shown(field),
                    disabled: !writable || busy,
                    placeholder: '（默认）',
                    onChange: (event) => edit(field, event.target.value)
                  })
          ])
        ),
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
          '其余高级项（并发、预处理、设备档位、OCR 池等）仍可通过配置文件 ',
          h('code', null, '~/.dsh/vision-exp-tile.json'),
          ' 或环境变量设置；后续版本会把它们逐步搬到这里。')
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
