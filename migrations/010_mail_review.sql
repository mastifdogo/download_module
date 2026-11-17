-- Looking at emails before they're imported (Settings → Import → Email):
-- with that on, the email check keeps a bill-like email as outcome 'waiting'
-- instead of saving its files; a person views it and imports it or skips it
-- ('dismissed'). The email's own date, for that list.
ALTER TABLE mail_seen ADD COLUMN mail_date timestamptz;
