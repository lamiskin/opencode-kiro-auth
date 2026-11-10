# src/kiro/
## Responsibility

Kiro auth helpers. Two modules:

- `auth.ts`: pure helpers for the refresh-token wire format and access-token expiry.
- `oauth-idc.ts`: AWS IAM Identity Center (IdC / Builder ID) device-code OAuth flow: client registration, device authorization, and token polling.

No I/O in `auth.ts`. `oauth-idc.ts` performs HTTP calls via global `fetch` against the SSO-OIDC endpoint.

## Design (patterns, abstractions, interfaces)

- Refresh token is a pipe-delimited string stored by the plugin. `auth.ts` maps it to and from `RefreshParts` (defined in `../plugin/types`):
  - desktop form: `<refreshToken>|desktop`
  - IdC form: `<refreshToken>|<clientId>|<clientSecret>|idc`
- `decodeRefreshToken` treats a token without a `|` as desktop. Unknown method suffixes fall back to desktop.
- `encodeRefreshToken` throws `Missing credentials` when an IdC part lacks `clientId` or `clientSecret`.
- `accessTokenExpired(auth, bufferMs = 120000)` returns true when `access` or `expires` is missing, or when now is within the buffer of expiry.
- `oauth-idc.ts` exports two interfaces:
  - `KiroIDCAuthorization`: device code, user code, verification URLs, client credentials, `interval`, `expiresIn`, region, start URL.
  - `KiroIDCTokenResult`: refresh and access tokens, `expiresAt` (epoch ms), client credentials, region, `authMethod: 'idc'`.
- Region and endpoint resolution use `normalizeRegion` and `buildUrl` with `KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT` from `../constants`. Shared `KIRO_CONSTANTS.USER_AGENT` goes on every request.
- Polling is a bounded loop. `maxAttempts = floor(expiresIn / interval)`. The loop handles RFC 8628 errors:
  - `authorization_pending`: continue.
  - `slow_down`: add 5000 ms to the interval, then continue.
  - `expired_token`, `access_denied`: throw.
- Response-field fallbacks accept both snake_case and camelCase (`access_token` / `accessToken`, etc.). Default `expires_in` is 3600 s.
- Error classification is by substring match on `error.message` ("expired", "denied", "failed"). Matching errors are rethrown. Others count as retryable until `maxAttempts` is reached.

## Flow (data in -> key calls -> data out)

Device flow:
1. `authorizeKiroIDC(region?, startUrl?)`
   - POST `/client/register` gives `clientId` and `clientSecret`.
   - POST `/device_authorization` with those and `startUrl` gives `deviceCode`, `userCode`, and verification URIs.
   - Returns `KiroIDCAuthorization`.
2. Caller shows `userCode` and the verification URL to the user.
3. `pollKiroIDCToken(clientId, clientSecret, deviceCode, interval, expiresIn, region)`
   - Sleeps, then POSTs `/token` with `grantType` set to the device_code URN.
   - On success returns `KiroIDCTokenResult`. `email` is hardcoded to `builder-id@aws.amazon.com`.

Refresh-token path:
- Stored string -> `decodeRefreshToken` -> `RefreshParts`.
- `RefreshParts` -> `encodeRefreshToken` -> stored string.
- Access state -> `accessTokenExpired` -> boolean.

## Integration (consumers and dependencies)

Consumers (confirmed by grep):
- `src/core/auth/token-refresher.ts` imports `accessTokenExpired`.
- `src/plugin/accounts.ts` imports `decodeRefreshToken` and `encodeRefreshToken`.
- `src/plugin/token.ts` imports `decodeRefreshToken` and `encodeRefreshToken`.

- `src/core/auth/idc-auth-method.ts` imports `authorizeKiroIDC` and `pollKiroIDCToken` from `oauth-idc.ts` (verified by grep).

Dependencies:
- `../constants`: `KIRO_AUTH_SERVICE`, `KIRO_CONSTANTS`, `buildUrl`, `normalizeRegion`.
- `../plugin/types`: `KiroAuthDetails`, `RefreshParts`, `KiroRegion` (type-only imports).
- Global `fetch` and `setTimeout`.
