-- Storage quotas (audit D2). storage_bytes is the logical size of everything a user stores: current
-- page contents plus kept revisions. It is kept up to date inside every write transaction.
ALTER TABLE users ADD COLUMN storage_bytes bigint NOT NULL DEFAULT 0;

-- How a revision was made, so a run of appends can share one revision.
ALTER TABLE revisions ADD COLUMN via text NOT NULL DEFAULT 'write';

UPDATE users u SET storage_bytes = COALESCE((SELECT sum(p.size) FROM pages p JOIN projects pr ON pr.id = p.project_id WHERE pr.user_id = u.id), 0) + COALESCE((SELECT sum(r.size) FROM revisions r JOIN pages p ON p.id = r.page_id JOIN projects pr ON pr.id = p.project_id WHERE pr.user_id = u.id), 0);
