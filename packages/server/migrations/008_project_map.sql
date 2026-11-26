-- Where a project sits in someone's work: the business or group it belongs to, whether it is
-- still being worked on, and the code repositories that make it up (so an agent in any checkout
-- of one of them can find the project).

ALTER TABLE projects ADD COLUMN group_name text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN status text NOT NULL DEFAULT 'active';
ALTER TABLE projects ADD COLUMN repos jsonb NOT NULL DEFAULT '[]'::jsonb;
