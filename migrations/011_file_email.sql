-- Which email a file came from (the mailbox and the message id there), so the
-- email can be shown before the file is sent on to Ledger. '' for files from
-- elsewhere, and for email files from before this (an .eml file is shown from
-- its own bytes either way). Ids from one mailbox mean nothing in another.
ALTER TABLE files ADD COLUMN mail_folder text NOT NULL DEFAULT '';
ALTER TABLE files ADD COLUMN mail_uid text NOT NULL DEFAULT '';
