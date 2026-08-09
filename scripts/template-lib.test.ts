import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isExcludedSource,
  lintTemplateGitignore,
  lintTemplatePackageJson,
  lintTemplateReadme,
  lintTemplateWrangler,
  relativeSpecifier,
  rewriteHedgeImports,
  TARGET_COMPATIBILITY_DATE,
  TEMPLATE_NAME,
  TEMPLATE_PRETTIER_VERSION,
  templateDevVarsExample,
  templateGitignore,
  templatePackageJson,
  templateScripts,
  templateWranglerConfig,
  type WranglerConfig,
} from './template-lib'

const ROOT = join(import.meta.dir, '..')

const bindings = { AUTH_SECRET: { description: 'a secret' } }
const pkg = templatePackageJson({
  bindings,
  dependencies: { hono: '4.12.32' },
  devDependencies: { wrangler: '4.114.0' },
})

describe('import rewriting', () => {
  test('rewrites @hedge/core to a relative path from the importing directory', () => {
    expect(rewriteHedgeImports(`import { x } from '@hedge/core'`, 'src')).toBe(
      `import { x } from '../vendor/core/index'`,
    )
    expect(rewriteHedgeImports(`import { x } from '@hedge/core'`, 'src/lib')).toBe(
      `import { x } from '../../vendor/core/index'`,
    )
    expect(rewriteHedgeImports(`import { x } from '@hedge/deploy'`, 'admin/src/pages')).toBe(
      `import { x } from '../../../vendor/deploy/index'`,
    )
  })

  test('rewrites a sibling vendor package without a leading ../', () => {
    // `vendor/deploy` imports `@hedge/core`; the two are siblings, so the specifier has to be
    // explicitly relative or a bundler reads it as a bare package name.
    expect(rewriteHedgeImports(`export * from '@hedge/core'`, 'vendor/deploy')).toBe(
      `export * from '../core/index'`,
    )
  })

  test('leaves prose alone and handles double quotes', () => {
    expect(rewriteHedgeImports('// see `@hedge/core` for why', 'src')).toBe(
      '// see `@hedge/core` for why',
    )
    expect(rewriteHedgeImports(`import x from "@hedge/core"`, 'src')).toBe(
      `import x from "../vendor/core/index"`,
    )
  })

  test('throws rather than emitting an unresolvable specifier', () => {
    expect(() => rewriteHedgeImports(`from '@hedge/installer'`, 'src')).toThrow()
  })

  test('relativeSpecifier always produces an explicitly relative path', () => {
    expect(relativeSpecifier('', 'vendor/core/index')).toBe('./vendor/core/index')
    expect(relativeSpecifier('.', 'vendor/core/index')).toBe('./vendor/core/index')
  })
})

describe('what does not ship', () => {
  test('test files are excluded', () => {
    expect(isExcludedSource('src/lib/mcp.test.ts')).toBe(true)
    expect(isExcludedSource('src/lib/entry-query.integration.test.ts')).toBe(true)
    expect(isExcludedSource('admin/src/lib/api.test.ts')).toBe(true)
    expect(isExcludedSource('vendor/core/fields.test.ts')).toBe(true)
  })

  test('real source is not', () => {
    expect(isExcludedSource('src/lib/mcp.ts')).toBe(false)
    expect(isExcludedSource('admin/src/pages/entries.tsx')).toBe(false)
    expect(isExcludedSource('src/db/schema.ts')).toBe(false)
  })
})

describe('package.json conformance', () => {
  test('passes their linter', () => {
    expect(lintTemplatePackageJson(pkg)).toEqual([])
  })

  test('carries no Bun or workspace residue', () => {
    const json = JSON.stringify(pkg)
    expect(json).not.toContain('@hedge/')
    expect(json).not.toContain('workspace:')
    expect(json).not.toContain('@types/bun')
    expect(json).not.toContain('packageManager')
    expect((pkg.engines as Record<string, string>).bun).toBeUndefined()
  })

  test('leaves the preview URLs and publish flag to Cloudflare', () => {
    const cloudflare = pkg.cloudflare as Record<string, unknown>
    expect(cloudflare.preview_image_url).toBeUndefined()
    expect(cloudflare.preview_icon_url).toBeUndefined()
    expect(cloudflare.publish).toBeUndefined()
  })

  test('carries the binding descriptions over, with WORKER_NAME corrected for the rename', () => {
    const carried = (pkg.cloudflare as { bindings: Record<string, { description: string }> })
      .bindings
    expect(carried.AUTH_SECRET?.description).toBe('a secret')
    // The repository's own text says a button deployment is always `hedge-cms`, which stops being
    // true the moment their linter forces the template's name.
    expect(carried.WORKER_NAME?.description).toContain(TEMPLATE_NAME)
    expect(carried.WORKER_NAME?.description).not.toContain('Leave empty')
  })

  test('rejects a categories key that is absent, which is the easiest one to get wrong', () => {
    const { categories, ...cloudflare } = pkg.cloudflare as Record<string, unknown>
    expect(lintTemplatePackageJson({ ...pkg, cloudflare })).toContain(
      '"cloudflare.categories" must be an array',
    )
  })

  test('names the health check path their harness polls', () => {
    expect((pkg.cloudflare as Record<string, unknown>).healthCheckPath).toBe('/api/health')
  })
})

describe('the dev script their harness starts', () => {
  const scripts = templateScripts()

  test('binds the port their framework heuristic picks', () => {
    // `vite` is in the dependency set because the admin build needs it, so the harness polls 5173
    // whatever the script binds — see `playwright-tests/utils/template-server.ts`.
    expect(scripts.dev).toContain('--port 5173')
  })

  test('migrates and builds before serving, and does the two in parallel', () => {
    expect(scripts.dev).toContain('db:migrate')
    expect(scripts.dev).toContain('npm run build')
    // Sequential, the three steps reach readiness at ~30.3s against a 30s budget. Parallel, ~19s.
    expect(scripts.dev).toContain('& npm run build && wait')
  })

  test('is a single command — the harness starts exactly one', () => {
    expect(scripts.dev).not.toContain('concurrently')
    expect(scripts.deploy).toBeTruthy()
  })

  test('typechecks both projects, with the admin config inside admin/', () => {
    // A root-only tsconfig makes Vite compile the admin's JSX with `hono/jsx`, which builds cleanly
    // and then throws at run time. The path here is what stops that from coming back.
    expect(scripts.check).toContain('tsc -p admin/tsconfig.json')
  })
})

describe('wrangler.jsonc conformance', () => {
  const root = JSON.parse(
    readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n'),
  ) as WranglerConfig
  const config = templateWranglerConfig(root)

  test('passes their linter', () => {
    expect(lintTemplateWrangler(config, TEMPLATE_NAME)).toEqual([])
  })

  test('pins their compatibility date rather than ours', () => {
    expect(config.compatibility_date).toBe(TARGET_COMPATIBILITY_DATE)
    expect(config.compatibility_date).not.toBe(root.compatibility_date)
  })

  test('rewrites the monorepo paths', () => {
    expect(config.main).toBe('src/index.ts')
    expect(config.assets?.directory).toBe('admin/dist')
    expect(config.d1_databases?.[0]?.migrations_dir).toBe('migrations')
  })

  test('keeps every binding the root config declares', () => {
    expect(config.d1_databases).toHaveLength(1)
    expect(config.r2_buckets).toHaveLength(1)
    expect(config.send_email).toHaveLength(1)
    expect(config.assets?.binding).toBe('ASSETS')
    expect(config.compatibility_flags).toEqual(root.compatibility_flags ?? [])
  })

  test('sets WORKER_NAME, because the updater has to address the renamed script', () => {
    expect(config.vars?.WORKER_NAME).toBe(TEMPLATE_NAME)
    expect(config.vars?.INSTALLED_BY).toBe('button')
  })

  test('carries no account-specific ids, which is what lets anyone deploy it', () => {
    expect(JSON.stringify(config)).not.toContain('database_id')
    expect(config.vars?.PUBLIC_URL).toBe('')
  })
})

describe('the files their linter checks for existence', () => {
  test('.gitignore matches both patterns they require', () => {
    expect(lintTemplateGitignore(templateGitignore())).toEqual([])
  })

  test('.dev.vars.example carries a usable secret, because the harness copies it verbatim', () => {
    const example = templateDevVarsExample()
    expect(example).toMatch(/^AUTH_SECRET=.+$/m)
    // An empty value would 500 every authenticated route and read as a bug in Hedge.
    expect(example).not.toMatch(/^AUTH_SECRET=\s*$/m)
    expect(example).toContain('openssl rand -base64 32')
  })

  test('the template README has exactly one dash-content block, in order', () => {
    const readme = readFileSync(join(ROOT, 'templates', 'README.template.md'), 'utf8')
    expect(lintTemplateReadme(readme)).toEqual([])
  })

  test('the README block holds no shell commands, which CONTRIBUTING excludes', () => {
    const readme = readFileSync(join(ROOT, 'templates', 'README.template.md'), 'utf8')
    const block = readme
      .split('<!-- dash-content-start -->')[1]
      ?.split('<!-- dash-content-end -->')[0]
    expect(block).toBeTruthy()
    expect(block).not.toContain('```')
    expect(block).not.toContain('npm run')
  })

  test('the README marker linter catches a missing close', () => {
    expect(lintTemplateReadme('<!-- dash-content-start -->\nfeatures\n')).toEqual([
      'Missing closing <!-- dash-content-end -->',
    ])
  })

  test('the Playwright spec is named after the template directory', () => {
    // `fixtures.ts` derives the template name from the filename; any other name cannot find it.
    const spec = readFileSync(join(ROOT, 'templates', `${TEMPLATE_NAME}.spec.ts`), 'utf8')
    expect(spec).toContain('./fixtures')
  })

  test('every navigation in the spec goes through templateUrl', () => {
    // Their `playwright.config.ts` sets no `baseURL`, so a bare path throws "Cannot navigate to
    // invalid URL" — and `templateUrl` is also the fixture that starts the server. Found by
    // running their harness (#52), which is the only thing that would have.
    const spec = readFileSync(join(ROOT, 'templates', `${TEMPLATE_NAME}.spec.ts`), 'utf8')
    // Comments stripped first: the file explains the rule by quoting the call that breaks it.
    const code = spec.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const gotos = [...code.matchAll(/page\.goto\((.+?)\)/g)]
    expect(gotos.length).toBeGreaterThan(0)
    for (const [, target] of gotos) expect(target).toContain('templateUrl')
  })
})

describe('the versions that belong to their repository, not ours', () => {
  test('prettier is pinned to an exact version', () => {
    // A range or a bare `bunx prettier` resolves the newest release, and Prettier's output moves
    // between minors: 3.9.6 formatted the directory clean here while their pinned 3.7.4 failed it.
    expect(TEMPLATE_PRETTIER_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('the compatibility date is an exact date, not a range', () => {
    expect(TARGET_COMPATIBILITY_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
