import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_SITE_PERMISSIONS, builtinSiteRole } from '@hedge/core'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Hono } from 'hono'
import { roles, type SiteRow, sites, siteUsers, users } from '../db/schema'
import type { Actor, AppEnv } from '../env'

/**
 * Resolving a site permission set (#151, stage 2), against a real SQLite built from the committed
 * migrations — because the claim being tested is about the *migration*.
 *
 * The one thing that can break a deployment here is the seed: every `site_users` row keeps its slug,
 * so the day after `0018` runs, "what an editor may do" is whatever that row says. If the seed and
 * the catalog disagree, everybody holding a built-in role silently gains or loses access and the
 * suite that pins the catalog in `packages/core` never notices, because it never reads the SQL.
 */

let db: ReturnType<typeof drizzle>

const realClient = await import('../db/client')
mock.module('../db/client', () => ({ ...realClient, getDb: () => db }))

const { sitePermissionsFor, requireSitePermission } = await import('./auth')
const { errorResponse } = await import('./errors')
const { deleteRole, updateRole } = await import('./roles')
const { setUserSiteRole } = await import('./users')

const MIGRATIONS = join(import.meta.dir, '../../migrations')

function migrate(sqlite: Database) {
  for (const name of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    for (const statement of readFileSync(join(MIGRATIONS, name), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      const trimmed = statement.trim()
      if (trimmed) sqlite.exec(trimmed)
    }
  }
}

let env: AppEnv['Bindings']

/** An instance editor: no `sites:access_all`, so their `site_users` grant is their whole access. */
const person = (id = 'usr_1'): Actor => ({
  kind: 'user',
  via: 'session',
  id,
  role: 'editor',
  permissions: [],
  scopes: [],
  siteId: null,
})

/** Somebody who reaches every site without a grant — an instance owner or admin. */
const reachesEverySite: Actor = { ...person('usr_owner'), permissions: ['sites:access_all'] }

const authoringKey: Actor = {
  kind: 'api_key',
  via: 'api_key',
  id: 'key_1',
  role: 'editor',
  permissions: [],
  scopes: ['content:write'],
  siteId: 'site_1',
}

async function grant(userId: string, role: string) {
  await db.insert(siteUsers).values({ siteId: 'site_1', userId, role })
}

beforeEach(() => {
  const sqlite = new Database(':memory:')
  migrate(sqlite)
  db = drizzle(sqlite)
  env = { AUTH_SECRET: 'test-secret' } as AppEnv['Bindings']
})

describe('the migration seeds what the ranks granted', () => {
  test('every built-in site role is a row, matching the catalog column for column', async () => {
    const rows = await db.select().from(roles)

    for (const slug of ['admin', 'editor', 'viewer']) {
      const row = rows.find((r) => r.slug === slug)
      const catalog = builtinSiteRole(slug)!

      expect(row).toBeDefined()
      expect(row!.sitePermissions.sort()).toEqual([...catalog.site].sort())
      expect(row!.mcpPermissions.sort()).toEqual([...catalog.mcp].sort())
      expect(row!.apiKeyPermissions.sort()).toEqual([...catalog.apiKey].sort())
    }
  })

  test('and carries no instance permissions, which stay in code', async () => {
    // A built-in's deployment powers are the half that can lock an owner out, so the row must not
    // be able to speak for them — an editable `admin` row granting `sites:delete` would be exactly
    // the drift `BUILTIN_ROLES` exists to prevent.
    const [row] = await db.select().from(roles).where(eq(roles.slug, 'admin'))
    expect(row!.permissions).toEqual([])
  })
})

describe('resolving a set', () => {
  test('a grant resolves the role it names', async () => {
    await grant('usr_1', 'editor')

    const permissions = await sitePermissionsFor(env, person(), 'site_1')

    expect(permissions).toEqual(builtinSiteRole('editor')!.site)
    // The case the epic exists for, on the day it becomes storable: an editor writes and deletes
    // entries but cannot reshape the model.
    expect(permissions).toContain('entries:delete')
    expect(permissions).not.toContain('collections:create')
  })

  test('the row decides, not the code — narrowing a built-in narrows everyone holding it', async () => {
    await grant('usr_1', 'editor')
    await db
      .update(roles)
      .set({ sitePermissions: ['entries:read', 'entries:create', 'entries:update'] })
      .where(eq(roles.slug, 'editor'))

    const permissions = await sitePermissionsFor(env, person(), 'site_1')

    expect(permissions).toEqual(['entries:read', 'entries:create', 'entries:update'])
    expect(permissions).not.toContain('entries:delete')
  })

  test('a slug with no row falls back to what it has always meant', async () => {
    // The window between a deploy and its migration, and every unit test with no database. Silence
    // there would mean every editor losing their access until somebody ran the migration.
    await db.delete(roles).where(eq(roles.slug, 'editor'))
    await grant('usr_1', 'editor')

    expect(await sitePermissionsFor(env, person(), 'site_1')).toEqual(
      builtinSiteRole('editor')!.site,
    )
  })

  test('an unknown slug resolves to nothing, rather than to something', async () => {
    await grant('usr_1', 'ghost')

    expect(await sitePermissionsFor(env, person(), 'site_1')).toEqual([])
  })

  test('no grant is no access at all, which is not an empty set', async () => {
    // `null` is "you cannot reach this site"; `[]` is "you can, and may do nothing here". The
    // middleware reports them differently and the admin's site switcher depends on the difference.
    expect(await sitePermissionsFor(env, person(), 'site_1')).toBeNull()
  })

  test('sites:access_all resolves to everything, with no row anywhere', async () => {
    // The floor the whole epic rests on: no edit to any matrix can lock a deployment out of itself.
    await db.delete(roles)

    expect(await sitePermissionsFor(env, reachesEverySite, 'site_1')).toEqual(ALL_SITE_PERMISSIONS)
    expect(await sitePermissionsFor(env, reachesEverySite, 'site_2')).toEqual(ALL_SITE_PERMISSIONS)
  })

  test('a key with no issuer carries what its scopes are for, on its own site and no other', async () => {
    expect(await sitePermissionsFor(env, authoringKey, 'site_1')).toEqual(
      builtinSiteRole('editor')!.site,
    )
    expect(await sitePermissionsFor(env, authoringKey, 'site_2')).toBeNull()
  })

  test('the surface picks the column', async () => {
    await grant('usr_1', 'editor')
    await db
      .update(roles)
      .set({ mcpPermissions: ['entries:read'] })
      .where(eq(roles.slug, 'editor'))

    expect(await sitePermissionsFor(env, person(), 'site_1', 'mcp')).toEqual(['entries:read'])
    // …and narrowing what is delegated leaves the person themselves untouched, which is the whole
    // point of there being three columns rather than one.
    expect(await sitePermissionsFor(env, person(), 'site_1')).toContain('entries:delete')
  })
})

describe('a key is bounded by whoever issued it (#156)', () => {
  /** The issuer, and a key they created — the two halves `api_keys.created_by` ties together. */
  async function issuer(role: string) {
    await db.insert(users).values({
      id: 'usr_issuer',
      email: 'issuer@example.com',
      name: 'Issuer',
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    return { ...authoringKey, issuerId: 'usr_issuer' }
  }

  test('a role that withholds the delete from keys withholds it from their keys', async () => {
    // The key's scopes say `content:write`, which has always meant "an editor" — and the editor
    // role, edited to delegate everything but the delete, is what the key now inherits.
    const key = await issuer('editor')
    await db
      .update(roles)
      .set({
        apiKeyPermissions: builtinSiteRole('editor')!.site.filter((p) => p !== 'entries:delete'),
      })
      .where(eq(roles.slug, 'editor'))

    const permissions = await sitePermissionsFor(env, key, 'site_1')

    expect(permissions).toContain('entries:update')
    expect(permissions).not.toContain('entries:delete')
  })

  test('and cannot widen one past its scopes', async () => {
    // The intersection runs both ways. A site admin issuing a read-only key does not hand it their
    // own authority — `content:read` is the delivery credential whoever created it.
    const key = { ...(await issuer('admin')), role: 'viewer', scopes: ['content:read'] }

    expect(await sitePermissionsFor(env, key, 'site_1')).toEqual(builtinSiteRole('viewer')!.site)
  })

  test('an owner issues a key that works, with no site row of their own', async () => {
    // `owner` is an instance role and has no seeded matrix row. Reading nothing there would leave
    // every key issued by the person most likely to issue one bounded by an empty delegation.
    const key = await issuer('owner')

    expect(await sitePermissionsFor(env, key, 'site_1')).toEqual(builtinSiteRole('editor')!.site)
  })

  test('a key with no issuer keeps behaving exactly as it did', async () => {
    // `created_by` is `on delete set null`, and every key issued before this epic has none.
    // Unrecorded means ungoverned; a default of "nothing" would break every live integration.
    expect(await sitePermissionsFor(env, authoringKey, 'site_1')).toEqual(
      builtinSiteRole('editor')!.site,
    )
  })

  test('deleting the issuer widens their keys back to their scopes, and no further', async () => {
    // Worth stating rather than discovering: the row is nulled by the foreign key, so the key falls
    // back to the bound the deployment ran on for its whole life. It is a widening, and it is the
    // same widening as "this key was issued before #156".
    const key = await issuer('editor')
    await db
      .update(roles)
      .set({ apiKeyPermissions: ['entries:read'] })
      .where(eq(roles.slug, 'editor'))
    expect(await sitePermissionsFor(env, key, 'site_1')).toEqual(['entries:read'])

    await db.delete(users).where(eq(users.id, 'usr_issuer'))
    expect(await sitePermissionsFor(env, { ...key, issuerId: null }, 'site_1')).toEqual(
      builtinSiteRole('editor')!.site,
    )
  })
})

describe('editing a built-in', () => {
  const definer = ['roles:manage', 'sites:access_all']

  test('its site matrix moves, and that is the feature', async () => {
    const updated = await updateRole(
      env,
      'editor',
      { sitePermissions: { site: ['entries:read'], mcp: ['entries:read'], apiKey: [] } },
      definer,
    )

    expect(updated.sitePermissions.site).toEqual(['entries:read'])
    // The instance half is still read from code, not from the row it was just written beside.
    expect(updated.builtin).toBe(true)
    expect(updated.permissions).toEqual([])
  })

  test('its instance half does not', async () => {
    // The half that can leave a deployment with no owner. Refused with a message saying which part
    // is editable, because "built-in roles cannot be changed" is no longer true and would mislead.
    await expect(updateRole(env, 'admin', { name: 'Superuser' }, definer)).rejects.toThrow(
      'only what it may do on a site can be changed',
    )
  })

  test('defining a site matrix requires reaching every site', async () => {
    await expect(
      updateRole(
        env,
        'editor',
        { sitePermissions: { site: ['entries:delete'], mcp: [], apiKey: [] } },
        ['roles:manage'],
      ),
    ).rejects.toThrow('requires access to every site')
  })

  test('a role still assigned on a site cannot be deleted', async () => {
    await db.insert(roles).values({ id: 'rol_x', slug: 'proofreader', name: 'Proofreader' })
    await grant('usr_1', 'proofreader')

    await expect(deleteRole(env, 'proofreader')).rejects.toThrow('still assigned')
  })
})

describe('assigning a custom role to a site (#157)', () => {
  beforeEach(async () => {
    await db.insert(users).values({
      id: 'usr_1',
      email: 'someone@example.com',
      name: 'Someone',
      role: 'editor',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await db.insert(sites).values({ id: 'site_1', slug: 'blog', name: 'Blog' })
    await db.insert(roles).values({
      id: 'rol_proof',
      slug: 'proofreader',
      name: 'Proofreader',
      sitePermissions: ['entries:read', 'entries:update'],
      mcpPermissions: ['entries:read'],
      apiKeyPermissions: [],
    })
  })

  test('a grant can name one, and it resolves to that matrix', async () => {
    await setUserSiteRole(env, 'usr_1', 'site_1', 'proofreader')

    expect(await sitePermissionsFor(env, person(), 'site_1')).toEqual([
      'entries:read',
      'entries:update',
    ])
    expect(await sitePermissionsFor(env, person(), 'site_1', 'mcp')).toEqual(['entries:read'])
  })

  test('and approves nothing until somebody says so', async () => {
    // A custom role is not on the `admin > editor > viewer` ladder, so there is no default to
    // derive — and inventing one out of "may edit entries" is the conflation #59 exists to prevent.
    const grant = await setUserSiteRole(env, 'usr_1', 'site_1', 'proofreader')
    expect(grant.effectiveApprovalLevel).toBe(0)

    const raised = await setUserSiteRole(env, 'usr_1', 'site_1', 'proofreader', 1)
    expect(raised.effectiveApprovalLevel).toBe(1)
  })

  test('a slug nobody defined is refused, rather than stored as no access', async () => {
    await expect(setUserSiteRole(env, 'usr_1', 'site_1', 'ghost')).rejects.toThrow(
      'is not a site role',
    )
  })

  test('and so is owner, which is an instance role', async () => {
    // Granting it per site would be a second way of spelling `sites:access_all`, on a row that
    // cannot carry the instance permissions that phrase actually means.
    await expect(setUserSiteRole(env, 'usr_1', 'site_1', 'owner')).rejects.toThrow(
      'is not a site role',
    )
  })
})

describe('the middlewares', () => {
  function server(actor: Actor, middleware: ReturnType<typeof requireSitePermission>) {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('actor', actor)
      c.set('site', { id: 'site_1', slug: 'blog' } as SiteRow)
      await next()
    })
    app.get('/', middleware, (c) => c.json({ data: 'ok' }))
    app.onError((err, c) => errorResponse(c, err))
    return app.request('/')
  }

  test('requireSitePermission asks for one verb', async () => {
    await grant('usr_1', 'viewer')

    expect((await server(person(), requireSitePermission('entries:read'))).status).toBe(200)

    const refused = await server(person(), requireSitePermission('entries:delete'))
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({
      error: { message: 'Requires "entries:delete" on the "blog" site' },
    })
  })

  test('an editor writes and deletes, and cannot reshape the model', async () => {
    // What `requireSiteRole('editor')` and `requireSiteRole('admin')` used to separate, now said
    // one verb at a time. The rank is gone; this is the whole of what replaced it.
    await grant('usr_1', 'editor')
    expect((await server(person(), requireSitePermission('entries:delete'))).status).toBe(200)
    expect((await server(person(), requireSitePermission('collections:create'))).status).toBe(403)
  })

  test('and refuses a caller with no access with the message it always did', async () => {
    const res = await server(person(), requireSitePermission('entries:read'))

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: { message: 'You do not have access to the "blog" site' },
    })
  })
})
