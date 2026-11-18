# Release-note targeted proof

This supplements the frozen Root971 reminder receipt; it does not rewrite its
hashes, rerun the complete reminder target or certify whole layouts/report data.
The production release-note feature under test is Root4c8cb5e.

The exact pinned `users/templates/admin/includes/whatsnew.html` is rendered through
Django4.2.5 for all five role values. Context roles are explicit template fixtures,
not an authentication oracle. Parsed outputs bind the three role-name mappings,
role1-only report entry, fixed8Sep2026 date and always-present New badge. Native
candidate roles1/4 are independently established by real SQL sessions and verified
through the actual current-session HTTP response.

The actual built App opens its real native notes dialog. Focus containment and
return, Close/Got it/Escape, date/mapping content, role-gated report text and New
after dismissal/reload are asserted. Genuine native expiry and day-close responses
arrive while the notes dialog is open: neither reminder may stack over it or consume
an undisplayed nag snooze; closing notes must then allow the eligible reminder.
Only actual HTTP replies are forwarded. Informational actions must dispatch no HTTP
mutation. No principal/session-cache injection, API response replacement or live
provider is used. The existing owned native fixture supplies a Date-only clock;
timers, SQL, authentication/check-in and application services remain real.

From backend, after coordinated authorization:

```sh
sh tools/global-reminders/notes-run.sh /absolute/pinned/backend-pos-web
```

An explicit owned `GLOBAL_REMINDERS_MYSQL_URL` remains supported; otherwise the
existing workflow fixture helper owns a random-port pinned local MySQL container
and cleans it up. Never supply production/shared-reader credentials or port54777.
The wrapper uses private temporary Python dependencies, strict checking and the
production frontend build. Keep failure logs private0600. No execution or pass
claim is implied by this authored harness; complete canonical verification belongs
to the coordinated final run.
