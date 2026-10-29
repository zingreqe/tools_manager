/**
 * Wiring test for the client half.
 *
 * Loads `client.js` the way the browser module loader does — through
 * `window.__ModuleLoader__.load` — then runs its factory and `apply` against
 * fake React and slot services. This catches a broken module id, a missing
 * export, or a slot registration with the wrong shape before a restart.
 *
 * Run with: node test/client.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
}

await import('../client.js')

assert.ok(loaded, 'client.js must register itself with the module loader')
assert.equal(loaded.id, 'tools_manager', 'module id must equal the package name')
assert.equal(typeof loaded.factory, 'function')

const module = loaded.factory((name) => {
  assert.equal(name, 'react', `unexpected runtime import: ${name}`)
  return react
})

assert.deepEqual(module.inject, ['slots'])

const injections = []
const registrations = []
const disposers = []
const ctx = {
  slots: {
    inject(name, factory) {
      injections.push(name)
      disposers.push(factory())
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

module.apply(ctx)

assert.deepEqual(injections.sort(), ['main', 'sidebar.panellist'])

const panel = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
assert.ok(panel, 'must register a sidebar panel entry')
assert.equal(panel.options.id, 'tools_manager')
assert.equal(panel.options.label, '工具管理')
assert.equal(typeof panel.component, 'function')

const main = registrations.find((entry) => entry.options.name === 'main')
assert.ok(main, 'must register the main page for the same id')
assert.equal(main.options.key, 'tools_manager', 'the panel id must address the main key')
assert.equal(typeof main.component, 'function')

// The icon is a plain component: calling it must produce an element.
const icon = panel.component({ size: 18, active: false })
assert.equal(icon.type, 'svg')
assert.ok(icon.children.length >= 2, 'icon must draw both rails and knobs')

console.log('ok  client module wiring: sidebar entry + main page')

// Static sanity check of the page source: no hooks inside conditionals.
const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'))
const pageStart = source.indexOf('function Page()')
const pageEnd = source.indexOf('return {\n      inject:', pageStart)
const page = source.slice(pageStart, pageEnd)
const hookCalls = page.match(/use(State|Effect|Callback|Memo|Ref)\(/g) ?? []
assert.ok(hookCalls.length >= 4, 'the page should use hooks')
const guardIndex = page.indexOf("if (snapshot.status === 'loading')")
for (const match of page.matchAll(/use(State|Effect|Callback|Memo|Ref)\(/g)) {
  assert.ok(match.index < guardIndex, 'hooks must run before the early returns')
}
console.log('ok  page hooks run unconditionally')

// Row expansion and the explain toggle are pure page wiring: assert the module
// still points at the explain route and renders the two-state button.
const wired = await readFile(new URL('../client.js', import.meta.url), 'utf8')
assert.match(wired, /const EXPLAIN_ENDPOINT = '\/tools_manager\/explain'/, 'the page posts to the explain route')
assert.match(wired, /'解释中…'/, 'the button shows a busy state')
assert.match(wired, /'原文'/, 'the button can restore the original text')
assert.match(wired, /WebkitLineClamp/, 'collapsed descriptions are line-clamped')
assert.match(wired, /closest\('button, input, a, select, textarea'\)/, 'row clicks ignore the controls inside')
console.log('ok  row expansion + explain toggle wired')
