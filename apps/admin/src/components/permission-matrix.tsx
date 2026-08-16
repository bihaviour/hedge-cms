import {
  type RolePermissions,
  SITE_PERMISSION_GRID,
  SITE_PERMISSION_ITEMS,
  SITE_PERMISSION_LABELS,
  type SitePermission,
  type SitePermissionSurface,
  type SitePermissionVerb,
} from '@hedge/core'
import { toggleSitePermission } from '@/lib/permission-matrix'

/**
 * What a role may do inside a site, as the grid it is (#151).
 *
 * One row per item, one column group per surface — what the person may do, what an MCP client
 * acting as them may do, what a key they issue may do. The last two are *delegations of the first*,
 * which is why an MCP or API-key box cannot be ticked while its Site box is not: the API refuses
 * the same shape (`rolePermissionsSchema`), and a control that produces a 400 nobody expected is
 * worse than one that explains itself by being unavailable.
 *
 * Unticking a Site box therefore also clears the two beside it, rather than leaving a saved role
 * the server would reject — `toggleSitePermission` in `lib/` is that rule, out there because this
 * workspace has no DOM test setup and it is the part worth pinning.
 *
 * Plain `<input type="checkbox">` rather than a shadcn control: `components/ui/` is CLI output and
 * hand-writing a file there claims a provenance it does not have, and 120 `Switch`es on one page is
 * a different screen from the dense grid this needs to be.
 */

const SURFACES: { key: SitePermissionSurface; label: string; hint: string }[] = [
  { key: 'site', label: 'Site', hint: 'In the admin and over the management API' },
  { key: 'mcp', label: 'MCP', hint: 'An AI client acting as them' },
  { key: 'apiKey', label: 'API key', hint: 'A key they issue' },
]

/** The widest row decides the column layout, so every group lines up down the table. */
const ALL_VERBS: SitePermissionVerb[] = ['create', 'read', 'update', 'delete', 'send']

const VERB_INITIAL: Record<SitePermissionVerb, string> = {
  create: 'C',
  read: 'R',
  update: 'U',
  delete: 'D',
  send: 'S',
}

const ITEM_LABELS: Record<(typeof SITE_PERMISSION_ITEMS)[number], string> = {
  entries: 'Entries',
  media: 'Media',
  collections: 'Collections',
  newsletters: 'Newsletters',
  subscribers: 'Subscribers',
  members: 'Members',
  api_keys: 'API keys',
  analytics: 'Analytics',
}

export function PermissionMatrix({
  value,
  onChange,
  disabled = false,
}: {
  value: RolePermissions
  onChange: (next: RolePermissions) => void
  disabled?: boolean
}) {
  const held = (surface: SitePermissionSurface, permission: SitePermission) =>
    value[surface].includes(permission)

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className="p-2 text-left font-medium">Item</th>
            {SURFACES.map((surface) => (
              <th key={surface.key} className="border-l p-2 text-center font-medium">
                {surface.label}
                <span className="block font-normal text-muted-foreground text-xs">
                  {surface.hint}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SITE_PERMISSION_ITEMS.map((item) => {
            const verbs = SITE_PERMISSION_GRID[item] as readonly SitePermissionVerb[]
            return (
              <tr key={item} className="border-b last:border-0">
                <td className="p-2 font-medium">{ITEM_LABELS[item]}</td>
                {SURFACES.map((surface) => (
                  <td key={surface.key} className="border-l p-2">
                    <div className="flex justify-center gap-3">
                      {ALL_VERBS.map((verb) => {
                        // Not every row is a full CRUD row — analytics is written by a beacon
                        // nobody in the CMS controls, and only newsletters are sent. An absent verb
                        // keeps its slot so the columns still line up.
                        if (!verbs.includes(verb)) {
                          return <span key={verb} className="w-6" aria-hidden="true" />
                        }

                        const permission = `${item}:${verb}` as SitePermission
                        const onSite = held('site', permission)
                        const blocked = surface.key !== 'site' && !onSite

                        return (
                          <label
                            key={verb}
                            className="flex w-6 flex-col items-center gap-1"
                            title={
                              blocked
                                ? `Grant "${SITE_PERMISSION_LABELS[permission]}" on the site first`
                                : SITE_PERMISSION_LABELS[permission]
                            }
                          >
                            <span
                              className={
                                blocked
                                  ? 'text-muted-foreground/50 text-xs'
                                  : 'text-muted-foreground text-xs'
                              }
                            >
                              {VERB_INITIAL[verb]}
                            </span>
                            <input
                              type="checkbox"
                              className="size-4 accent-primary disabled:opacity-40"
                              aria-label={`${SITE_PERMISSION_LABELS[permission]} — ${surface.label}`}
                              disabled={disabled || blocked}
                              checked={held(surface.key, permission)}
                              onChange={(event) =>
                                onChange(
                                  toggleSitePermission(
                                    value,
                                    surface.key,
                                    permission,
                                    event.target.checked,
                                  ),
                                )
                              }
                            />
                          </label>
                        )
                      })}
                    </div>
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
