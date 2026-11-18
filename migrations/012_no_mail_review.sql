-- "Look before importing" (0.20.0) was removed in 0.21.1. Emails it held
-- back (outcome 'waiting') are forgotten, so the next email check looks at
-- them again and imports them as usual; ones skipped by hand stay seen.
DELETE FROM mail_seen WHERE outcome = 'waiting';
