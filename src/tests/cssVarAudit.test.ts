/**
 * CSS custom-property audit
 *
 * Scans every `var(--name)` reference in:
 *   - src/**\/*.tsx
 *   - src/**\/*.ts
 *   - index.html
 *
 * and asserts that every referenced `--name` is defined as a property in
 * src/index.css (i.e. appears as `--name:` in the file).
 *
 * Inline style objects in .tsx/.ts files use the string form `'var(--name)'`
 * or `"var(--name)"`, which is exactly what is scanned.
 *
 * This test is designed to catch the class of bug where a CSS variable is
 * referenced in source but never defined — making the element invisible or
 * incorrectly styled (e.g. a button with `background: var(--cta)` where
 * `--cta` is not defined, rendering the button transparent).
 *
 * Regression check: `--cta` and `--surface-raised` are confirmed absent from
 * src/index.css, so the old code would have failed this test.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const SRC  = resolve(ROOT, 'src')

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively collect all files under `dir` matching `ext`. */
function collectFiles(dir: string, ext: RegExp): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, ext))
    } else if (ext.test(entry)) {
      results.push(full)
    }
  }
  return results
}

/** Extract every `--name` from `var(--name)` occurrences in `text`. */
function extractVarNames(text: string): Set<string> {
  const names = new Set<string>()
  // Match var(--name) with optional whitespace and optional fallback
  for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
    names.add(m[1])
  }
  return names
}

/** Extract every CSS custom property definition `--name:` from `text`. */
function extractDefinedProps(text: string): Set<string> {
  const names = new Set<string>()
  for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) {
    names.add(m[1])
  }
  return names
}

// ── Load files ────────────────────────────────────────────────────────────────

const cssPath     = resolve(SRC, 'index.css')
const cssText     = readFileSync(cssPath, 'utf8')
const definedVars = extractDefinedProps(cssText)

const sourceFiles: string[] = [
  // Exclude test files — their string literals (including test descriptions
  // that mention token names) are not CSS var references in the browser.
  ...collectFiles(SRC, /\.(tsx|ts)$/).filter((f) => !f.includes('/tests/')),
  resolve(ROOT, 'index.html'),
]

// Collect every var(--name) reference across all source files,
// keyed by var name → list of files that reference it.
const refsByVar = new Map<string, string[]>()
for (const file of sourceFiles) {
  const text = readFileSync(file, 'utf8')
  for (const name of extractVarNames(text)) {
    const rel = file.replace(ROOT + '/', '')
    const arr = refsByVar.get(name) ?? []
    arr.push(rel)
    refsByVar.set(name, arr)
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CSS custom-property audit', () => {
  it('CSS1: all var(--name) references resolve to a definition in src/index.css', () => {
    const undefined_vars: string[] = []
    for (const [name, files] of refsByVar) {
      if (!definedVars.has(name)) {
        undefined_vars.push(`${name}  (used in: ${[...new Set(files)].join(', ')})`)
      }
    }

    if (undefined_vars.length > 0) {
      throw new Error(
        `Found ${undefined_vars.length} undefined CSS custom propert${undefined_vars.length === 1 ? 'y' : 'ies'}:\n` +
        undefined_vars.map((s) => `  ${s}`).join('\n') +
        '\n\nAdd these to src/index.css or replace with a defined token.',
      )
    }

    expect(undefined_vars).toHaveLength(0)
  })

  it('CSS2: src/index.css defines at least the core layout tokens', () => {
    // Smoke-check that the parser is reading the real file correctly.
    const required = ['--bg', '--surface', '--accent', '--accent-fg', '--ink', '--muted', '--border']
    const missing = required.filter((v) => !definedVars.has(v))
    expect(missing).toHaveLength(0)
  })

  it('CSS3: --cta is not defined in src/index.css (regression: was used but never defined)', () => {
    // This confirms the audit would have caught the original bug.
    expect(definedVars.has('--cta')).toBe(false)
  })

  it('CSS4: --surface-raised is not defined in src/index.css (regression: was used but never defined)', () => {
    // This confirms the audit would have caught the original bug.
    expect(definedVars.has('--surface-raised')).toBe(false)
  })

  it('CSS5: --cta is not referenced anywhere in source after the fix', () => {
    const refs = refsByVar.get('--cta') ?? []
    expect(refs).toHaveLength(0)
  })

  it('CSS6: --surface-raised is not referenced anywhere in source after the fix', () => {
    const refs = refsByVar.get('--surface-raised') ?? []
    expect(refs).toHaveLength(0)
  })

  it('CSS7: accent button tokens are referenced (smoke-check for AdminView fix)', () => {
    expect(refsByVar.has('--accent')).toBe(true)
    expect(refsByVar.has('--accent-fg')).toBe(true)
  })
})
