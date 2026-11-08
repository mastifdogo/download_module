-- What the AI read from a file (Extract data) waits here as a suggestion until
-- a person approves it (then the CSV is created) or rejects it.
CREATE TABLE extractions (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_id      bigint      NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    model        text        NOT NULL DEFAULT '',
    currency     text        NOT NULL DEFAULT '',
    instructions text        NOT NULL DEFAULT '',
    rows         jsonb       NOT NULL,   -- [{date, description, amount, balance}], as the AI read them
    created_by   text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    decided_by   text,
    decided_at   timestamptz,
    csv_file_id  bigint      -- the CSV created on approval
);
CREATE INDEX extractions_pending ON extractions (file_id) WHERE status = 'pending';
