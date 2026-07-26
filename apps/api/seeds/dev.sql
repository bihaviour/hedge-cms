-- Development seed data. Run with: bun run db:seed
-- Creates two sites — a blog and a docs site — so multi-tenancy is visible from the first run,
-- each with a collection and a few entries. The first user is created through the
-- /api/v1/auth/setup endpoint (or the admin UI's setup screen), not here.
--
-- The two sites also carry different i18n config, so per-site internationalization is visible from
-- the first run: the blog is English-only on UTC, the docs site is bilingual (en + id) on Jakarta
-- time with Indonesian as its default locale.

DELETE FROM entries WHERE collection_id IN ('col_seed_posts', 'col_seed_guides');
DELETE FROM collections WHERE id IN ('col_seed_posts', 'col_seed_guides');
DELETE FROM sites WHERE id IN ('sit_seed_blog', 'sit_seed_docs');

INSERT INTO sites (id, slug, name, description, domain, allow_member_signup, locales, default_locale, timezone, created_at, updated_at)
VALUES
  ('sit_seed_blog', 'blog', 'Blog', 'Articles and release notes', NULL, 1, json('["en"]'), 'en', 'UTC', datetime('now'), datetime('now')),
  ('sit_seed_docs', 'docs', 'Documentation', 'Product documentation', NULL, 0, json('["en","id"]'), 'id', 'Asia/Jakarta', datetime('now'), datetime('now'));

INSERT INTO collections (id, site_id, slug, name, description, kind, fields, created_at, updated_at)
VALUES (
  'col_seed_posts',
  'sit_seed_blog',
  'posts',
  'Posts',
  'Blog posts and articles',
  'multiple',
  json('[
    {"kind":"text","name":"title","label":"Title","required":true,"localized":false,"maxLength":200},
    {"kind":"text","name":"excerpt","label":"Excerpt","required":false,"localized":false,"multiline":true,"maxLength":300},
    {"kind":"richtext","name":"body","label":"Body","required":false,"localized":false,"format":"markdown"},
    {"kind":"media","name":"cover","label":"Cover image","required":false,"localized":false,"accept":["image/*"],"multiple":false},
    {"kind":"select","name":"category","label":"Category","required":false,"localized":false,"multiple":false,
      "options":[{"value":"engineering","label":"Engineering"},{"value":"product","label":"Product"}]}
  ]'),
  datetime('now'),
  datetime('now')
);

-- Same `posts`-shaped content on a different site: slugs are unique per site, not per instance.
INSERT INTO collections (id, site_id, slug, name, description, kind, fields, created_at, updated_at)
VALUES (
  'col_seed_guides',
  'sit_seed_docs',
  'posts',
  'Guides',
  'How-to guides for the documentation site',
  'multiple',
  json('[
    {"kind":"text","name":"title","label":"Title","required":true,"localized":false,"maxLength":200},
    {"kind":"richtext","name":"body","label":"Body","required":false,"localized":false,"format":"markdown"}
  ]'),
  datetime('now'),
  datetime('now')
);

INSERT INTO entries (id, collection_id, slug, status, visibility, locale, data, published_at, created_at, updated_at)
VALUES
  (
    'ent_seed_hello',
    'col_seed_posts',
    'hello-world',
    'published',
    'public',
    'en',
    json('{"title":"Hello world","excerpt":"The first post on this Hedge instance.","body":"# Hello world\n\nEdit this entry in the admin, or fetch it from the delivery API.","category":"engineering"}'),
    datetime('now'),
    datetime('now'),
    datetime('now')
  ),
  (
    'ent_seed_draft',
    'col_seed_posts',
    'a-draft-post',
    'draft',
    'public',
    'en',
    json('{"title":"A draft post","excerpt":"Drafts are invisible to the delivery API.","body":"Still cooking.","category":"product"}'),
    NULL,
    datetime('now'),
    datetime('now')
  ),
  -- Published, but the delivery API returns it with `locked: true` and no `data` until the
  -- caller presents a member token for the blog site.
  (
    'ent_seed_members',
    'col_seed_posts',
    'members-only-deep-dive',
    'published',
    'members',
    'en',
    json('{"title":"Members only: a deep dive","excerpt":"Visible to anyone, readable by members.","body":"The part behind the sign-in wall.","category":"engineering"}'),
    datetime('now'),
    datetime('now'),
    datetime('now')
  ),
  (
    'ent_seed_guide',
    'col_seed_guides',
    'getting-started',
    'published',
    'public',
    'en',
    json('{"title":"Getting started","body":"This entry lives on the docs site, not the blog."}'),
    datetime('now'),
    datetime('now'),
    datetime('now')
  ),
  -- The Indonesian translation of the same guide: same slug, different locale. The delivery API
  -- serves this one by default because `id` is the docs site's default locale.
  (
    'ent_seed_guide_id',
    'col_seed_guides',
    'getting-started',
    'published',
    'public',
    'id',
    json('{"title":"Memulai","body":"Entri ini hidup di situs dokumentasi, bukan di blog."}'),
    datetime('now'),
    datetime('now'),
    datetime('now')
  );
