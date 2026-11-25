-- Who made each revision, so people can see which agent changed what: 'web' for the person in the
-- browser, 'app:<name>' for an OAuth-connected app (the name it registered with), 'token:<name>'
-- for a personal access token. Null for revisions made before this column existed.
ALTER TABLE revisions ADD COLUMN actor text;
CREATE INDEX revisions_created ON revisions (created_at DESC);
