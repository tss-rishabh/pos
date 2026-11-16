# Google web and desktop sign-in

The selected provider is Google OIDC, issuer `https://accounts.google.com`.
The user's reference is `fullstack-tss-admin@76805a772219d4a1e819083398a73d1fb169eefd`,
`apps/web/app/services/auth/oauth_service.ts`. Its Google code/PKCE flow requests
openid/email/profile, selects an account, treats hd as a hint, and checks an exact
email-domain allowlist. The example domains are thesouledstore.com and
thesouledstore.co.in. That repository is unchanged.

The rewrite uses openid-client6.9.0, Google discovery and S256 PKCE. State/nonce
are random, encrypted HttpOnly cookies expire after10 minutes, provider requests
have5-second individual/10-second combined budgets and never follow redirects.
RS256 signatures are checked against Google's JWKS as well as issuer, audience,
expiry, state and nonce. The Google work-domain/email allowlist is enforced after
verification. Only existing active POS operators with recognized roles/types
can enroll. Their immutable Google subject is linked once to the operator;
recycled emails cannot silently replace it. Roles, store access and authentication
versions still come from the writer. Tokens remain server-side and are discarded;
an extra userinfo request is unnecessary for the validated email identity.

Current local evidence is14 actual OIDC/JWKS tests and35 native authentication
checks, including20 concurrent subject enrollments, ambiguity/accent guards,
native session rollback, cookie callback, archived-account revocation and desktop
pairing/recovery. Five Chromium scenarios exercise the login and approval screens.
A native Electron test checks the browser launcher and denies embedded Google
navigation. These checks do not certify a live Google client or a signed installer.

## Desktop handoff

Google desktop authorization opens in the system browser. The Electron renderer
must not receive Google tokens, client secrets or a general shell API. Electron's
main-process window-open handler accepts only the configured POS origin's exact
SSO-start path and validated flow parameters from a trusted source frame. No
preload or IPC capability is exposed. Google login does not run inside Electron;
embedded navigation to Google is denied even if a legacy origin setting allows it.

The backend creates a10-minute flow with separate hashed browser ticket,
desktop proof and pairing-code purposes. The desktop receives the proof only in
an encrypted HttpOnly cookie scoped to the desktop-session API. JSON responses
contain the flow ID, six-digit code, expiry and approved browser URL. Neither the
proof nor the pairing code enters that URL. Its one-use browser ticket starts the
standard confidential Google web flow; the encrypted OIDC cookie binds that
browser callback to the flow. A copied browser URL still requires explicit code
approval on the intended device.

After Google verification, a separate HttpOnly approval cookie binds the browser
to the verified operator. The browser shows the identity and asks for the code
visible in the POS app. At most5 attempts are allowed. Approval rechecks the
current operator/authentication version. This explicit pairing step prevents an
ordinary shared authorization link from silently signing a different device in.

The desktop polls and consumes the approved flow using its scoped HttpOnly
proof cookie. Renderer-provided proof headers cannot replace this cookie.
Session creation, last-login update and the saved encrypted
consumption credential commit in one writer transaction. Lost replies recover
the same session rather than creating another. Revocation prevents that receipt
from minting a replacement session. Cookies are installed only after commit;
replaying the same receipt must not revoke its own session. The desktop proof,
pairing code and session credentials never enter logs, URLs or browser storage.
Only the short-lived one-use browser ticket is carried in the start URL.
Expired/cancelled/locked flows are unusable and bounded cleanup removes them.

After a lost consumption reply, the screen first reads the existing flow and
offers an explicit recovery attempt. If session creation succeeded but the final
profile request failed, Finish sign-in only reads the current session. Pending
pairing disables password submission; cancellation revokes any consumed session
before returning to normal login. Desktop SSO defaults to disabled until the
Google client and trusted production HTTPS origin are configured.

Windows and macOS use the same browser/cookie handoff, without custom protocols
or a callback port. Native signed builds still require actual system-browser,
return-to-app and upgrade/profile checks on both platforms.

Provider references: [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect),
[discovery](https://accounts.google.com/.well-known/openid-configuration),
[desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app).
The actual client ID/secret, approved HTTPS redirect and live tenant acceptance
are deployment inputs. No live Google user login or infrastructure write has
been performed by the local tests.
