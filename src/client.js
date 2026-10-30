/**
 * tools_manager — client half.
 *
 * Adds a "工具管理" row to the sidebar and a page that edits the host
 * switches through `GET/POST /api/tools_manager.settings` (Connection 准入): mode (聊天 / 常规) and one
 * switch per discovered tool — including tools contributed by other plugins.
 * Changing anything re-applies the prompt and the tool restriction to every
 * live session immediately.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tools-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const PANEL_ID = 'tools_manager'
    const ENDPOINT = '/api/tools_manager.settings'
    const EXPLAIN_ENDPOINT = '/api/tools_manager.explain'

    const C = {
      text: 'var(--dsw-alias-label-primary, #e8eaed)',
      muted: 'var(--dsw-alias-label-secondary, #a8adb8)',
      faint: 'var(--dsw-alias-label-tertiary, #7c828e)',
      border: 'var(--dsw-alias-border-l2, rgba(255,255,255,.12))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))',
      accent: 'var(--dsw-alias-state-business-primary, #4c8dff)',
      danger: 'var(--dsw-alias-state-error-primary, #ff6b6b)',
      ok: 'var(--dsw-alias-state-success-primary, #43c59e)',
      radius: 'var(--dsw-radius-lg, 12px)',
    }

    /** Refuse to render a payload the host does not own (for example the SPA fallback). */
    function readState(payload) {
      const state = payload && payload.state
      if (!state || !Array.isArray(state.tools)) throw new Error('返回数据格式不正确')
      return state
    }

    function PanelIcon({ size = 18, active }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.82 },
        },
        h('path', { d: 'M4 7h5M15 7h5M4 12h9M19 12h1M4 17h3M13 17h7' }),
        h('circle', { cx: 12, cy: 7, r: 2.1 }),
        h('circle', { cx: 16, cy: 12, r: 2.1 }),
        h('circle', { cx: 10, cy: 17, r: 2.1 }),
      )
    }

    function Switch({ checked, disabled, label, onChange }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          disabled,
          onClick: () => onChange(!checked),
          style: {
            flex: '0 0 auto',
            width: 40,
            height: 22,
            padding: 2,
            border: 'none',
            borderRadius: 11,
            cursor: disabled ? 'not-allowed' : 'pointer',
            background: checked ? C.accent : C.border,
            opacity: disabled ? 0.4 : 1,
            transition: 'background .15s ease',
            display: 'flex',
            alignItems: 'center',
            justifyContent: checked ? 'flex-end' : 'flex-start',
          },
        },
        h('span', {
          style: {
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: '#fff',
            display: 'block',
            boxShadow: '0 1px 2px rgba(0,0,0,.35)',
          },
        }),
      )
    }

    function Badge({ children }) {
      return h(
        'span',
        {
          style: {
            fontSize: 10.5,
            lineHeight: '16px',
            padding: '0 6px',
            borderRadius: 999,
            border: `1px solid ${C.border}`,
            color: C.faint,
            whiteSpace: 'nowrap',
          },
        },
        children,
      )
    }

    function Section({ title, hint, children }) {
      return h(
        'section',
        { style: { marginTop: 28 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 } },
          h('h2', { style: { margin: 0, fontSize: 14, fontWeight: 600, color: C.text } }, title),
          hint ? h('span', { style: { fontSize: 12, color: C.faint } }, hint) : null,
        ),
        children,
      )
    }

    function ModeCard({ active, title, description, onClick }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': active,
          onClick,
          style: {
            flex: '1 1 0',
            textAlign: 'left',
            padding: '14px 16px',
            borderRadius: C.radius,
            border: `1px solid ${active ? C.accent : C.border}`,
            background: active ? 'rgba(76,141,255,.12)' : 'transparent',
            color: C.text,
            cursor: 'pointer',
            transition: 'border-color .15s ease, background .15s ease',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h(
            'span',
            {
              style: {
                width: 14,
                height: 14,
                borderRadius: '50%',
                border: `2px solid ${active ? C.accent : C.border}`,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: '0 0 auto',
              },
            },
            active ? h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: C.accent } }) : null,
          ),
          h('span', { style: { fontSize: 14, fontWeight: 600 } }, title),
        ),
        h('div', { style: { marginTop: 8, fontSize: 12, lineHeight: 1.6, color: C.muted } }, description),
      )
    }

    function Page() {
      const [snapshot, setSnapshot] = useState({ status: 'loading', data: null, error: null, notice: null, busy: false })
      const [draft, setDraft] = useState('')
      const [query, setQuery] = useState('')
      // Which rows show their full description, and which show a Chinese one.
      const [expanded, setExpanded] = useState(() => new Set())
      const [explained, setExplained] = useState({})
      const [explaining, setExplaining] = useState(() => new Set())
      const [showingChinese, setShowingChinese] = useState(() => new Set())
      const [explainError, setExplainError] = useState('')

      const load = useCallback(async () => {
        try {
          const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload === null || payload.ok !== true) {
            throw new Error((payload && payload.error) || `HTTP ${response.status}`)
          }
          const state = readState(payload)
          setSnapshot({ status: 'ready', data: state, error: null, notice: null, busy: false })
          setDraft(state.prompt || '')
        } catch (error) {
          setSnapshot({ status: 'failed', data: null, error: error.message || String(error), notice: null, busy: false })
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const patch = useCallback(async (body) => {
        setSnapshot((previous) => ({ ...previous, busy: true, error: null, notice: null }))
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
            credentials: 'same-origin',
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload === null || payload.ok !== true) {
            throw new Error((payload && payload.error) || `HTTP ${response.status}`)
          }
          const state = readState(payload)
          setSnapshot({ status: 'ready', data: state, error: null, notice: '已保存', busy: false })
          setDraft(state.prompt || '')
        } catch (error) {
          setSnapshot((previous) => ({ ...previous, busy: false, error: error.message || String(error) }))
        }
      }, [])

      const toggleExpanded = useCallback((name) => {
        setExpanded((previous) => {
          const next = new Set(previous)
          if (next.has(name)) next.delete(name)
          else next.add(name)
          return next
        })
      }, [])

      const toggleExplanation = useCallback(async (tool) => {
        if (explained[tool.name] !== undefined) {
          setShowingChinese((previous) => {
            const next = new Set(previous)
            if (next.has(tool.name)) next.delete(tool.name)
            else next.add(tool.name)
            return next
          })
          return
        }
        setExplaining((previous) => new Set(previous).add(tool.name))
        try {
          const response = await fetch(EXPLAIN_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ name: tool.name, description: tool.description }),
            credentials: 'same-origin',
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload === null || payload.ok !== true) {
            throw new Error((payload && payload.error) || `HTTP ${response.status}`)
          }
          const text = typeof payload.text === 'string' ? payload.text.trim() : ''
          if (text === '') throw new Error('模型没有返回解释')
          setExplained((previous) => ({ ...previous, [tool.name]: text }))
          setShowingChinese((previous) => new Set(previous).add(tool.name))
          setExpanded((previous) => new Set(previous).add(tool.name))
          setExplainError('')
        } catch (error) {
          setExplainError(`解释失败：${error.message || String(error)}`)
        } finally {
          setExplaining((previous) => {
            const next = new Set(previous)
            next.delete(tool.name)
            return next
          })
        }
      }, [explained])

      if (snapshot.status === 'loading') {
        return h('div', { style: { padding: 32, color: C.faint, fontSize: 13 } }, '正在读取配置…')
      }
      if (snapshot.status === 'failed') {
        return h(
          'div',
          { style: { padding: 32, color: C.danger, fontSize: 13, lineHeight: 1.7 } },
          h('div', null, '读取配置失败：', snapshot.error),
          h(
            'button',
            {
              type: 'button',
              onClick: load,
              style: { marginTop: 12, padding: '6px 14px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', color: C.text, cursor: 'pointer' },
            },
            '重试',
          ),
        )
      }

      const data = snapshot.data
      const chatMode = data.mode === 'chat'
      const enabledCount = data.tools.filter((tool) => tool.enabled && !tool.locked).length
      const needle = query.trim().toLowerCase()
      const visibleTools = needle === ''
        ? data.tools
        : data.tools.filter((tool) =>
            `${tool.name} ${tool.label} ${tool.description} ${explained[tool.name] ?? ''}`.toLowerCase().includes(needle),
          )

      return h(
        'div',
        { style: { height: '100%', overflowY: 'auto', color: C.text } },
        h(
          'div',
          { style: { maxWidth: 760, margin: '0 auto', padding: '36px 28px 72px' } },
          h('h1', { style: { margin: 0, fontSize: 20, fontWeight: 600 } }, '工具管理'),
          h(
            'p',
            { style: { margin: '8px 0 0', fontSize: 12.5, lineHeight: 1.7, color: C.muted } },
            '关掉的工具，连声明都不带进上下文。模式和提示词是附带的轻量配置，改完立即对当前所有会话生效。',
          ),

          h(
            Section,
            {
              title: '工具',
              hint: `已开启 ${enabledCount} / 共 ${data.tools.length} 个，关闭的不进入上下文`,
            },
            h(
              'div',
              { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 } },
              h('input', {
                value: query,
                onChange: (event) => setQuery(event.target.value),
                placeholder: '搜索工具名或说明…',
                'aria-label': '搜索工具',
                style: {
                  flex: '1 1 auto',
                  padding: '7px 12px',
                  borderRadius: 8,
                  border: `1px solid ${C.border}`,
                  background: 'transparent',
                  color: C.text,
                  fontSize: 12.5,
                  outline: 'none',
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  disabled: snapshot.busy,
                  onClick: load,
                  title: '重新扫描工具列表（会拾取刚安装的插件）',
                  style: {
                    padding: '7px 12px',
                    borderRadius: 8,
                    border: `1px solid ${C.border}`,
                    background: 'transparent',
                    color: C.text,
                    fontSize: 12.5,
                    cursor: snapshot.busy ? 'not-allowed' : 'pointer',
                    opacity: snapshot.busy ? 0.5 : 1,
                  },
                },
                '重新扫描',
              ),
            ),
            data.tools.length === 0
              ? h(
                  'p',
                  { style: { fontSize: 12.5, color: C.muted } },
                  '还没有发现工具。先打开任意一个会话，再点「重新扫描」。',
                )
              : h(
                  'div',
                  { style: { border: `1px solid ${C.border}`, borderRadius: C.radius, overflow: 'hidden' } },
                  visibleTools.map((tool, index) => {
                    const isExpanded = expanded.has(tool.name)
                    const chinese = explained[tool.name]
                    const useChinese = chinese !== undefined && showingChinese.has(tool.name)
                    const isExplaining = explaining.has(tool.name)
                    const descriptionStyle = isExpanded
                      ? { fontSize: 12, color: C.muted, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
                      : {
                          fontSize: 12,
                          color: C.muted,
                          lineHeight: 1.7,
                          wordBreak: 'break-word',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }
                    return h(
                      'div',
                      {
                        key: tool.name,
                        // Clicking the row unfolds the full description; the
                        // controls inside it keep their own click behaviour.
                        onClick: (event) => {
                          const target = event && event.target
                          if (target && typeof target.closest === 'function' && target.closest('button, input, a, select, textarea')) return
                          toggleExpanded(tool.name)
                        },
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: 14,
                          padding: '12px 16px',
                          borderTop: index === 0 ? 'none' : `1px solid ${C.border}`,
                          cursor: 'pointer',
                        },
                      },
                      h(
                        'div',
                        { style: { flex: '1 1 auto', minWidth: 0 } },
                        h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                          h('span', { style: { fontSize: 13.5, fontWeight: 500 } }, tool.label),
                          h('code', { style: { fontSize: 11, color: C.faint } }, tool.name),
                          tool.core ? null : h(Badge, null, '其他插件'),
                          tool.locked ? h(Badge, null, '不可关闭') : null,
                          tool.mounted ? null : h(Badge, null, '本机未安装'),
                          h(
                            'button',
                            {
                              type: 'button',
                              'aria-pressed': useChinese,
                              title: '让模型用中文解释这个工具',
                              onClick: (event) => {
                                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                                if (!isExplaining) toggleExplanation(tool)
                              },
                              style: {
                                marginLeft: 2,
                                padding: '2px 9px',
                                fontSize: 11,
                                lineHeight: 1.6,
                                borderRadius: 999,
                                border: `1px solid ${C.border}`,
                                background: 'transparent',
                                color: useChinese ? C.accent : C.muted,
                                cursor: isExplaining ? 'progress' : 'pointer',
                                opacity: isExplaining ? 0.7 : 1,
                              },
                            },
                            isExplaining ? '解释中…' : chinese === undefined ? '解释' : useChinese ? '原文' : '中文',
                          ),
                        ),
                        h('div', { style: { marginTop: 4, ...descriptionStyle } }, useChinese ? chinese : tool.description),
                        h(
                          'div',
                          { style: { marginTop: 4, fontSize: 11, color: C.faint, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                          h('span', null, isExpanded ? '收起说明' : '展开说明'),
                          useChinese ? h('span', null, '· 已换成中文解释') : null,
                        ),
                        tool.note
                          ? h(
                              'div',
                              { style: { marginTop: 3, fontSize: 11.5, color: C.faint, lineHeight: 1.6, wordBreak: 'break-word' } },
                              tool.note,
                            )
                          : null,
                      ),
                      h(Switch, {
                        checked: tool.enabled,
                        disabled:
                          snapshot.busy ||
                          tool.locked ||
                          !tool.mounted ||
                          (tool.enabled && enabledCount <= 1),
                        label: tool.label,
                        onChange: (next) => patch({ tools: { [tool.name]: next } }),
                      }),
                    )
                  },
                  ),
                ),
            h(
              'p',
              { style: { margin: '8px 0 0', fontSize: 11.5, color: C.faint, lineHeight: 1.7 } },
              '至少要保留一个可关闭的工具。关闭后该工具的 schema 和提示词内容都不再发送给模型；「不可关闭」的多为会话内置工具。',
            ),
          ),

          h(
            Section,
            { title: '模式', hint: snapshot.busy ? '保存中…' : null },
            h(
              'div',
              { role: 'radiogroup', 'aria-label': '模式', style: { display: 'flex', gap: 12 } },
              h(ModeCard, {
                active: chatMode,
                title: '聊天模式',
                description: '精简提示词；只保留上面打开的「默认工具」，其他工具默认关闭；网络查询每次都要你批准。',
                onClick: () => {
                  if (!snapshot.busy && !chatMode) patch({ mode: 'chat' })
                },
              }),
              h(ModeCard, {
                active: !chatMode,
                title: '常规模式',
                description: '保留 DSH 默认提示词与全部原始行为，不弹网络授权；没单独改过的工具默认全部开启。',
                onClick: () => {
                  if (!snapshot.busy && chatMode) patch({ mode: 'normal' })
                },
              }),
            ),
          ),

          h(
            Section,
            { title: '系统提示词', hint: chatMode ? '留空则按当前工具自动生成' : '常规模式下不生效' },
            h('textarea', {
              value: draft,
              spellCheck: false,
              onChange: (event) => setDraft(event.target.value),
              placeholder: '留空则按当前工具自动生成默认提示词',
              style: {
                width: '100%',
                minHeight: 200,
                boxSizing: 'border-box',
                padding: '12px 14px',
                borderRadius: C.radius,
                border: `1px solid ${C.border}`,
                background: 'transparent',
                color: C.text,
                fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
                fontSize: 12.5,
                lineHeight: 1.7,
                resize: 'vertical',
                opacity: chatMode ? 1 : 0.55,
              },
            }),
            h(
              'div',
              { style: { display: 'flex', gap: 8, marginTop: 10 } },
              h(
                'button',
                {
                  type: 'button',
                  disabled: snapshot.busy || !chatMode,
                  onClick: () => patch({ prompt: draft }),
                  style: {
                    padding: '7px 16px',
                    borderRadius: 8,
                    border: 'none',
                    background: C.accent,
                    color: '#fff',
                    fontSize: 12.5,
                    cursor: snapshot.busy || !chatMode ? 'not-allowed' : 'pointer',
                    opacity: snapshot.busy || !chatMode ? 0.5 : 1,
                  },
                },
                '保存提示词',
              ),
              h(
                'button',
                {
                  type: 'button',
                  disabled: snapshot.busy || !chatMode || draft === '',
                  onClick: () => patch({ prompt: '' }),
                  style: {
                    padding: '7px 16px',
                    borderRadius: 8,
                    border: `1px solid ${C.border}`,
                    background: 'transparent',
                    color: C.text,
                    fontSize: 12.5,
                    cursor: snapshot.busy || !chatMode ? 'not-allowed' : 'pointer',
                    opacity: snapshot.busy || !chatMode || draft === '' ? 0.5 : 1,
                  },
                },
                '恢复默认',
              ),
            ),
          ),

          h(
            'div',
            { style: { marginTop: 24, minHeight: 20, fontSize: 12, lineHeight: 1.6 } },
            snapshot.error ? h('span', { style: { color: C.danger } }, '保存失败：', snapshot.error) : null,
            !snapshot.error && explainError !== ''
              ? h('span', { style: { color: C.danger } }, explainError)
              : null,
            !snapshot.error && snapshot.notice ? h('span', { style: { color: C.ok } }, snapshot.notice) : null,
            !snapshot.error && !snapshot.notice && explainError === ''
              ? h('span', { style: { color: C.faint } }, `状态文件：${data.stateFile}`)
              : null,
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, Page),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: '工具管理' },
            PanelIcon,
          ),
        )
      },
    }
  },
})
