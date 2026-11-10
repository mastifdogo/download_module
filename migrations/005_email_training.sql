-- What the email check learns (lib/learn.mjs): each email file keeps the
-- features of where it came from; deleting one ("Delete and learn") or
-- sending it on turns them into an example. Skipped emails keep the reason.
ALTER TABLE files ADD COLUMN mail_features text[];
ALTER TABLE files ADD COLUMN mail_trained boolean NOT NULL DEFAULT false;  -- already a wanted example

ALTER TABLE mail_seen ADD COLUMN reason text NOT NULL DEFAULT '';

CREATE TABLE mail_training (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label      smallint    NOT NULL CHECK (label IN (-1, 1)),   -- -1 deleted (unwanted), 1 kept (wanted)
    features   text[]      NOT NULL,
    sender     text        NOT NULL DEFAULT '',
    subject    text        NOT NULL DEFAULT '',
    file_name  text        NOT NULL DEFAULT '',
    source     text        NOT NULL DEFAULT 'delete' CHECK (source IN ('delete', 'sent', 'import', 'file')),
    created_by text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_training_created ON mail_training (created_at DESC);
