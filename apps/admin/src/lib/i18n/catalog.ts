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
  'common.error': 'Something went wrong',
  'common.done': 'Done',

  // The pagination bar under every table (#124). Two singular/plural keys rather than one with a
  // count in it: English inflects the noun and Indonesian does not, which a placeholder cannot say.
  'pagination.showing': 'Showing {from}–{to} of {total}',
  'pagination.rowsOne': '1 row',
  'pagination.rowsMany': '{total} rows',
  'pagination.page': 'Page {page}',
  'pagination.rowsPerPage': 'Rows per page',
  'pagination.previous': 'Previous',
  'pagination.next': 'Next',

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
  'nav.roles': 'Roles',
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
  'label.admin': 'Admin',
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
  // "Settings" rather than "Fields": the page it opens also carries the approval workflow and the
  // delete control, so naming it after one section undersells what is behind it.
  'entries.settings': 'Settings',
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
  'entries.colLanguages': 'Languages',
  'entries.addTranslation': 'Not translated yet',
  'entries.colUpdated': 'Updated',
  'entries.colViews': 'Views',
  'entries.colTrend': 'Trend',
  'entries.colShares': 'Share clicks',
  'entries.trafficWindow': 'Views, trend and share clicks cover the last {days} days.',
  'entries.trafficLink': 'See all analytics',
  'entries.rowActions': 'Actions',
  'entries.actionAnalytics': 'View analytics',
  'entries.actionEdit': 'Edit entry',
  'entries.actionPreview': 'Preview',
  'entries.actionOpenSite': 'Open on the website',
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
  'translations.title': 'Languages',
  'translations.hint':
    'This entry and its translations are one piece, with one version per language.',
  'translations.notWritten': 'not written yet',
  'translations.link': 'Link as a translation',
  'translations.linkPlaceholder': 'Choose an entry to link…',
  'translations.linkHint':
    'For a translation that was created as a separate entry. Both keep their own slug, status and history.',
  'translations.linked': 'Linked as a translation',
  'translations.unlink': 'Make this a separate entry',
  'translations.unlinked': 'Now a separate entry',
  'editor.approvalNotice':
    'This collection needs {levels} approval(s) before an entry can be published. Save your work as a version and submit it for review.',
  'editor.codeOnSave': 'Assigned when you save',

  // Revision history — the backward-looking half of the editor's sidebar.
  'revisions.title': 'History',
  'revisions.previewTitle': 'Revision preview',
  'revisions.restore': 'Restore this revision',
  'revisions.restored': 'Revision restored',
  'revisions.diffHint': 'Fields that differ from the current entry:',

  // Entry versions — the forward-looking half. A version is a proposed future state of the entry.
  'versions.title': 'Versions',
  'versions.start': 'New',
  'versions.startAction': 'Start version',
  'versions.empty': 'No versions yet. Start one to propose changes without touching what is live.',
  'versions.created': 'Version created',
  'versions.newTitle': 'Start a new version',
  'versions.newDescription':
    'A version forks this entry as it stands now. Editing it changes nothing live until it is published.',
  'versions.summary': 'What does this version do?',
  'versions.summaryPlaceholder': 'Added the interview section',
  'versions.summaryHint': 'One line. It is how a reviewer tells several open versions apart.',
  'versions.unknownAuthor': 'Unknown',
  'versions.cleared': '{cleared}/{required} approved',
  'versions.stale': 'Stale',
  'versions.staleHint':
    'This version was written against an older copy of the entry, which has changed since. Publishing it replaces those changes.',
  'versions.statusDraft': 'Draft',
  'versions.statusInReview': 'In review',
  'versions.statusChangesRequested': 'Changes requested',
  'versions.statusApproved': 'Approved',
  'versions.statusPublished': 'Published',
  'versions.statusDiscarded': 'Discarded',
  'versions.compareAgainst': 'Compare against',
  'versions.compareLive': 'The live entry',
  'versions.diffIdentical': 'Nothing differs between these two.',
  'versions.diffBefore': 'Before',
  'versions.diffAfter': 'This version',
  'versions.change.changed': 'changed',
  'versions.change.added': 'added',
  'versions.change.removed': 'removed',
  'versions.trail': 'Review trail',
  'versions.trailEntry': '{name} at level {level}',
  'versions.comment': 'Note for the author',
  'versions.commentPlaceholder': 'What needs to change, or why this is good to go',
  'versions.submit': 'Submit for review',
  'versions.discard': 'Discard',
  'versions.approve': 'Approve',
  'versions.reject': 'Request changes',
  'versions.publish': 'Publish this version',
  'versions.cannotReviewOwn': 'You wrote this version, so somebody else has to review it.',
  'versions.alreadyDecided':
    'You have already reviewed this version — the next level needs someone else.',
  'versions.levelTooLow': 'Approving at level {level} needs a higher approval level than yours.',
  'versions.done.submit': 'Submitted for review',
  'versions.done.approve': 'Version approved',
  'versions.done.reject': 'Sent back to the author',
  'versions.done.publish': 'Version published',
  'versions.done.discard': 'Version discarded',

  // Review inbox.
  'review.title': 'Review',
  'review.subtitle': 'Versions waiting on you, across this site.',
  'review.emptyTitle': 'Nothing waiting',
  'review.emptyDescription': 'No version on this site is waiting for your approval right now.',
  'review.colVersion': 'Version',
  'review.colEntry': 'Entry',
  'review.colAuthor': 'Author',
  'review.colSubmitted': 'Submitted',
  'review.open': 'Open',
  'review.noAuthority':
    'You do not approve versions on this site. An admin can change that from Users → Site access.',
  'nav.review': 'Review',
  'label.review': 'Review',

  // Per-user approval authority, edited beside the site role.
  'users.approvalLevel': 'Approvals',
  'users.approvalInherit': 'From role ({level})',
  'users.approvalNone': 'None',
  'users.approvalLevel1': 'Level 1',
  'users.approvalLevel2': 'Level 1 and 2',
  'users.approvalAllSites': 'Level 2 on every site',
  'users.approvalHint':
    'Which review levels this person can sign off on for this site. "From role" follows their site role — editors approve level 1, admins both.',

  // Collection settings: the approval selector.
  'collections.approvalTitle': 'Publishing',
  'collections.approvalLabel': 'Approvals before publishing',
  'collections.approvalOff': 'Off — anyone who can edit can publish',
  'collections.approvalOne': 'One approval',
  'collections.approvalTwo': 'Two approvals',
  'collections.approvalHint':
    'With approvals on, an entry in this collection can no longer be published by editing it directly. Changes are written as a version, reviewed by somebody other than their author, and published from there.',
  'collections.settingsTitle': '{name} settings',
  'collections.settingsDescription':
    'Define the shape of entries in this collection, and how they are published.',

  // Shown instead of the Save and Delete buttons to someone who can fill this collection but not
  // reshape it. Says which access is missing, so it reads as a permission rather than a bug.
  'collections.readOnly':
    'You can see how this collection is put together, but changing or deleting it needs admin access to this site.',

  // Deleting a collection. The blast radius is named in the copy because it is the whole point:
  // this is the only delete in the admin that takes content the operator never sees on the page
  // they are standing on.
  'collections.delete': 'Delete collection',
  'collections.deleteTitle': 'Delete "{name}"?',
  'collections.deleteDescription':
    'Every entry in this collection is deleted with it, along with their revisions and pending versions. Anything published from it stops resolving. This cannot be undone.',
  'collections.deleteConfirmLabel': 'Type {slug} to confirm',
  'collections.deleted': 'Collection deleted',

  // Authenticated preview — seeing a saved but unpublished entry in the website's own layout.
  'preview.action': 'Preview',
  'preview.opening': 'Opening…',
  'preview.title': 'Preview',
  'preview.setUp': 'Set up preview',
  'preview.notConfigured': 'This site has no preview URL yet — add one in site settings.',
  'preview.openTab': 'Open in a new tab',
  'preview.framedHint':
    'Showing what is saved, not unsaved edits. If this pane stays blank, your website is refusing to be framed — open it in a tab instead.',

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
  'media.uploadFile': 'Upload files',
  'media.uploaded': 'Uploaded',
  'media.dropHere': 'Drop the files to upload them',
  'media.deleted': 'Deleted',
  'media.emptyTitle': 'No files yet',
  'media.emptyDescription': 'Upload images and documents to reference them from your entries.',
  'media.deleteAria': 'Delete {filename}',
  'media.loadMore': 'Load more',
  'media.search': 'Search filenames and alt text…',
  'media.noMatchTitle': 'Nothing matches',
  'media.noMatchDescription': "No file in this site's library matches that search.",
  'media.clearFilters': 'Clear filters',
  'media.typeAll': 'All files',
  'media.typeImage': 'Images',
  'media.typeVideo': 'Video',
  'media.typeDocument': 'Documents',
  'media.actionsAria': 'Actions for {filename}',
  'media.copyUrl': 'Copy URL',
  'media.copyKey': 'Copy key',
  'media.copiedUrl': 'URL copied to clipboard',
  'media.copiedKey': 'Key copied to clipboard',
  'media.editDetails': 'Edit details',
  'media.editTitle': 'Edit details',
  'media.editDescription':
    'The object key never changes — renaming here changes the display name only, so nothing already pointing at this file breaks.',
  'media.filename': 'Filename',
  'media.alt': 'Alt text',
  'media.altPlaceholder': 'Describe the image for anyone who cannot see it',
  'media.altHint':
    'Served alongside the image URL on the delivery API, so a frontend can render it without a second request.',
  'media.noAlt': 'No alt text',
  'media.deleteTitle': 'Delete {filename}?',
  'media.deleteDescription':
    'The file is removed from R2 for good. Any entry or published page still pointing at it will show a broken image.',

  // The upload queue, shared by the media library and the picker.
  'upload.progressTitle': 'Uploading — {done} of {total} done',
  'upload.finishedTitle': 'Uploaded {done} of {total}',
  'upload.clearFinished': 'Clear finished',
  'upload.progressAria': 'Upload progress for {filename}',
  'upload.retryAria': 'Retry {filename}',
  'upload.dismissAria': 'Dismiss {filename}',
  'upload.tooLarge': 'Larger than {size}',
  'upload.unsupportedType': 'That file type cannot be uploaded',
  'upload.notAccepted': 'Not an accepted file type for this field',
  'upload.doneOne': 'Uploaded {filename}',
  'upload.doneMany': 'Uploaded {count} files',
  'upload.someFailed': 'Uploaded {count} of {total} — the rest are listed below',
  'upload.allFailed': 'Nothing uploaded',

  // The media and reference pickers, and the fields they replace.
  'picker.chooseMedia': 'Choose media',
  'picker.chooseMediaOne': 'Pick a file, or upload a new one.',
  'picker.chooseMediaMany':
    'Pick one or more files, or upload new ones. They are stored in the order you pick them.',
  'picker.chooseEntry': 'Choose an entry',
  'picker.chooseEntryDescription': 'From “{collection}”, in {locale}. {arity}',
  'picker.arityOne': 'One entry.',
  'picker.arityMany': 'Stored in the order you pick them.',
  'picker.searchEntries': 'Search by slug…',
  'picker.select': 'Select',
  'picker.selectCount': 'Select {count}',
  'picker.replace': 'Replace',
  'picker.nothingChosen': 'Nothing chosen yet',
  'picker.nothingLinked': 'Nothing linked yet',
  'picker.chooseEntryAction': 'Choose entry',
  'picker.manual': 'Enter a value manually',
  'picker.mediaKeyPlaceholder': 'Media key, e.g. blog/2026/07/photo.jpg',
  'picker.entrySlugPlaceholder': 'Entry slug in “{collection}”',
  'picker.add': 'Add',
  'picker.moveEarlier': 'Move {label} earlier',
  'picker.moveLater': 'Move {label} later',
  'picker.removeItem': 'Remove {label}',
  'picker.inCollection': 'in “{collection}”',
  'picker.noEntries': 'No entries in “{collection}” yet',
  'picker.noMatch': 'Nothing matches that search',
  'picker.tagsPlaceholder': 'Choose or type…',
  'picker.createTag': 'Create “{value}”',
  'picker.allTagsUsed': 'Every value is already chosen',
  'picker.localeOnly': 'Only entries in the {locale} locale are listed.',
  'picker.draftWarning':
    'One of these is not published. The reference saves fine, but the delivery API serves nothing for it until that entry publishes.',
  'picker.altFor': 'Alt text for {filename}',
  'picker.altPlaceholder': 'Describe the image for screen readers',
  'picker.dropHint': 'Drop files here, or use Upload. Up to {size} each.',
  'meta.socialImage': 'Social image',
  'meta.socialImagePlaceholder': 'Media key or URL',
  'common.choose': 'Choose',

  // API keys table extras.
  'apiKeys.colPrefix': 'Prefix',
  'apiKeys.colLastUsed': 'Last used',
  'apiKeys.revoked': 'Key revoked',
  'apiKeys.revoke': 'Revoke',
  'apiKeys.revokeAria': 'Revoke {name}',
  'apiKeys.rename': 'Rename',
  'apiKeys.renameAria': 'Rename {name}',
  'apiKeys.rotate': 'Rotate',
  'apiKeys.rotateAria': 'Rotate {name}',

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
    'Keys the delivery API accepts for this site. The secret is shown once — rotate a key to replace one you have lost.',
  'apiKeys.new': 'New key',
  'apiKeys.colName': 'Name',
  'apiKeys.colScopes': 'Scopes',
  'apiKeys.colCreated': 'Created',
  'apiKeys.emptyTitle': 'No API keys',
  'apiKeys.emptyDescription': 'Create a key to read this site from the delivery API.',

  // Account page.
  'account.title': 'Account',
  'account.subtitle': 'Your profile, password, sessions, and connected clients.',
  'account.save': 'Save changes',
  'account.changePassword': 'Change password',
  'account.uiLanguage': 'Admin language',
  'account.uiLanguageHint':
    'The language this admin interface is shown in. A preference for you, not the site.',

  // Dashboard and analytics.
  'nav.overview': 'Overview',
  'nav.dashboard': 'Dashboard',
  'nav.analytics': 'Analytics',
  'label.dashboard': 'Dashboard',
  'label.analytics': 'Analytics',

  'dash.title': 'Dashboard',
  'dash.subtitle': 'How {site} is doing, over the last 30 days.',
  'dash.viewAnalytics': 'All analytics',
  'dash.topArticles': 'Top articles',
  'dash.topArticlesEmpty': 'No article has been read in this period yet.',
  'dash.recentlyUpdated': 'Recently updated',
  'dash.recentlyUpdatedEmpty': 'Nothing has been edited yet.',
  'dash.lastNewsletter': 'Last newsletter',
  'dash.lastNewsletterEmpty': 'No newsletter has been sent from this site.',
  'dash.newsletterSent': 'Sent {date} to {count} recipients',

  // The empty state that matters most: no data because nothing is reporting any.
  'analytics.notCollectingTitle': 'No website traffic yet',
  'analytics.notCollectingBody':
    'Hedge never sees your readers on its own — the website has to report a pageview. Add the one-line snippet to your site and numbers start appearing here.',
  'analytics.notCollectingAction': 'How to add it',
  'analytics.snippetTitle': 'The snippet',
  'analytics.snippetHint':
    'Paste this once, in your site’s template. It sets no cookie, reads no storage, and honours Do Not Track.',
  'analytics.copySnippet': 'Copy snippet',
  'analytics.snippetCopied': 'Snippet copied to clipboard',

  'analytics.title': 'Analytics',
  'analytics.subtitle': 'What readers did on {site}.',
  'analytics.rangeLabel': 'Range',
  'analytics.range7': 'Last 7 days',
  'analytics.range30': 'Last 30 days',
  'analytics.range90': 'Last 90 days',
  'analytics.range365': 'Last 12 months',
  'analytics.comparedTo': 'vs previous period',
  'analytics.timezoneNote': 'Days are counted in the site timezone ({timezone}).',
  'analytics.startsOn':
    'This range reaches back before tracking started on {date}. Earlier days are empty because nothing was measured, not because nobody read anything.',

  'analytics.views': 'Views',
  'analytics.pages': 'Pages read',
  'analytics.referrals': 'From other sites',
  'analytics.shareIntents': 'Share clicks',
  'analytics.previousPeriod': 'Previous period',
  'analytics.trafficTitle': 'Traffic',

  'analytics.entriesTitle': 'Top 10 articles',
  'analytics.colArticle': 'Article',
  'analytics.colViews': 'Views',
  'analytics.colTrend': 'Trend',
  'analytics.colShares': 'Share clicks',
  'analytics.sortViews': 'Most viewed',
  'analytics.sortTrend': 'Biggest change',
  'analytics.sortShares': 'Most shared',
  'analytics.noEntryMatch': 'not an entry',
  'analytics.entriesEmpty': 'Nothing was read in this period.',

  'analytics.referrersTitle': 'Where readers come from',
  'analytics.referrersCaveat':
    'A large “direct” share is mostly browsers that sent no referrer at all — not readers typing your URL.',
  'analytics.groupSearch': 'Search',
  'analytics.groupSocial': 'Social',
  'analytics.groupDirect': 'Direct',
  'analytics.groupOther': 'Other',
  'analytics.referrersEmpty': 'No inbound traffic recorded in this period.',

  'analytics.sharesTitle': 'Shares',
  'analytics.sharesCaveat':
    'These are clicks on your own share and copy-link buttons, not counts reported by any platform — X, Facebook and LinkedIn all stopped publishing those. Read it as intent to share, never as “shared this many times”.',
  'analytics.sharesEmpty':
    'No share clicks recorded. Call hedge(‘share’, ‘x’) from your share buttons to count them.',

  'analytics.newslettersTitle': 'Newsletter',
  'analytics.newslettersEmpty': 'No newsletter was sent in this period.',
  'analytics.subscribers': 'Subscribers',
  'analytics.subscribersGained': 'Joined',
  'analytics.subscribersLost': 'Left',
  'analytics.audienceTitle': 'Audience',
  'analytics.colCampaign': 'Campaign',
  'analytics.colSent': 'Sent',
  'analytics.colAccepted': 'Accepted',
  'analytics.colFailed': 'Failed',
  'analytics.acceptedNote':
    '“Accepted” means the mail provider took the message. Cloudflare Email Sending reports no bounces or opens, so nothing here claims a message reached an inbox.',
  'analytics.noOpensNote':
    'Opens are not tracked. Apple Mail prefetches images, so an open rate counts Apple rather than readers.',

  'analytics.entryTitle': 'Traffic for “{title}”',
  'analytics.entryViews': 'Views in this period',
  'analytics.entryShares': 'Share clicks',
  'analytics.viewAnalytics': 'Analytics',
  'analytics.backToAll': 'All articles',
  'analytics.backToEdit': 'Edit article',

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
