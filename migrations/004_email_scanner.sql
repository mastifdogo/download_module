-- Where a file came from (the extension leaves it '', with source_url), and
-- the email check: every message looked at once, and the last check's state.
ALTER TABLE files ADD COLUMN origin text NOT NULL DEFAULT ''
    CHECK (origin IN ('', 'email', 'scanner', 'camera', 'upload'));
ALTER TABLE files ADD COLUMN origin_detail text NOT NULL DEFAULT '';   -- the sender, or the scanner's name

CREATE TABLE mail_seen (
    folder      text        NOT NULL,          -- "gmail", or the IMAP folder
    uidvalidity bigint      NOT NULL,
    uid         text        NOT NULL,          -- IMAP UID or Gmail message id
    outcome     text        NOT NULL,          -- files | email_saved | no_document | filtered | sent | too_large
    files       integer     NOT NULL DEFAULT 0,
    subject     text        NOT NULL DEFAULT '',
    mail_from   text        NOT NULL DEFAULT '',
    seen_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (folder, uidvalidity, uid)
);

CREATE TABLE state (
    key        text        PRIMARY KEY,
    value      jsonb       NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
