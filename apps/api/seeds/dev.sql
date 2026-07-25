-- Development seed data. Run with: bun run db:seed
-- Creates one "Posts" collection with a couple of entries. The first user is created through
-- the /api/v1/auth/setup endpoint (or the admin UI's setup screen), not here.

DELETE FROM entries WHERE collection_id = 'col_seed_posts';
DELETE FROM collections WHERE id = 'col_seed_posts';

INSERT INTO collections (id, slug, name, description, kind, fields, created_at, updated_at)
VALUES (
  'col_seed_posts',
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

INSERT INTO entries (id, collection_id, slug, status, locale, data, published_at, created_at, updated_at)
VALUES
  (
    'ent_seed_hello',
    'col_seed_posts',
    'hello-world',
    'published',
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
    'en',
    json('{"title":"A draft post","excerpt":"Drafts are invisible to the delivery API.","body":"Still cooking.","category":"product"}'),
    NULL,
    datetime('now'),
    datetime('now')
  );
