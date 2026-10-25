-- Smart logo position: per video, move the logo to the corner that covers the
-- least (text, faces, detail). The saved position is the preferred corner.
ALTER TABLE tenant_branding ADD COLUMN smart_position boolean NOT NULL DEFAULT false;
