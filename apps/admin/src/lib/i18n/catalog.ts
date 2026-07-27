/**
 * The admin UI's own message catalog. This is a *viewer* preference — which language an operator
 * reads the chrome in — and is deliberately separate from a site's content locales and timezone,
 * which are per-site config (see `@hedge/core`'s `i18n.ts`). One person may manage an English blog
 * and an Indonesian docs site in the same portal and should read the buttons in their language on
 * both.
 *
 * `en` is the source of truth: its keys define `MessageKey`, and every other catalog is a
 * `Partial` of it, so a missing translation falls back to English rather than showing a raw key.
 * Adding a string to the UI means adding it here first.
 */

export const en = {
  // Shared verbs and nouns, reused across pages.
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.cancel': 'Cancel',
  'common.create': 'Create',
  'common.creating': 'Creating…',
  'common.delete': 'Delete',
  'common.remove': 'Remove',
  'common.edit': 'Edit',
  'common.back': 'Back',
  'common.loading': 'Loading…',
  'common.search': 'Search',
  'common.none': '—',
  'common.optional': 'optional',
  'common.saved': 'Saved',
  'common.created': 'Created "{name}"',
  'common.close': 'Close',
  'common.actions': 'Actions',

  // Language switcher.
  'language.label': 'Language',
  'language.change': 'Change language',

  // Theme toggle (admin appearance, a per-viewer preference).
  'theme.label': 'Theme',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.system': 'System',

  // Sidebar navigation groups and items.
  'nav.content': 'Content',
  'nav.audience': 'Audience',
  'nav.settings': 'Settings',
  'nav.collections': 'Collections',
  'nav.media': 'Media',
  'nav.members': 'Members',
  'nav.configuration': 'Configuration',
  'nav.siteSettings': 'Site settings',
  'nav.sites': 'Sites',
  'nav.users': 'Users',
  'nav.apiKeys': 'API keys',
  'nav.about': 'About & updates',
  'nav.updates': 'Updates',
  'nav.account': 'Account',
  'nav.signOut': 'Sign out',
  'nav.manageSites': 'Manage sites',
  'nav.sitesTagline': 'headless + edge CMS',
  'nav.siteCount': '{count} sites',

  // Configuration page tabs.
  'config.tabOverview': 'Overview',
  'config.tabApi': 'API',
  'config.tabEmail': 'Email',

  // Breadcrumb / route labels.
  'label.collections': 'Collections',
  'label.media': 'Media',
  'label.members': 'Members',
  'label.settings': 'Settings',
  'label.configuration': 'Configuration',
  'label.sites': 'Sites',
  'label.users': 'Users',
  'label.apiKeys': 'API keys',
  'label.entries': 'Entries',
  'label.new': 'New',
  'label.account': 'Account',
  'label.about': 'About',

  // Newsletter and email-management navigation and breadcrumbs (added alongside those features).
  'nav.newsletters': 'Newsletters',
  'nav.newsletterTemplates': 'Newsletter templates',
  'nav.subscribers': 'Subscribers',
  'nav.email': 'Email',
  'nav.communication': 'Communication',
  'nav.emailSettings': 'Settings',
  'nav.emailTemplates': 'Templates',
  'nav.emailLog': 'Log',
  'label.newsletters': 'Newsletters',
  'label.subscribers': 'Subscribers',
  'label.email': 'Email',
  'label.templates': 'Templates',
  'label.log': 'Log',

  // Empty-state shown to someone with no site access.
  'sites.emptyTitle': 'No sites yet',
  'sites.emptyAdmin': 'Create a site to start adding content.',
  'sites.emptyGuest': 'You have not been given access to a site yet. Ask an admin to grant it.',
  'sites.goToSites': 'Go to Sites',

  // Sites page.
  'sites.title': 'Sites',
  'sites.subtitle':
    'Every site is its own content namespace — collections, media, keys and members.',
  'sites.new': 'New site',
  'sites.colName': 'Name',
  'sites.colSlug': 'Slug',
  'sites.colDomain': 'Domain',
  'sites.colLocales': 'Locales',
  'sites.colMemberSignup': 'Member signup',
  'sites.current': 'Current',
  'sites.switch': 'Switch',
  'sites.deleted': 'Site deleted',
  'sites.deleteConfirm': 'Delete "{name}"? Its collections, entries and members go too.',
  'sites.allowSignupAria': 'Allow member signup on {name}',
  'sites.deleteAria': 'Delete {name}',

  // New-site dialog.
  'sites.newTitle': 'New site',
  'sites.newDescription':
    'A blog, a documentation site, a landing page — each keeps its own content.',
  'sites.fieldName': 'Name',
  'sites.fieldSlug': 'Slug',
  'sites.slugHint': 'Sent as the X-Hedge-Site header to pick this site.',
  'sites.fieldDomain': 'Domain (optional)',
  'sites.domainHint': 'Requests arriving on this hostname resolve to this site automatically.',
  'sites.createSite': 'Create site',

  // Site localization (per-site i18n config).
  'sites.localization': 'Localization',
  'sites.localizationAria': 'Localization for {name}',
  'sites.localizationTitle': 'Localization',
  'sites.localizationDescription':
    "This site's content locales, the one served by default, and the timezone its dates are shown in.",
  'sites.localesLabel': 'Content locales',
  'sites.localesHint': 'The languages this site publishes. Each entry lives once per locale.',
  'sites.addLocale': 'Add locale',
  'sites.defaultLocaleLabel': 'Default locale',
  'sites.defaultLocaleHint': 'Served by the delivery API when a request names no locale.',
  'sites.timezoneLabel': 'Timezone',
  'sites.timezoneHint': 'How timestamps are shown across the admin for this site.',
  'sites.localizationSaved': 'Localization updated',
  'sites.removeLocaleAria': 'Remove {locale}',
  'sites.localePickerPlaceholder': 'Choose a language…',

  // Entries list.
  'entries.fallbackTitle': 'Entries',
  'entries.fields': 'Fields',
  'entries.newEntry': 'New entry',
  'entries.searchPlaceholder': 'Search by slug…',
  'entries.allStatuses': 'All statuses',
  'entries.allLocales': 'All locales',
  'entries.status': 'Status',
  'entries.statusDraft': 'Draft',
  'entries.statusPublished': 'Published',
  'entries.statusArchived': 'Archived',
  'entries.colTitle': 'Title',
  'entries.colStatus': 'Status',
  'entries.colVisibility': 'Visibility',
  'entries.colLocale': 'Locale',
  'entries.colUpdated': 'Updated',
  'entries.visMembers': 'Members',
  'entries.visPublic': 'Public',
  'entries.emptyTitle': 'No entries',
  'entries.emptyDescription': 'Nothing here yet — create the first entry for this collection.',

  // Entry editor.
  'editor.newEntry': 'New entry',
  'editor.deleteEntry': 'Delete entry',
  'editor.entryDeleted': 'Entry deleted',
  'editor.noFields': 'This collection has no fields yet.',
  'editor.addFields': 'Add some',
  'editor.status': 'Status',
  'editor.visibility': 'Visibility',
  'editor.visPublic': 'Public',
  'editor.visMembers': 'Members only',
  'editor.visMembersHint':
    'The delivery API returns this entry without its content until a member signs in.',
  'editor.visPublicHint': 'Anyone with a delivery API key can read this entry once published.',
  'editor.slug': 'Slug',
  'editor.slugAuto': 'auto-generated',
  'editor.created': 'Created',
  'editor.updated': 'Updated',
  'editor.published': 'Published',
  'editor.locale': 'Locale',
  'editor.localeHint': 'Which language variant of this entry you are editing.',
  'editor.translationMissing': 'No {locale} translation yet — saving creates one.',

  // Collections page.
  'collections.title': 'Collections',
  'collections.subtitle': 'Content types on this site.',
  'collections.new': 'New collection',
  'collections.emptyTitle': 'No collections yet',
  'collections.emptyDescription':
    'A collection defines the shape of a content type — posts, pages, authors, anything.',
  'collections.emptyAction': 'Create your first collection',
  'collections.metaSingle': '{count} fields · single entry',
  'collections.metaMultiple': '{count} fields · multiple entries',
  'collections.newTitle': 'New collection',
  'collections.newDescription': 'You can add and edit fields once the collection exists.',
  'collections.name': 'Name',
  'collections.apiSlug': 'API slug',
  'collections.type': 'Type',
  'collections.typeMultiple': 'Multiple entries',
  'collections.typeSingle': 'Single entry (settings, landing page)',

  // Media page.
  'media.title': 'Media',
  'media.subtitle': 'Files stored in R2. Up to {size} each.',
  'media.upload': 'Upload',
  'media.uploadFile': 'Upload a file',
  'media.uploaded': 'Uploaded',
  'media.deleted': 'Deleted',
  'media.emptyTitle': 'No files yet',
  'media.emptyDescription': 'Upload images and documents to reference them from your entries.',
  'media.deleteAria': 'Delete {filename}',
  'media.loadMore': 'Load more',

  // API keys table extras.
  'apiKeys.colPrefix': 'Prefix',
  'apiKeys.colLastUsed': 'Last used',
  'apiKeys.revoked': 'Key revoked',
  'apiKeys.revokeAria': 'Revoke {name}',

  // Users table extras.
  'users.colSiteAccess': 'Site access',
  'users.allSites': 'All sites',
  'users.manage': 'Manage',

  // Members page.
  'members.title': 'Members',
  'members.subtitle': 'People who sign in on this site to read members-only content.',
  'members.invite': 'Invite member',
  'members.inviteAction': 'Invite a member',
  'members.searchPlaceholder': 'Search by email…',
  'members.pending': 'Pending',
  'members.colEmail': 'Email',
  'members.colName': 'Name',
  'members.colStatus': 'Status',
  'members.colLastSignIn': 'Last sign-in',
  'members.emptyTitle': 'No members yet',

  // Users page.
  'users.title': 'Users',
  'users.subtitle': 'Operators who can sign in to this admin.',
  'users.invite': 'Invite user',
  'users.colName': 'Name',
  'users.colEmail': 'Email',
  'users.colRole': 'Role',
  'users.colAdded': 'Added',
  'users.pending': 'Pending',

  // API keys page.
  'apiKeys.title': 'API keys',
  'apiKeys.subtitle':
    'Keys the delivery API accepts for this site. Show the secret once, at creation.',
  'apiKeys.new': 'New key',
  'apiKeys.colName': 'Name',
  'apiKeys.colScopes': 'Scopes',
  'apiKeys.colCreated': 'Created',
  'apiKeys.emptyTitle': 'No API keys',
  'apiKeys.emptyDescription': 'Create a key to read this site from the delivery API.',

  // Account page.
  'account.title': 'Account',
  'account.subtitle': 'Your profile, password and active sessions.',
  'account.save': 'Save changes',
  'account.changePassword': 'Change password',
  'account.uiLanguage': 'Admin language',
  'account.uiLanguageHint':
    'The language this admin interface is shown in. A preference for you, not the site.',

  // Login page.
  'login.title': 'Sign in',
  'login.subtitle': 'Sign in to the Hedge admin.',
  'login.email': 'Email',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.forgot': 'Forgot your password?',
} as const

export type MessageKey = keyof typeof en

/** Any catalog other than English is allowed to be incomplete — English backfills the gaps. */
export type Catalog = Partial<Record<MessageKey, string>>

export interface UiLanguage {
  code: string
  /** Shown in the language switcher, in the language's own name. */
  label: string
}

/** The languages the admin ships translations for. Add a catalog and an entry here to add one. */
export const UI_LANGUAGES: readonly UiLanguage[] = [
  { code: 'en', label: 'English' },
  { code: 'id', label: 'Bahasa Indonesia' },
]
