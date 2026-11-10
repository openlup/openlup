- A timed pause shifts the next cycle by the pause length and never brings it earlier. Auto-resume and the pause reminder use the stored window duration, with reminders clamped to the pause end and auto-resume clamped to execution time; manual customer resume is unchanged.

Migration: `20261110105000_subscription_pause_duration.sql` replaces only the timed auto-resume function and the pause-reminder producer, preserving their skip guards, headers, owners and execution privileges.
