#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parseJsonc } from './artifact-lib'
import {
  isExcludedSource,
  lintTemplateGitignore,
  lintTemplatePackageJson,
  lintTemplateReadme,
  lintTemplateWrangler,
  rewriteHedgeImports,
  TEMPLATE_NAME,
  templateDevVarsExample,
  templateGitignore,
  templatePackageJson,
  templatePrettierConfig,
  templatePrettierIgnore,
  templateWranglerConfig,
  type WranglerConfig,
} from './template-lib'

/**
 * Builds `hedge-cms-template/` — the flattened, npm-installable copy of Hedge that is submitted to
 * [`cloudflare/templates`](https://github.com/cloudflare/templates) (#48, epic #54). Gitignored,
 * like `artifact/`, and generated the same way `scripts/build-artifact.ts` generates the release
 * artifact: **the copy is never hand-maintained**, because one that drifts three releases behind
 * this repository is worse than no template at all.
 *
 *   bun run build:template              # write the directory
 *   bun run build:template -- --install # …then npm install, regenerate types, and run their `check`
 *
 * `--install` is required before submitting and needs the network: `package-lock.json` and
 * `worker-configuration.d.ts` are both produced by npm and wrangler inside the generated directory,
 * and their CI's trailing `git diff --exit-code` fails on a stale one.
 *
 * The runbook for driving this through their CI gate is `docs/cloudflare-template.md`.
 */

const ROOT = join(import.meta.dir, '..')
const args = process.argv.slice(2)
const OUT_DIR = join(ROOT, args.find((a) => !a.startsWith('--')) ?? TEMPLATE_NAME)
const INSTALL = args.includes('--install')
const NO_FORMAT = args.includes('--no-format')

/**
 * What gets copied, and where it lands.
 *
 * The three flattening decisions are all here. `packages/core` and `packages/deploy` are consumed
 * as source in this repository (their `build` is only a typecheck), so they are inlined under
 * `vendor/` and every `@hedge/*` import is rewritten to a relative path — npm can resolve neither
 * `workspace:*` nor `@hedge/core`. `apps/installer` is dropped entirely: it is a local wizard for
 * repository-less installs and means nothing inside a template someone clicks Deploy on.
 * `packages/deploy` still ships, because the Worker imports it for the dashboard update path.
 */
const SOURCE_TREES: Array<{ from: string; to: string }> = [
  { from: 'apps/api/src', to: 'src' },
  { from: 'apps/admin/src', to: 'admin/src' },
  { from: 'apps/admin/public', to: 'admin/public' },
  { from: 'packages/core/src', to: 'vendor/core' },
  { from: 'packages/deploy/src', to: 'vendor/deploy' },
]

/**
 * Exact versions, resolved from `bun.lock`, so the template installs what this repository actually
 * tests. Every template in their repository pins exactly and `syncpack lint` runs in `check:deps`;
 * a range would both drift from what we tested and be flagged there.
 */
const RUNTIME_DEPENDENCIES = [
  '@better-auth/drizzle-adapter',
  '@hookform/resolvers',
  '@radix-ui/react-dialog',
  '@radix-ui/react-dropdown-menu',
  '@radix-ui/react-label',
  '@radix-ui/react-select',
  '@radix-ui/react-separator',
  '@radix-ui/react-slot',
  '@radix-ui/react-switch',
  '@radix-ui/react-tooltip',
  '@tanstack/react-query',
  'better-auth',
  'class-variance-authority',
  'clsx',
  'drizzle-orm',
  'hono',
  'lucide-react',
  'next-themes',
  'radix-ui',
  'react',
  'react-dom',
  'react-hook-form',
  'react-router',
  'recharts',
  'sonner',
  'tailwind-merge',
  'zod',
]

/**
 * Build-time only. `drizzle-kit` is deliberately absent: generating a migration is authoring the
 * schema, which happens in this repository, and the template ships the migrations already written.
 * `@types/bun` is absent because there is no Bun in a template.
 */
const BUILD_DEPENDENCIES = [
  '@tailwindcss/vite',
  '@types/node',
  '@types/react',
  '@types/react-dom',
  '@vitejs/plugin-react',
  'tailwindcss',
  'tw-animate-css',
  'typescript',
  'vite',
  'wrangler',
]

function run(): void {
  const rootPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const rootWrangler = parseJsonc(
    readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8'),
  ) as WranglerConfig
  const versions = resolveVersions()

  clean()

  let copied = 0
  for (const tree of SOURCE_TREES) copied += copyTree(tree.from, tree.to)
  const migrations = copyMigrations()

  copyFile('apps/admin/index.html', 'admin/index.html')
  copyFile('LICENSE', 'LICENSE')

  const pkg = templatePackageJson({
    bindings: rootPackage.cloudflare.bindings,
    dependencies: pick(versions, RUNTIME_DEPENDENCIES),
    devDependencies: pick(versions, BUILD_DEPENDENCIES),
  })
  write('package.json', `${JSON.stringify(pkg, null, 2)}\n`)

  const wrangler = templateWranglerConfig(rootWrangler)
  write('wrangler.jsonc', wranglerJsonc(wrangler))

  write('tsconfig.json', WORKER_TSCONFIG)
  write('admin/tsconfig.json', ADMIN_TSCONFIG)
  write('vite.config.ts', VITE_CONFIG)
  write('.gitignore', templateGitignore())
  write('.dev.vars.example', templateDevVarsExample())
  write('.prettierrc.yaml', templatePrettierConfig())
  write('.prettierignore', templatePrettierIgnore())

  const readme = readFileSync(join(ROOT, 'templates', 'README.template.md'), 'utf8')
  write('README.md', readme)

  // A starting point only: `wrangler types` rewrites this from the template's own config, and its
  // runtime types follow the compatibility date, which the template downgrades to theirs.
  copyFile('apps/api/worker-configuration.d.ts', 'worker-configuration.d.ts')

  verify(pkg, wrangler, readme)

  console.log(`Wrote ${relative(ROOT, OUT_DIR)}/`)
  console.log(`  source files: ${copied}`)
  console.log(`  migrations:   ${migrations}`)

  if (!NO_FORMAT) format()
  if (INSTALL) install()
  else {
    console.log('')
    console.log('Not installed. Before submitting, run:')
    console.log('  bun run build:template -- --install')
    console.log('which writes package-lock.json, regenerates worker-configuration.d.ts, and runs')
    console.log("the template's own `check`. Until then the committed types are this repo's.")
  }
}

/**
 * Empty the output directory, keeping only what npm and wrangler own.
 *
 * Every generated file is rewritten from scratch, so a leftover from an earlier run must not
 * survive. `node_modules` and `package-lock.json` do: the lockfile is a deliverable that `npm
 * install` updates in place rather than something this script can write, and re-downloading 265
 * packages to regenerate a README is a minute nobody needs to spend. The local D1 and the copied
 * `.dev.vars` stay for the same reason.
 */
function clean(): void {
  const keep = new Set(['node_modules', 'package-lock.json', '.wrangler', '.dev.vars'])
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true })
    return
  }
  for (const entry of readdirSync(OUT_DIR)) {
    if (keep.has(entry)) continue
    rmSync(join(OUT_DIR, entry), { recursive: true, force: true })
  }
}

/** Copy one tree, rewriting `@hedge/*` imports in every TypeScript file as it goes. */
function copyTree(from: string, to: string): number {
  const source = join(ROOT, from)
  if (!existsSync(source)) return 0
  let count = 0
  for (const path of walk(source)) {
    const rel = relative(source, path).split(/[\\/]/).join('/')
    const target = `${to}/${rel}`
    if (isExcludedSource(target)) continue
    if (/\.tsx?$/.test(target)) {
      write(target, rewriteHedgeImports(readFileSync(path, 'utf8'), dirname(target)))
    } else {
      mkdirSync(dirname(join(OUT_DIR, target)), { recursive: true })
      cpSync(path, join(OUT_DIR, target))
    }
    count++
  }
  return count
}

/**
 * The `.sql` files only. `migrations/meta/` is drizzle-kit's snapshot set, read when *generating* a
 * migration — which the template does not do — and wrangler reads nothing but the `.sql` files.
 */
function copyMigrations(): number {
  const dir = join(ROOT, 'apps', 'api', 'migrations')
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  for (const name of names) {
    mkdirSync(join(OUT_DIR, 'migrations'), { recursive: true })
    cpSync(join(dir, name), join(OUT_DIR, 'migrations', name))
  }
  return names.length
}

/**
 * Hold the output to their linter before anyone waits on a CI run to learn the same thing.
 * `template-lib.ts` carries the transcription; this is where a failure stops the build.
 */
function verify(pkg: Record<string, unknown>, wrangler: WranglerConfig, readme: string): void {
  const problems = [
    ...lintTemplatePackageJson(pkg).map((p) => `package.json: ${p}`),
    ...lintTemplateWrangler(wrangler, pkg.name as string).map((p) => `wrangler.jsonc: ${p}`),
    ...lintTemplateReadme(readme).map((p) => `README.md: ${p}`),
    ...lintTemplateGitignore(templateGitignore()).map((p) => `.gitignore: ${p}`),
  ]
  const json = JSON.stringify(pkg)
  if (json.includes('@hedge/')) problems.push('package.json: a @hedge/* dependency survived')
  if (json.includes('workspace:')) problems.push('package.json: a workspace:* dependency survived')
  if (json.includes('@types/bun')) problems.push('package.json: @types/bun survived')
  for (const path of walk(OUT_DIR)) {
    if (!/\.tsx?$/.test(path)) continue
    if (/from ['"]@hedge\//.test(readFileSync(path, 'utf8'))) {
      problems.push(`${relative(OUT_DIR, path)}: an unrewritten @hedge/* import survived`)
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `generated template would fail cloudflare/templates lint:\n  ${problems.join('\n  ')}`,
    )
  }
}

/**
 * Format with **their** Prettier rather than our Biome. `cloudflare/templates` runs
 * `prettier . --check` across the whole repository, so a directory formatted by anything else fails
 * it. The settings come from the `.prettierrc.yaml` written into the generated directory, which is
 * the nearest config Prettier finds for these files.
 *
 * The generated `.prettierignore` mirrors the two entries from their root one that matter here:
 * both files are written by a tool (`wrangler types`, `npm install`) that undoes any reformatting on
 * the next run. It is a file rather than `--ignore-pattern` because that flag is not honoured for
 * paths given explicitly, and Prettier reads `.prettierignore` from the directory it runs in.
 */
function format(): void {
  const result = spawnSync('bunx', ['prettier', '--write', '--log-level', 'warn', '.'], {
    cwd: OUT_DIR,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.warn('prettier did not run; `pnpm fix:prettier` in their checkout is the fallback')
  }
}

/** npm install, then the two files only npm and wrangler can write, then their `check` equivalent. */
function install(): void {
  step('npm', ['install'])
  step('npm', ['run', 'cf-typegen'])
  step('npm', ['run', 'check'])
  console.log('')
  console.log('Installed and checked. package-lock.json and worker-configuration.d.ts are current.')
}

function step(command: string, argv: string[]): void {
  console.log(`\n$ ${command} ${argv.join(' ')}`)
  const result = spawnSync(command, argv, {
    cwd: OUT_DIR,
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })
  if (result.status !== 0) throw new Error(`${command} ${argv.join(' ')} failed in the template`)
}

/**
 * Exact versions out of `bun.lock`. Reading the lockfile rather than the `package.json` ranges is
 * what makes `^4.12.32` in this repository become `"hono": "4.12.32"` in the template — the version
 * that was actually installed and tested here.
 */
function resolveVersions(): Record<string, string> {
  const raw = readFileSync(join(ROOT, 'bun.lock'), 'utf8')
  // bun.lock is JSONC with trailing commas; strip those rather than pulling in a parser.
  const lock = JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1')) as {
    packages: Record<string, [string, ...unknown[]]>
  }
  const versions: Record<string, string> = {}
  for (const [name, entry] of Object.entries(lock.packages)) {
    const descriptor = entry[0]
    const at = descriptor.lastIndexOf('@')
    if (at > 0) versions[name] = descriptor.slice(at + 1)
  }
  return versions
}

/**
 * Versions the template pins *away from* what `bun.lock` resolved, each with its reason.
 *
 * Bun and npm do not resolve the same tree. Bun installs optional peer dependencies leniently; npm
 * refuses a tree whose optional peers contradict each other, and that is a hard `npm install`
 * failure rather than a warning — which is exactly the gate a template has to pass. Anything added
 * here is a divergence from what this repository tests, so keep the list short and say why.
 *
 * A second reason to appear here is `syncpack lint` in their `check:deps`, which flags a version
 * that disagrees with the other thirty-odd templates. Record those the same way.
 */
const NPM_RESOLUTION_OVERRIDES: Record<string, { version: string; reason: string }> = {
  '@hookform/resolvers': {
    version: '5.2.2',
    // 5.4.2 declares an optional peer on `@typeschema/main`, whose own `@typeschema/valibot` wants
    // valibot ^0.39 while the resolver wants valibot ^1 — npm reports ERESOLVE and stops. 5.2.2 is
    // also what `saas-admin-template` pins, so it is the version their syncpack baseline expects.
    reason: 'npm ERESOLVE on the valibot optional-peer conflict in 5.4.x',
  },
}

function pick(versions: Record<string, string>, names: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const override = NPM_RESOLUTION_OVERRIDES[name]
    if (override) {
      out[name] = override.version
      continue
    }
    const version = versions[name]
    if (!version) throw new Error(`${name} is not in bun.lock — did it move workspace?`)
    out[name] = version
  }
  return out
}

/**
 * The Wrangler config, as JSONC with a generated-file banner.
 *
 * The comments in the repository's own `wrangler.jsonc` are not carried over: most of them explain
 * monorepo paths and the three install paths, neither of which is true here. What a template reader
 * needs instead is `cloudflare.bindings` in `package.json` — which *is* carried over verbatim, and
 * which is what the dashboard renders on the setup page.
 */
function wranglerJsonc(config: WranglerConfig): string {
  return `// Generated from the Hedge repository's own wrangler.jsonc by scripts/build-template.ts.
// Edit it there — https://github.com/bihaviour/hedge-cms — not here.
//
// The D1 database and R2 bucket carry no ids on purpose: wrangler provisions whatever is missing on
// the first \`wrangler deploy\` (and on the first \`wrangler dev\`, locally), which is what lets this
// deploy into any account without editing anything first.
//
// PUBLIC_URL is deliberately empty: a deployment does not know its own URL until it has one, so the
// Worker falls back to the origin of the request it is answering. With a custom domain, set the
// full origin including the scheme — https://cms.example.com, no trailing slash. Anything that is
// not a URL takes down every authenticated route while /api/health carries on answering ok.
${JSON.stringify(config, null, 2)}
`
}

/**
 * The Worker's tsconfig, and the reason the template needs two — in two specific places.
 *
 * The Worker and the admin cannot share one: the Worker compiles against workerd's globals with
 * `hono/jsx`, the admin against the DOM with React's. `vendor/` is compiled by whichever one imports
 * it, the same arrangement `apps/api` already has through its `@hedge/*` path mappings.
 *
 * **The admin's config has to be `admin/tsconfig.json`, not a second file at the root**, and this is
 * not tidiness. Vite hands each file to esbuild with the options from the *nearest* `tsconfig.json`,
 * so with only a root config the admin's `.tsx` compiled against `jsxImportSource: "hono/jsx"` — a
 * build that succeeds, typechecks, and then throws `Cannot convert a Symbol value to a string` out
 * of Hono's `JSXNode` the moment the page loads, with a blank screen and nothing in the build log.
 * Putting it in `admin/` makes it the nearest config for exactly the files it describes.
 */
const WORKER_TSCONFIG = `{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx",

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,

    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,

    "noEmit": true
  },
  "include": ["src/**/*.ts", "vendor/**/*.ts", "worker-configuration.d.ts"],
  "exclude": ["node_modules", "admin/dist", ".wrangler"]
}
`

const ADMIN_TSCONFIG = `{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    },

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,

    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,

    "noEmit": true
  },
  "include": ["src", "../vendor/core"],
  "exclude": ["node_modules", "dist"]
}
`

/**
 * One vite config at the template root, building `admin/` into `admin/dist` — the directory the
 * Worker's `ASSETS` binding serves. There is no dev proxy: unlike this repository's two-terminal
 * loop, the template's `dev` builds the SPA and serves it from `wrangler dev`, which is both what
 * their one-command harness needs and what the deployment actually does.
 */
const VITE_CONFIG = `import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'admin',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./admin/src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No source maps, unlike the upstream repository. They are six megabytes of public assets
    // uploaded on every deploy of a template most people will read rather than debug — and the
    // Worker's own maps — the ones worth having — come from upload_source_maps in wrangler.jsonc.
  },
})
`

function write(templatePath: string, contents: string): void {
  const target = join(OUT_DIR, templatePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

function copyFile(from: string, to: string): void {
  const source = join(ROOT, from)
  if (!existsSync(source)) throw new Error(`${from} is missing`)
  mkdirSync(dirname(join(OUT_DIR, to)), { recursive: true })
  cpSync(source, join(OUT_DIR, to))
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.wrangler') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else yield full
  }
}

run()
