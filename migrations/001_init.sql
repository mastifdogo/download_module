-- Runs once, as the module's own database role, in its own schema (mod_downloads).
-- Files sent from the browser (the Send to Ledger extension) wait here until
-- someone forwards them (to Auto sort, or Ledger's CSV files), archives or deletes them.

CREATE TABLE files (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255),
    content_type text        NOT NULL DEFAULT '',
    size_bytes   bigint      NOT NULL CHECK (size_bytes >= 0),
    sha256       text,
    status       text        NOT NULL DEFAULT 'uploading'
                 CHECK (status IN ('uploading', 'new', 'sent', 'archived')),
    source_url   text        NOT NULL DEFAULT '',
    note         text        NOT NULL DEFAULT '',
    received_by  text        NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    sent_to      text        NOT NULL DEFAULT '',   -- e.g. "Auto sort statement #12"
    sent_link    text        NOT NULL DEFAULT '',   -- a path inside Ledger
    sent_by      text,
    sent_at      timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_status ON files (status, received_at DESC);
CREATE INDEX files_sha256 ON files (sha256) WHERE sha256 IS NOT NULL;

-- A file's bytes, in pieces small enough for Ledger's 1 MiB request limit.
CREATE TABLE file_chunks (
    file_id bigint  NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    idx     integer NOT NULL CHECK (idx >= 0),
    data    bytea   NOT NULL,
    PRIMARY KEY (file_id, idx)
);
