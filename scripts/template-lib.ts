import { relative } from 'node:path'

/**
 * The pure pieces of the `cloudflare/templates` submission build (#48), split out from the CLI the
 * same way `artifact-lib.ts` is — so the transforms can be tested without a filesystem, and so the
 * rules that belong to *someone else's* CI are written down in one place rather than scattered
 * through a script.
 *
 * `cloudflare/templates` is a pnpm workspace of single-package directories: one `package.json` npm
 * can install, one `wrangler.jsonc`, one `dev` script their Playwright harness starts with
 * `npm run dev`. Hedge is a Bun workspaces monorepo with five packages and `workspace:*`
 * dependencies. So the submission is a *generated* flattened copy, never a second hand-maintained
 * one — a template in Cloudflare's repo that drifts three releases behind is worse than no template.
 */

/**
 * The template's name, which their linter forces to be the same string in three places: the
 * directory, `package.json` `name`, and `wrangler.jsonc` `name`. Everything downstream — the
 * Playwright spec filename, the live-demo hostname, `WORKER_NAME` — is derived from it.
 */
export const TEMPLATE_NAME = 'hedge-cms-template'

/**
 * `TARGET_COMPATIBILITY_DATE` from their `cli/src/lint.ts`. **This value moves**, and a template
 * whose date doesn't equal theirs is a hard CI failure, so re-read it at submission time rather
 * than trusting this constant:
 *
 *     curl -s https://raw.githubusercontent.com/cloudflare/templates/main/cli/src/lint.ts \
 *       | grep TARGET_COMPATIBILITY_DATE
 *
 * It is a *downgrade* from the date Hedge itself pins. Nothing in the Worker depends on a runtime
 * behaviour newer than this one — `nodejs_compat` (the only flag) predates it by two years — but
 * that has to be re-checked whenever the repo's own date moves forward for a reason.
 */
export const TARGET_COMPATIBILITY_DATE = '2025-10-08'

/**
 * The Prettier version `cloudflare/templates` pins, read from their root `package.json`. **The
 * generator has to format with exactly this one**, and the reason is a failure mode with no
 * symptom locally: `prettier . --check` at their root is run by the version in *their* lockfile,
 * and Prettier's output is not stable across minor versions. 3.9.6 leaves
 *
 *     const payload = (await response.json().catch(() => null)) as
 *       (T & { message?: string; code?: string }) | null
 *
 * alone; 3.7.4 breaks that union onto leading-pipe lines. So an unpinned `bunx prettier` formatted
 * the directory, reported it clean, and their `check:prettier` still failed on one file — which is
 * how this was found (#52), in their checkout rather than here.
 *
 * Re-read it alongside the compatibility date at submission time:
 *
 *     curl -s https://raw.githubusercontent.com/cloudflare/templates/main/package.json \
 *       | grep '"prettier"'
 */
export const TEMPLATE_PRETTIER_VERSION = '3.7.4'

/** The two markers their README linter looks for, exactly once each and in this order. */
export const DASH_CONTENT_START_MARKER = '<!-- dash-content-start -->'
export const DASH_CONTENT_END_MARKER = '<!-- dash-content-end -->'

/** The categories their linter accepts. Anything else is rejected; an absent key is also a failure. */
export const TEMPLATE_CATEGORIES = ['storage'] as const

/**
 * Products shown on the gallery card, three maximum. `Workers` is dropped rather than one of the
 * others: CONTRIBUTING says to skip the ubiquitous ones, and every template in the repository is a
 * Worker. The vocabulary is theirs — check these strings against neighbouring templates before
 * submitting, since nothing validates them.
 */
export const TEMPLATE_PRODUCTS = ['D1', 'R2', 'Email'] as const

/** Where the flattened copies of `packages/core` and `packages/deploy` land in the template. */
export const VENDOR_DIR = 'vendor'

/**
 * The workspace specifiers that cannot survive the flattening, and where each one goes.
 *
 * They are rewritten to **relative paths in the source**, not mapped with a tsconfig `paths` entry
 * or a `file:` dependency. A relative import is resolved identically by tsc, esbuild (wrangler) and
 * rollup (vite) with no configuration to get wrong, and their acceptance rule is explicit that no
 * `@hedge/*` may appear in the generated `package.json`.
 */
export const VENDORED_PACKAGES: Record<string, string> = {
  '@hedge/core': `${VENDOR_DIR}/core/index`,
  '@hedge/deploy': `${VENDOR_DIR}/deploy/index`,
}

/**
 * Rewrite `@hedge/*` imports in one file to relative specifiers.
 *
 * `fileDir` and the vendor targets are both template-relative POSIX paths. The result keeps the
 * extension off: `moduleResolution: bundler`, esbuild and vite all resolve `../vendor/core/index`
 * to the `.ts` file, and an explicit `.ts` extension would need `allowImportingTsExtensions`.
 */
export function rewriteHedgeImports(source: string, fileDir: string): string {
  return source.replace(
    // `from '@hedge/core'` and `import('@hedge/deploy')`, single or double quoted. Hedge imports
    // these packages bare — there are no subpath entry points — so an exact match is enough.
    /(['"])(@hedge\/[a-z-]+)\1/g,
    (_match, quote: string, specifier: string) => {
      const target = VENDORED_PACKAGES[specifier]
      if (!target) throw new Error(`no vendored path for ${specifier}`)
      return `${quote}${relativeSpecifier(fileDir, target)}${quote}`
    },
  )
}

/** A POSIX relative import specifier from one template-relative directory to another path. */
export function relativeSpecifier(fromDir: string, toPath: string): string {
  const rel = relative(fromDir || '.', toPath)
    .split(/[\\/]/)
    .join('/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

/**
 * Files that must not ship in the template. Tests are `bun test` files — the template has no Bun,
 * and their `turbo run test` would try to run them — and the seeds and drizzle config belong to
 * authoring the schema, which happens in this repository and not in a copy of it.
 */
export function isExcludedSource(templateRelativePath: string): boolean {
  return (
    /\.test\.tsx?$/.test(templateRelativePath) ||
    /(^|\/)__tests__\//.test(templateRelativePath) ||
    /(^|\/)\.DS_Store$/.test(templateRelativePath)
  )
}

/**
 * The two binding descriptions that stop being true once the template renames the Worker.
 *
 * `workers-config.md` says three places describing a var must stay in step — the root
 * `package.json`, the comments in `wrangler.jsonc`, and the README. The generated template is a
 * fourth reader, and this map is where that agreement is enforced: `WORKER_NAME` is empty for a
 * button deployment of *this repository* because the script is always `hedge-cms`, and it is
 * **not** empty here, because their linter forces the script to be `hedge-cms-template`.
 */
export const TEMPLATE_BINDING_OVERRIDES: Record<string, { description: string }> = {
  WORKER_NAME: {
    description:
      'Leave as `hedge-cms-template`. A Worker is not told its own script name at run time and the dashboard updater has to address the script it is running as, so a deployment whose name is not the default records it here. Change it only if you also rename the Worker in `wrangler.jsonc`.',
  },
}

export interface TemplatePackageInput {
  /** `cloudflare.bindings` carried over from the root `package.json`, with the overrides applied. */
  bindings: Record<string, { description: string }>
  /** Exact versions, resolved from this repository's lockfile. */
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

/**
 * The generated `package.json`.
 *
 * Every rule encoded here is read from their `cli/src/lint.ts` rather than from the prose in
 * CONTRIBUTING.md, because where the two differ the code is what runs:
 *
 * - `scripts.dev` and `scripts.deploy` must both exist.
 * - `cloudflare.label` must be defined; `products` and `categories` must be arrays, and `categories`
 *   may only contain `starter`, `storage` or `ai`. An **absent** `categories` key fails; `[]` passes.
 * - `preview_image_url`, `preview_icon_url` and `publish` are Cloudflare's to set, from their own
 *   images account, during PR review. Inventing any of them is worse than omitting them: omitted,
 *   the linter doesn't ask for them at all, because it only requires the two URLs when
 *   `publish === true`.
 * - `name` must be kebab-case, end in `-template`, and match the directory *and* `wrangler.jsonc`.
 *
 * `@types/bun`, `packageManager` and `engines.bun` are dropped, and no `@hedge/*` or `workspace:*`
 * specifier survives: npm can resolve none of them.
 */
export function templatePackageJson(input: TemplatePackageInput): Record<string, unknown> {
  return {
    name: TEMPLATE_NAME,
    description:
      'Multi-site headless CMS on Workers: admin SPA, management API and an edge-cached delivery API in one Worker, backed by D1, R2 and Email Sending.',
    // No `version` field: every other template in the repository is a private, unversioned package,
    // and the version Hedge reports comes from the vendored `HEDGE_VERSION` rather than from here —
    // which is what makes regenerating after a release bump need no manual edit.
    private: true,
    type: 'module',
    license: 'MIT',
    cloudflare: {
      label: 'Hedge CMS',
      products: [...TEMPLATE_PRODUCTS],
      categories: [...TEMPLATE_CATEGORIES],
      docs_url: 'https://github.com/bihaviour/hedge-cms#readme',
      /**
       * Their Playwright harness polls this path for readiness instead of `/`. `/api/health` is the
       * one route that answers without touching Better Auth, so it says "the Worker is up" rather
       * than "the asset router is up" — and it distinguishes the two when this fails on their CI
       * six months from now.
       */
      healthCheckPath: '/api/health',
      bindings: { ...input.bindings, ...TEMPLATE_BINDING_OVERRIDES },
    },
    engines: {
      // Their harness and CI run on Node; the repository's own root pins `>=20.16.0 || >=22.3.0`.
      node: '>=20.16.0',
    },
    scripts: templateScripts(),
    dependencies: sortRecord(input.dependencies),
    devDependencies: sortRecord(input.devDependencies),
  }
}

/**
 * The template's scripts, and the two constraints that shape them.
 *
 * **One process, on the port their heuristic picks.** `playwright-tests/utils/template-server.ts`
 * spawns exactly `npm run dev` and then polls a port it chose *by looking at the dependency set*:
 * `vite` anywhere in `dependencies` or `devDependencies` means 5173, whatever our script binds. The
 * admin build needs vite, so the port is 5173 and `wrangler dev` is told so explicitly. Hedge's own
 * two-terminal loop (`dev:api` on 8787, `dev:admin` on 5173 proxying to it) cannot be the
 * template's: the harness starts one command, and in a deployment the Worker's `ASSETS` binding
 * already serves the SPA, so building it and serving it from one `wrangler dev` is also the truer
 * picture of how it runs.
 *
 * **Migrations first, and alongside the build rather than before it.** A fresh local D1 has no
 * tables, so the Worker answers 500s until `d1 migrations apply --local` has run; `d1-template` and
 * `saas-admin-template` both precede `wrangler dev` the same way. Run in sequence it does not fit:
 * measured on a cold checkout the migration is ~12.5s, the Vite build ~9s and `wrangler dev` ~7s,
 * which reaches the first successful health check at **~30.3s** — past the harness's 30-second
 * budget, so the smoke test fails on a CMS that is working perfectly. The two are independent, so
 * the migration runs in the background and `wait` collects it: **~19s**, and ~29s on a runner whose
 * page cache is still cold from `npm install`. That is the headroom, and it is not generous — keep
 * them parallel and re-measure before adding anything to this line.
 *
 * `ENVIRONMENT:development` is what makes invites and password resets print their links to the
 * console instead of being handed to a provider that is not configured locally.
 */
export function templateScripts(): Record<string, string> {
  return {
    dev: 'npm run db:migrate & npm run build && wait $! && wrangler dev --port 5173 --var ENVIRONMENT:development',
    build: 'vite build',
    // The house style in `d1-template` and `openauth-template`. `build` first because
    // `wrangler deploy --dry-run` resolves the assets directory, which does not exist until vite
    // has written it.
    check:
      'npm run build && tsc -p tsconfig.json && tsc -p admin/tsconfig.json && wrangler deploy --dry-run',
    'cf-typegen': 'wrangler types',
    // npm runs `predeploy` before `deploy` on its own; that is where `d1-template` and
    // `saas-admin-template` put the remote migration, and it keeps `deploy` a single verb.
    predeploy: 'npm run build && wrangler d1 migrations apply DB --remote',
    deploy: 'wrangler deploy',
    'db:migrate': 'wrangler d1 migrations apply DB --local',
    'db:migrate:remote': 'wrangler d1 migrations apply DB --remote',
  }
}

export interface WranglerConfig {
  name?: string
  main?: string
  compatibility_date?: string
  compatibility_flags?: string[]
  observability?: { enabled?: boolean; head_sampling_rate?: number }
  upload_source_maps?: boolean
  assets?: Record<string, unknown>
  d1_databases?: Array<Record<string, unknown>>
  r2_buckets?: Array<Record<string, unknown>>
  send_email?: Array<Record<string, unknown>>
  triggers?: Record<string, unknown>
  vars?: Record<string, string>
  [key: string]: unknown
}

/**
 * The generated `wrangler.jsonc`, from this repository's own.
 *
 * Four values are hard failures in their linter — `compatibility_date`, `observability.enabled`,
 * `upload_source_maps` and `name` — and the paths have to be rewritten because the template is one
 * directory rather than a monorepo root pointing into `apps/`.
 *
 * **`WORKER_NAME` is set here, and that is the whole answer to the name collision.** Their linter
 * forces the script to be called `hedge-cms-template`, but `wrangler.jsonc`'s comments, the root
 * `package.json` field descriptions and the README all say a button deployment is called
 * `hedge-cms` — which is what the dashboard updater addresses when `WORKER_NAME` is empty. Leaving
 * it empty here would make Settings → About offer an update that tried to overwrite a Worker with
 * the wrong name. Setting it costs nothing and keeps the About page truthful for anyone who deploys
 * from the gallery. `INSTALLED_BY` stays `button`: a gallery deployment is a Workers Builds clone
 * with exactly the button's update paths.
 */
export function templateWranglerConfig(root: WranglerConfig): WranglerConfig {
  const config: WranglerConfig = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: TEMPLATE_NAME,
    main: 'src/index.ts',
    compatibility_date: TARGET_COMPATIBILITY_DATE,
    compatibility_flags: root.compatibility_flags ?? [],
    observability: { enabled: true },
    // Required `true` by their linter. It also means a stack trace from this Worker points at the
    // source rather than the bundle, which is worth having in a template people will modify.
    upload_source_maps: true,
    assets: {
      ...root.assets,
      directory: 'admin/dist',
    },
    d1_databases: (root.d1_databases ?? []).map((db) => ({
      ...db,
      migrations_dir: 'migrations',
    })),
    r2_buckets: root.r2_buckets ?? [],
    send_email: root.send_email ?? [],
    triggers: root.triggers ?? {},
    vars: {
      ...(root.vars ?? {}),
      WORKER_NAME: TEMPLATE_NAME,
    },
  }
  return config
}

/**
 * Their `.gitignore` check, in full: the file must exist and match `/^(\/)?node_modules/m` and
 * `/^(\/)?\.wrangler/m`. The recommended contents are the macos+node+git toptal block plus their
 * Wrangler block; this is that, trimmed to the parts a Hedge template can actually produce.
 */
export function templateGitignore(): string {
  return `# Created by https://www.toptal.com/developers/gitignore/api/macos,node,git
# Edit at https://www.toptal.com/developers/gitignore?templates=macos,node,git

### Git ###
*.orig
*.BACKUP.*
*.BASE.*
*.LOCAL.*
*.REMOTE.*

### macOS ###
.DS_Store
.AppleDouble
.LSOverride
._*
.DocumentRevisions-V100
.fseventsd
.Spotlight-V100
.TemporaryItems
.Trashes
.VolumeIcon.icns
.com.apple.timemachine.donotpresent
*.icloud

### Node ###
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pids
*.pid
*.seed
*.pid.lock
coverage
*.lcov
.nyc_output
node_modules/
jspm_packages/
*.tsbuildinfo
.npm
.eslintcache
.stylelintcache
dist
.cache
.temp
*.tgz

### Wrangler ###
.wrangler/
.env*
!.env.example
.dev.vars*
!.dev.vars.example
`
}

/**
 * `.dev.vars.example`, which is not documentation here — their harness **copies it to `.dev.vars`**
 * before starting the server and never generates one. An empty `AUTH_SECRET` would make every
 * authenticated route 500 and the smoke test would fail looking exactly like a bug in Hedge, so the
 * value has to be present and usable.
 */
export function templateDevVarsExample(): string {
  return `# Copied to .dev.vars automatically by the Playwright harness in cloudflare/templates, and by
# hand for local development. The value below is a throwaway for development only.
#
# Generate a real one before deploying:
#   openssl rand -base64 32
#
# AUTH_SECRET signs sessions and invite links and is the HMAC key for delivery API keys. Rotating it
# signs everyone out and invalidates every key.
AUTH_SECRET=hedge-template-development-secret-do-not-use-in-production
`
}

/**
 * Prettier settings for the generated directory.
 *
 * `cloudflare/templates` runs `prettier . --check` over everything, and Prettier is not Biome — a
 * directory formatted by ours fails theirs. A config *inside* the template directory is the nearest
 * one Prettier finds for these files, so it wins over their root config and the generator can format
 * its own output to match it exactly. `saas-admin-template` set the precedent for a per-template
 * override. The values are Biome's, so the generated source still reads like the repository it came
 * from; `*.jsonc` inherits their root's `trailingComma: none`, which their JSONC parser needs.
 */
export function templatePrettierConfig(): string {
  return `useTabs: false
tabWidth: 2
printWidth: 100
semi: false
singleQuote: true
trailingComma: all
overrides:
  - files:
      - "*.jsonc"
    options:
      trailingComma: none
  - files:
      - "*.json"
      - "*.md"
      - "*.yaml"
      - "*.yml"
    options:
      singleQuote: false
`
}

/**
 * The two files Prettier must not touch, mirroring their root `.prettierignore`. `wrangler types`
 * and `npm install` rewrite these on every run, so formatting them is churn that comes straight
 * back.
 */
export function templatePrettierIgnore(): string {
  return `# Written by \`wrangler types\` and \`npm install\`; reformatting either is undone on the next run.
worker-configuration.d.ts
package-lock.json

node_modules
admin/dist
`
}

/* ------------------------------------------------------------------------------------------------
   Their linter, reimplemented
   ------------------------------------------------------------------------------------------------
   `templates lint .` only runs inside a checkout of their repository, which is a slow thing to need
   in order to learn that a generated file is one key short. These four functions are a transcription
   of `cli/src/lint.ts` so `template-lib.test.ts` can hold the generator to it on every commit. They
   are a *copy of someone else's rules*: when their linter changes, this is what has to be re-read.
   ------------------------------------------------------------------------------------------------ */

/** Only the keys their linter reads; everything else on a `package.json` is none of its business. */
interface CloudflareMeta {
  label?: unknown
  products?: unknown
  categories?: unknown
  preview_image_url?: unknown
  preview_icon_url?: unknown
  publish?: unknown
}

export function lintTemplatePackageJson(pkg: Record<string, unknown>): string[] {
  const problems: string[] = []
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>
  if (!scripts.deploy) problems.push('"scripts.deploy" must be defined')
  if (!scripts.dev) problems.push('"scripts.dev" must be defined')

  const cloudflare = pkg.cloudflare as CloudflareMeta | undefined
  if (!cloudflare) {
    problems.push('"cloudflare" object must be defined')
    return problems
  }
  if (!cloudflare.label) problems.push('"cloudflare.label" must be defined')
  if (!Array.isArray(cloudflare.products)) {
    problems.push('"cloudflare.products" must be an array')
  } else if (cloudflare.products.length > 3) {
    // Not enforced by `lint.ts`, but stated in CONTRIBUTING and asked for in review.
    problems.push('"cloudflare.products" must list 3 or fewer products')
  }
  if (!Array.isArray(cloudflare.categories)) {
    problems.push('"cloudflare.categories" must be an array')
  } else {
    for (const category of cloudflare.categories) {
      if (!TEMPLATE_CATEGORY_VOCABULARY.includes(category as string)) {
        problems.push(
          `"cloudflare.categories" lists "${category}", but can only include "starter", "storage", and "ai".`,
        )
      }
    }
  }
  if (cloudflare.publish === true) {
    if (!cloudflare.preview_image_url)
      problems.push('"cloudflare.preview_image_url" must be defined')
    if (!cloudflare.preview_icon_url) problems.push('"cloudflare.preview_icon_url" must be defined')
  }
  if (pkg.name !== TEMPLATE_NAME) problems.push(`"name" should be "${TEMPLATE_NAME}"`)
  if (!pkg.description) problems.push('"description" must be defined')
  return problems
}

const TEMPLATE_CATEGORY_VOCABULARY = ['starter', 'storage', 'ai']

export function lintTemplateWrangler(
  wrangler: WranglerConfig,
  packageName: string | undefined,
): string[] {
  const problems: string[] = []
  if (wrangler.compatibility_date !== TARGET_COMPATIBILITY_DATE) {
    problems.push(`"compatibility_date" should be set to "${TARGET_COMPATIBILITY_DATE}"`)
  }
  if (wrangler.observability?.enabled !== true) {
    problems.push('"observability" should be set to { "enabled": true }')
  }
  if (wrangler.upload_source_maps !== true) {
    problems.push('"upload_source_maps" should be set to true')
  }
  if (wrangler.name !== TEMPLATE_NAME) problems.push(`"name" should be set to "${TEMPLATE_NAME}"`)
  if (wrangler.name !== packageName) {
    problems.push(
      `"name" in wrangler.jsonc (${wrangler.name}) should match package.json name (${packageName})`,
    )
  }
  return problems
}

/** Exactly one start marker, then exactly one end marker. Their check is line-trimmed. */
export function lintTemplateReadme(readme: string): string[] {
  let next: 'content-start' | 'content-end' | 'document-end' = 'content-start'
  for (const [i, line] of readme
    .split('\n')
    .map((l) => l.trim())
    .entries()) {
    if (line === DASH_CONTENT_START_MARKER) {
      if (next !== 'content-start')
        return [`Unexpected occurrence of ${DASH_CONTENT_START_MARKER} on line ${i + 1}`]
      next = 'content-end'
    } else if (line === DASH_CONTENT_END_MARKER) {
      if (next !== 'content-end')
        return [`Unexpected occurrence of ${DASH_CONTENT_END_MARKER} on line ${i + 1}`]
      next = 'document-end'
    }
  }
  if (next === 'content-end') return [`Missing closing ${DASH_CONTENT_END_MARKER}`]
  if (next === 'content-start') return [`Missing ${DASH_CONTENT_START_MARKER}`]
  return []
}

export function lintTemplateGitignore(contents: string): string[] {
  const problems: string[] = []
  for (const expected of [/^(\/)?node_modules/m, /^(\/)?\.wrangler/m]) {
    if (!expected.test(contents)) problems.push(`Expected ${expected} to exist in .gitignore`)
  }
  return problems
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)))
}
