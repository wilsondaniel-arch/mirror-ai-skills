# Security Rules — Mirror AI audit knowledge base

Reusable rules for the security pass of the Mirror AI Android/iOS audit
(`prompts/skills/security-skill.md`, section 4). Each rule describes one **root
cause** that past findings shared, how to detect it in a static read of the
pinned checkouts, and how to fix it.

The audit loads this file from `superapp-workspace` branch `mirror-ai-reports` at
run time (`docs/security-rules.md`), so a merged change here applies to the next audit
without a tool release. A bundled copy in Mirror AI is used only when the
workspace cannot be reached.

## How the audit uses these rules

- Every row of the *Security findings* table carries the **Rule** it matches
  (`SR-…`), or `NEW` when no rule covers the root cause.
- One root cause is one finding. Two rows with the same Rule and the same cited
  code location are duplicates and must be merged.
- A rule is a **detection hint, not evidence.** A finding still needs a file and
  line citation from the pinned checkouts. Never report a rule because a past
  ticket or report listed it.
- Rows marked `NEW` are also listed under *Proposed rules* (see "Adding or
  changing a rule"). They are proposals until a person merges them here.

## Rule format

Each rule is a `### SR-<AREA>-<NNN> — <name>` heading followed by the same
fields, in this order: metadata list (Rule ID, Rule Name, Security Category,
Severity, Affected Platforms, Reference), then Description, Root Cause,
Detection Logic, Vulnerable Code Examples, Recommended Secure Implementation and
False Positive Considerations. The audit parses the heading and the metadata
list, so keep their shape. Rule IDs are permanent: never renumber or reuse one;
retire a rule by adding `- **Status:** Retired` to its metadata list instead of deleting it.

Areas: `CRYPTO` cryptography · `SECRET` secrets and configuration · `NET`
transport · `WEB` WebView · `ENTRY` deep links and entry points · `AUTH`
authentication and session · `STORE` secure storage · `DATA` sensitive data
exposure · `RES` platform hardening and client-side trust.

## Sources and traceability

| Key | Source | Status |
|-----|--------|--------|
| `VULN-*` | Jira project VULN, open tickets whose summary or description mention Panama (JQL in the change log), read 2026-11-18 | Ingested: 23 tickets |
| `R-CAR-1117` | Mirror AI report `reports/caribbean/Caribbean-AUTO_LOGOUT+3-SEC-2026-11-17` (branch `mirror-ai-reports`) | Ingested |
| `R-CAR-1118` | Mirror AI report `reports/caribbean/Caribbean-ALL-SEC-2026-11-18-2` (branch `mirror-ai-reports`) | Ingested |
| `SHEET-A` | Google Sheet `1L7e16sJsWHMlG9uMCDCJP1a195MbUAnEfB157zcjrB4` | **Pending** — not readable from the build environment; not yet reflected in any rule |
| `SHEET-B` | Google Sheet `17nXYOLvPNX6dLBnn4aa_NiEQKD2V8ZnXYS0pmD1-USo` (tab `gid=2000164777`) | **Pending** — as above |

A reference such as `R-CAR-1118 App-wide SEC-03` names the report, the module
section and the finding ID. Several VULN tickets keep their full remediation in
an attached HTML report that was not read; where a fix below goes beyond the
ticket text, it says so.

Code under *Vulnerable Code Examples* is quoted from the ticket where the ticket
quotes it. Snippets marked *illustrative* were reconstructed from a report's
description of the code and are not verbatim. Keys and secrets are always
redacted.

---

## Cryptography

### SR-CRYPTO-001 — AES in ECB mode for payload or field encryption

- **Rule ID:** SR-CRYPTO-001
- **Rule Name:** AES in ECB mode for payload or field encryption
- **Security Category:** Cryptography (MASVS-CRYPTO) · CWE-327
- **Severity:** High
- **Affected Platforms:** Android, iOS
- **Reference:** VULN-37127, VULN-35177, VULN-35184; R-CAR-1117 App-wide SEC-02; R-CAR-1118 App-wide SEC-03

#### Description
Request bodies or fields are encrypted with AES in ECB mode. ECB encrypts equal
16-byte blocks to equal ciphertext and has no integrity protection, so a network
observer learns the structure of the JSON, and blocks can be reordered or
replaced without detection.

#### Root Cause
The transport encryption layer picks a block mode without authentication,
usually to match a legacy server implementation. On Android the transformation
string is often assembled in native code or remote config, which hides it from
simple searches.

#### Detection Logic
- Android: `Cipher.getInstance(...)` whose transformation resolves to
  `AES/ECB/...` or just `"AES"` (the provider default is ECB). Follow the
  argument to where it is built: string concatenation (`"AES/" + "ECB/" + ...`),
  JNI getters in `native-lib.cpp`, `SecurityConfig` constants, or remote-config
  values.
- iOS: CryptoSwift `AES(key:..., blockMode: ECB(), ...)`, or `CCCrypt` with
  `kCCOptionECBMode`.
- Confirm the cipher is used on network payloads or persisted fields, not only
  in a test.

#### Vulnerable Code Examples
```cpp
// Android native (VULN-37127, VULN-35177)
const std::string aes_trans_part1 = "AES/";
const std::string aes_trans_part2 = "ECB/";
const std::string aes_trans_part3 = "PKCS5Padding";
std::string getAesTransformation() { return aes_trans_part1 + aes_trans_part2 + aes_trans_part3; }
```
```swift
// iOS (VULN-35184)
let aes = try AES(key: [UInt8](base64: key), blockMode: ECB(), padding: Padding.pkcs5)
```

#### Recommended Secure Implementation
Use authenticated encryption: AES-GCM with a fresh random 12-byte nonce per
message (`Cipher.getInstance("AES/GCM/NoPadding")` with `GCMParameterSpec(128, nonce)`
on Android; `AES.GCM.seal` from CryptoKit on iOS). Send the nonce with the
ciphertext. Change the server at the same time on both platforms; the tickets
say "align with server and iOS remediation".

#### False Positive Considerations
- `RSA/ECB/...` is a JCE naming artifact; ECB has no meaning for RSA. Judge RSA
  by its padding under SR-CRYPTO-002, not here.
- ECB used once to wrap a single random 16-byte key (one block) leaks no
  pattern. Report it as Low with that reasoning, or not at all.
- Test vectors and code under `test/`, `androidTest/` or `*Tests/`.

### SR-CRYPTO-002 — RSA with PKCS#1 v1.5 encryption padding

- **Rule ID:** SR-CRYPTO-002
- **Rule Name:** RSA with PKCS#1 v1.5 encryption padding
- **Security Category:** Cryptography (MASVS-CRYPTO) · CWE-780
- **Severity:** Medium
- **Affected Platforms:** Android, iOS
- **Reference:** VULN-37128; R-CAR-1117 App-wide SEC-03

#### Description
A per-request AES key is wrapped with RSA using PKCS#1 v1.5 padding. If the
server reveals whether padding was valid, through different errors or timing,
the wrapped key can be recovered (a Bleichenbacher padding oracle). The
attacker can then decrypt the request body and forge requests.

#### Root Cause
The transformation string is fixed to `PKCS1Padding`, often inherited from an
old server contract, instead of OAEP.

#### Detection Logic
- Android: `Cipher.getInstance` with `RSA/ECB/PKCS1Padding` or `RSA/NONE/PKCS1Padding`,
  including strings built from parts or loaded from remote config.
- iOS: `SecKeyCreateEncryptedData` with `.rsaEncryptionPKCS1`, or `SecKeyEncrypt`
  with `.PKCS1`.

#### Vulnerable Code Examples
```cpp
// Android native (VULN-37128)
const std::string rsa_trans_part1 = "RSA/";
const std::string rsa_trans_part2 = "ECB/";
const std::string rsa_trans_part3 = "PKCS1Padding";
std::string getRsaTransformation() { return rsa_trans_part1 + rsa_trans_part2 + rsa_trans_part3; }
```

#### Recommended Secure Implementation
Use RSA-OAEP with SHA-256 (`RSA/ECB/OAEPWithSHA-256AndMGF1Padding`;
`.rsaEncryptionOAEPSHA256` on iOS), changed together with the server, and
return the same error for every decryption failure. VULN-37128 names OAEP; the
rest of its remediation is in the ticket's attachment.

#### False Positive Considerations
- PKCS#1 v1.5 **signatures** (`SHA256withRSA`) are not affected.
- Severity depends on the server acting as an oracle, which a static read cannot
  settle: use Confidence `Runtime Verification Required` unless the code shows it.

### SR-CRYPTO-003 — Static or reused IV or nonce

- **Rule ID:** SR-CRYPTO-003
- **Rule Name:** Static or reused IV or nonce
- **Security Category:** Cryptography (MASVS-CRYPTO) · CWE-323
- **Severity:** High
- **Affected Platforms:** Android, iOS
- **Reference:** VULN-37125; R-CAR-1117 App-wide SEC-01; R-CAR-1118 App-wide SEC-01, None SEC-01

#### Description
The same IV or nonce is used for every encryption under one key. For GCM this
breaks both confidentiality (XOR of two ciphertexts equals XOR of the
plaintexts) and integrity (the authentication subkey leaks, allowing forged
tags). Every value encrypted this way, such as tokens, MSISDN or the biometric
secret, is exposed through known plaintext.

#### Root Cause
The IV is generated once and stored (for example in `gcm_iv.bin` or
`cbc_iv.bin`) so that decryption does not need to store it with each value.
The Keystore protection that would refuse a caller IV is switched off with
`setRandomizedEncryptionRequired(false)`.

#### Detection Logic
- Android: `setRandomizedEncryptionRequired(false)` on a `KeyGenParameterSpec`;
  `GCMParameterSpec` or `IvParameterSpec` built from a constant, a field, a file
  or a preference instead of fresh `SecureRandom` bytes; an IV file read before
  `cipher.init`.
- iOS: `AES.GCM.Nonce(data:)` from stored or constant bytes; `CCCrypt` with a
  constant IV.

#### Vulnerable Code Examples
```kotlin
// Android (VULN-37125)
val file = if (blockMode.equals(KeyProperties.BLOCK_MODE_GCM, true)) File(context.filesDir, "gcm_iv.bin")
           else File(context.filesDir, "cbc_iv.bin")
val ivBytes = if (file.exists()) encryptedFile.openFileInput().use { it.readBytes() }   // reused for every call
              else generateIvParameter(blockMode).also { encryptedFile.openFileOutput().use { o -> o.write(it) } }
```

#### Recommended Secure Implementation
Let the Keystore choose a random IV per encryption (keep
`setRandomizedEncryptionRequired(true)`; call `cipher.init(ENCRYPT_MODE, key)`
and read `cipher.iv`). Store `iv || ciphertext` together and split them on
decrypt. Migrate values written under the old fixed IV by decrypting them once
and re-encrypting them. Prefer Jetpack Security, Tink `Aead` or
`EncryptedSharedPreferences`, which handle nonces themselves.

#### False Positive Considerations
- A fixed IV with a key that encrypts exactly one message (a one-time key) is
  not reuse.
- Decryption must read a stored IV; that alone is not reuse. Check the encrypt
  path.

### SR-CRYPTO-004 — Private or symmetric key delivered to or obfuscated in the client

- **Rule ID:** SR-CRYPTO-004
- **Rule Name:** Private or symmetric key delivered to or obfuscated in the client
- **Security Category:** Cryptography / Secrets (MASVS-CRYPTO) · CWE-321
- **Severity:** High
- **Affected Platforms:** Android, iOS
- **Reference:** R-CAR-1117 App-wide SEC-04; R-CAR-1118 App-wide SEC-04, Miscellaneous SEC-01, Topup SEC-01

#### Description
The app's private RSA key, or an AES key, reaches every install through remote
config or the binary and is only masked (for example XOR with a single byte).
Anyone who installs the app can recover it, then decrypt the responses it
protects or impersonate the client.

#### Root Cause
A key that should be per-device and non-exportable (Keystore or Secure Enclave)
is treated as shared app configuration, and masking is used as if it were
encryption.

#### Detection Logic
- Remote-config keys named like `PrivateKey`, `CipherKey`, `VectorKey`,
  `SecureKeyStore`, `appPrivateKey`.
- Key bytes rebuilt with `xor`, `^ 0x..`, `reversed()` or base64 of parts, then
  passed to `KeyFactory`, `SecretKeySpec`, `SecKeyCreateWithData` or `SymmetricKey`.
- A private key literal (`-----BEGIN ... PRIVATE KEY-----`) in source or resources.

#### Vulnerable Code Examples
```kotlin
// illustrative, from R-CAR-1118 App-wide SEC-04
val parts = remoteConfig.getString("SecureKeyStore")
val keyBytes = Base64.decode(parts, 0).map { (it.toInt() xor 0x5A).toByte() }.toByteArray()
val privateKey = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(keyBytes))
```

#### Recommended Secure Implementation
Generate key pairs on the device in the Android Keystore or iOS Secure Enclave
(non-exportable) and register the public key with the server, or use TLS plus
server-side field encryption so the client holds no long-term private key.
Rotate any key that has already shipped.

#### False Positive Considerations
- **Public** keys and certificate pins in config are expected; do not report them.
- Remote-config keys that hold only an algorithm name or a feature flag.

### SR-CRYPTO-005 — Encryption fails open to plaintext

- **Rule ID:** SR-CRYPTO-005
- **Rule Name:** Encryption fails open to plaintext
- **Security Category:** Cryptography (MASVS-CRYPTO) · CWE-636
- **Severity:** High
- **Affected Platforms:** Android, iOS
- **Reference:** R-CAR-1117 App-wide SEC-08, SEC-09; R-CAR-1118 App-wide SEC-05, SEC-06, SEC-16

#### Description
When encryption is switched off by a flag, its key material is missing, or it
throws, the code sends or stores the value **in plaintext** instead of failing.
Some body types (form, multipart) skip encryption entirely. A remote-config
change or a broken key silently removes the protection.

#### Root Cause
Error handling returns the input (`?: value`, `catch { return body }`) and
feature flags gate the protection without a fail-closed default.

#### Detection Logic
- An `encrypt`/`decrypt` helper whose failure path returns its input
  (`?: value`, `?? data`, `catch { plaintext }`) or `nil`/`null` that the caller
  then sends anyway.
- Interceptors that check a flag (`FIELD_ENCRYPTION_ENABLED`) or missing keys
  and `proceed` with the original request.
- `when (body)` / `if body is FormBody || MultipartBody` branches that skip
  encryption, and helpers such as `encryptFormBody` that are never called.

#### Vulnerable Code Examples
```kotlin
// illustrative, from R-CAR-1118 App-wide SEC-05 / SEC-06
fun encrypt(value: String): String = runCatching { aes.encrypt(value) }.getOrNull() ?: value
if (!fieldEncryptionEnabled || rsaKey == null) return chain.proceed(request.newBuilder().header("mmReqIdentifier", id).build())
```

#### Recommended Secure Implementation
Fail closed: when protection cannot be applied, throw and do not send or store
the value. Keep a kill switch only on the server side. Encrypt every body type
the API accepts or reject the ones it cannot encrypt. Add a unit test for each
failure path.

#### False Positive Considerations
- Endpoints documented as public (config, version check) that are deliberately
  excluded by an allowlist.
- A decryption failure that returns `null` and is then handled as an error is
  correct.

---

## Secrets and configuration

### SR-SECRET-001 — Hard-coded credentials or SDK keys in source

- **Rule ID:** SR-SECRET-001
- **Rule Name:** Hard-coded credentials or SDK keys in source
- **Security Category:** Secrets and configuration (MASVS-STORAGE / MASVS-CODE) · CWE-798
- **Severity:** High (client secrets, passwords, Basic auth) · Medium (SDK keys meant to be public but abusable)
- **Affected Platforms:** Android, iOS
- **Reference:** VULN-37160, VULN-33037, VULN-32819, VULN-32820, VULN-32821, VULN-32822; R-CAR-1118 Miscellaneous SEC-03

#### Description
API keys, SDK dev keys, usernames, passwords or client secrets are written as
string literals. Anyone with the binary or the repository can extract them. A
leaked secret cannot be rotated without a new release.

#### Root Cause
Third-party SDK set-up copied from vendor samples, and credentials embedded to
avoid a back-end token exchange.

#### Detection Logic
- Assignments to `devKey`, `apiKey`, `clientSecret`, `password`, `appsFlyerDevKey`,
  `Authorization: Basic ...`, or `Credentials.basic(...)` with literal arguments.
- High-entropy literals of 20 or more characters near those names, and values in
  `gradle.properties`, `*.xcconfig`, `Info.plist`, `strings.xml`.
- Record each hit in the *Hard-coded secrets* table, redacted per the skill.

#### Vulnerable Code Examples
```swift
// iOS (VULN-37160) — value redacted
appsFlyerSDK.appsFlyerDevKey = "<REDACTED AppsFlyer dev key>"
```

#### Recommended Secure Implementation
Inject values at build time from CI secrets (`BuildConfig` fields from
environment variables, `.xcconfig` generated in CI and not committed), or fetch
short-lived tokens from the back end. Rotate any key that has been committed.
Where a vendor key is public by design, restrict it on the vendor side (package
name, signing certificate, bundle ID).

#### False Positive Considerations
- Firebase `mobilesdk_app_id`, Google `project_id` and `GOOGLE_APP_ID` are
  identifiers, not secrets.
- Room `identityHash` in generated schema files.
- Placeholders such as `YOUR_API_KEY`, test fixtures, and values read from
  `BuildConfig` that are supplied by CI.

### SR-SECRET-002 — Committed Firebase or Google service configuration with unrestricted keys

- **Rule ID:** SR-SECRET-002
- **Rule Name:** Committed Firebase or Google service configuration with unrestricted keys
- **Security Category:** Secrets and configuration (MASVS-CODE) · CWE-540
- **Severity:** Medium
- **Affected Platforms:** Android, iOS
- **Reference:** VULN-33035

#### Description
`google-services.json` or `GoogleService-Info.plist` is committed with its API
key. The key is visible to anyone with the repository or app. Without
restrictions or App Check, it can be used against the project's Firebase
services.

#### Root Cause
Config files are committed for convenience instead of being generated in CI.

#### Detection Logic
- `google-services.json` or `GoogleService-Info.plist` tracked in the repository,
  holding `current_key` or `API_KEY` (`AIza…`).
- Absence of Firebase App Check initialisation (`FirebaseAppCheck`,
  `AppCheck.setAppCheckProviderFactory`) is supporting evidence, not a finding
  on its own.

#### Vulnerable Code Examples
```json
// google-services.json — committed, value redacted
"api_key": [{ "current_key": "AIza…" }]
```

#### Recommended Secure Implementation
Generate the files in CI from a secrets manager. Restrict the key to the
package name and signing certificate SHA-1 (Android) or the bundle ID (iOS),
enable Firebase App Check, and rotate keys that were exposed (VULN-33035).

#### False Positive Considerations
- Firebase Android keys are designed to ship in the APK. The weakness is a key
  without restrictions or App Check, which a static read cannot confirm: use
  Confidence `Runtime Verification Required`.
- `mobilesdk_app_id` and `project_number` are not secrets.

---

## Transport security

### SR-NET-001 — Certificate pin checked after the request is sent

- **Rule ID:** SR-NET-001
- **Rule Name:** Certificate pin checked after the request is sent
- **Security Category:** Transport security (MASVS-NETWORK) · CWE-295
- **Severity:** High
- **Affected Platforms:** Android
- **Reference:** R-CAR-1117 App-wide SEC-05; R-CAR-1118 App-wide SEC-02

#### Description
A custom OkHttp interceptor calls `chain.proceed()` and only then compares the
server certificate with the pin. The request, with its headers, token and body,
has already reached the server when the mismatch throws, so pinning does not
protect what was sent.

#### Root Cause
Pinning is written as an application interceptor reading
`response.handshake` instead of using OkHttp's `CertificatePinner`, which runs
during the TLS handshake.

#### Detection Logic
- An `Interceptor` whose `intercept` calls `chain.proceed(...)` before reading
  `handshake.peerCertificates` and comparing hashes.
- A pinning class with no `CertificatePinner` on the `OkHttpClient.Builder`.

#### Vulnerable Code Examples
```kotlin
// illustrative, from R-CAR-1118 App-wide SEC-02
override fun intercept(chain: Interceptor.Chain): Response {
    val response = chain.proceed(chain.request())               // request already sent
    val leaf = response.handshake?.peerCertificates?.first()
    if (sha256(leaf) !in pins) throw SSLPeerUnverifiedException("pin mismatch")
    return response
}
```

#### Recommended Secure Implementation
Use `CertificatePinner` on the `OkHttpClient` (checked during the handshake), or
`network_security_config.xml` `<pin-set>` with a backup pin and an expiry.
On iOS, pin in `urlSession(_:didReceive:completionHandler:)` and cancel the
challenge, as the iOS apps in R-CAR-1117 already do.

#### False Positive Considerations
- An interceptor that only reads the handshake for logging, while
  `CertificatePinner` also runs.
- A network interceptor placed after an existing `CertificatePinner`.

### SR-NET-002 — Pinning or transport protection controlled by remote config

- **Rule ID:** SR-NET-002
- **Rule Name:** Pinning or transport protection controlled by remote config
- **Security Category:** Transport security (MASVS-NETWORK) · CWE-295
- **Severity:** High
- **Affected Platforms:** Android, iOS
- **Reference:** R-CAR-1117 App-wide SEC-06

#### Description
Pins and the switch that turns pinning on come from remote config. If the fetch
fails, returns defaults, or the config is changed, pinning is off without a
release.

#### Root Cause
Pin rotation is handled through remote config without a fail-closed
built-in pin set.

#### Detection Logic
- Pins or an `isPinningEnabled` flag read from Firebase Remote Config, a
  feature-flag client or a server response, then used to decide whether to pin.
- Check the default: an empty default that disables pinning (fails open) is
  High; an empty default that blocks all calls (fails closed) is lower.

#### Vulnerable Code Examples
```swift
// illustrative, from R-CAR-1117 App-wide SEC-06 (iOS)
guard RemoteConfig.isPinningEnabled, securityEnabled, sslEnabled, !pins.isEmpty else {
    completionHandler(.performDefaultHandling, nil); return          // no pinning
}
```

#### Recommended Secure Implementation
Ship a built-in pin set (current plus backup key) in the binary. Allow remote
config only to **add** pins, never to remove all of them or turn pinning off in
release builds.

#### False Positive Considerations
- A flag that is honoured only in debug builds (`BuildConfig.DEBUG`, `#if DEBUG`).
- Report the fail-closed variant at Low or Info.

### SR-NET-003 — Access token sent in the URL query string

- **Rule ID:** SR-NET-003
- **Rule Name:** Access token sent in the URL query string
- **Security Category:** Transport security / Session (MASVS-NETWORK, MASVS-AUTH) · CWE-598
- **Severity:** High
- **Affected Platforms:** Android, iOS, Backend
- **Reference:** VULN-37963

#### Description
A bearer token or session ID is appended to a URL, often one opened in a
WebView or browser. Query strings are written to server, proxy and CDN logs and
browser history, and can leak through the `Referer` header.

#### Root Cause
A WebView or redirect URL is built with the token so that the web page can
authenticate without a header.

#### Detection Logic
- URL builders adding `token`, `access_token`, `authToken`, `jwt`, `session`
  as query parameters (`appendQueryParameter`, `URLQueryItem`, string templates
  `"?token=$token"`), especially before `loadUrl`, `WKWebView.load`, or opening a
  payment gateway.

#### Vulnerable Code Examples
VULN-37963 shows only the resulting URL: a redirect URL to
`/panama-payment-gateway/sigma` that carries the bearer token as a query
parameter.

#### Recommended Secure Implementation
Send the token in `Authorization: Bearer` (WebView: `loadUrl(url, headers)` or a
`URLRequest` header), or exchange it server-side for a one-time, short-lived
code. Stop the endpoint accepting tokens from query parameters and redact query
strings in logs (VULN-37963).

#### False Positive Considerations
- One-time codes that expire in seconds and are bound to the session (OAuth
  authorization `code`, signed nonces).
- Public API keys that identify the app but grant no user access.

---

## WebView and embedded web

### SR-WEB-001 — Remote or CMS URL loaded in a WebView without a host allowlist

- **Rule ID:** SR-WEB-001
- **Rule Name:** Remote or CMS URL loaded in a WebView without a host allowlist
- **Security Category:** WebView (MASVS-PLATFORM) · CWE-601, CWE-939
- **Severity:** Medium
- **Affected Platforms:** Android, iOS
- **Reference:** VULN-39219, VULN-37162, VULN-37108; R-CAR-1117 App-wide SEC-15; R-CAR-1118 Loyalty home SEC-02

#### Description
A URL from CMS, API or Remote Config content is loaded into an in-app WebView
with JavaScript enabled, without checking its host and without a navigation
policy for links the page follows. A tampered CMS entry or a compromised CDN can
show a phishing page inside the app's own screen, with no address bar.

#### Root Cause
URL validation checks only that the string parses or that the scheme is
`http`/`https`. Fallbacks such as `URL(string:)` accept anything that parses.
Navigation callbacks are not implemented.

#### Detection Logic
- iOS: `WKWebView.load(URLRequest(url: …))` where the URL comes from a model,
  CMS or remote field; `allowsContentJavaScript = true` or `javaScriptEnabled`;
  no `webView(_:decidePolicyFor:decisionHandler:)` that checks the host.
- Android: `loadUrl(remoteUrl)` with `javaScriptEnabled = true` and no
  `shouldOverrideUrlLoading` host check, or a check that compares only the scheme.
- Compare the platforms. One platform's allowlist with no equivalent on the
  other is a parity finding.

#### Vulnerable Code Examples
```swift
// iOS (VULN-39219)
} else if !urlString.isEmpty, let url = TermConditionViewModel.resolvedURL(from: urlString) ?? URL(string: urlString) {
    webView.configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    webView.load(URLRequest(url: url))
}
```
```swift
// iOS (VULN-37162)
} else if !url.isEmpty, let urlPath = URL(string: url) {
    uiView.load(URLRequest(url: urlPath))  // no host check
}
```

#### Recommended Secure Implementation
Keep one host allowlist per app (exact hosts or registered domain suffixes, as
in an existing `isAllowedWebViewUrl`, `HTMLView` or `validatedExternalURL`), and
check it both before `load` and in `decidePolicyFor` /
`shouldOverrideUrlLoading` for every navigation. Open other hosts in the system
browser. Enable JavaScript only for pages on the allowlist that need it, and
remove the `URL(string:)` fallback.

#### False Positive Considerations
- Inline HTML loaded with `loadHTMLString(_, baseURL: nil)` from bundled assets.
- A URL built from a constant base URL plus a path.
- A check that is real but sits in a shared helper. Follow the call before
  reporting it missing.

### SR-WEB-002 — WebView proceeds on TLS errors or has unsafe settings

- **Rule ID:** SR-WEB-002
- **Rule Name:** WebView proceeds on TLS errors or has unsafe settings
- **Security Category:** WebView (MASVS-PLATFORM, MASVS-NETWORK) · CWE-295, CWE-749
- **Severity:** High (TLS errors ignored) · Medium (unsafe settings)
- **Affected Platforms:** Android, iOS
- **Reference:** VULN-37108; R-CAR-1117 App-wide SEC-16; R-CAR-1118 History SEC-01, App-wide SEC-10, Store locator SEC-01, SEC-02

#### Description
A WebView accepts a bad certificate, or turns on features the page does not
need: file access, universal access from file URLs, JavaScript bridges exposed
to remote content, or geolocation granted to any origin.

#### Root Cause
Settings copied from samples, debug workarounds left in release, and helper
extensions that hide what the error handler does.

#### Detection Logic
- Android: `onReceivedSslError` that calls `handler.proceed()`, directly or
  through a helper (follow the helper; if it is not visible, use Confidence
  `Runtime Verification Required` and cite the call);
  `setAllowFileAccessFromFileURLs(true)`, `setAllowUniversalAccessFromFileURLs(true)`,
  `allowFileAccess = true` with remote content, `addJavascriptInterface` on a
  WebView that loads remote URLs, and `onGeolocationPermissionsShowPrompt`
  granting without an origin check.
- iOS: `didReceive challenge` in `WKNavigationDelegate` answering
  `.useCredential` without trust evaluation; `WKScriptMessageHandler` on remote
  content; geolocation granted without checking `origin` or the frame.

#### Vulnerable Code Examples
```kotlin
// illustrative, from R-CAR-1117 App-wide SEC-16 — the helper body decides the outcome
override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
    handler.handleReceivedSslError()
}
```

#### Recommended Secure Implementation
Call `handler.cancel()` on every SSL error in release builds. Leave file access
and universal access off. Expose JS bridges only to allowlisted origins
(`WebViewCompat.addWebMessageListener` with allowed origins). Grant geolocation
only to the expected origin. Follow VULN-37108's list: least privilege, URL
allowlist, HTTPS only.

#### False Positive Considerations
- `handler.proceed()` behind `BuildConfig.DEBUG`.
- `allowFileAccess = true` for `file:///android_asset/` content with JavaScript
  off.

---

## Deep links and entry points

### SR-ENTRY-001 — URL allowlist that accepts any host

- **Rule ID:** SR-ENTRY-001
- **Rule Name:** URL allowlist that accepts any host
- **Security Category:** Deep links and entry points (MASVS-PLATFORM) · CWE-939
- **Severity:** High
- **Affected Platforms:** Android, iOS
- **Reference:** VULN-37994; R-CAR-1117 App-wide SEC-07; R-CAR-1118 App-wide SEC-09

#### Description
A function named like an allowlist (`isAllowed`, `isAllowedWebViewUrl`) defines
allowed hosts but never uses them, or checks only the scheme, so every
`https://` URL passes.

#### Root Cause
An allowlist was added but not wired up, or the check was relaxed during
testing and never restored.

#### Detection Logic
- Read the body of every URL validation helper. Report it when the result does
  not depend on the host list, for example `return host.isNotEmpty()`,
  `scheme == "https"`, or an unused `allowedHostSuffixes`.
- Suffix checks without a leading dot (`host.endsWith("example.com")` also
  matches `evilexample.com`).

#### Vulnerable Code Examples
```kotlin
// illustrative, from R-CAR-1118 App-wide SEC-09
private val allowedHostSuffixes = listOf(/* ... */)
fun isAllowed(uri: Uri): Boolean = !uri.host.isNullOrEmpty()   // list never consulted
```

#### Recommended Secure Implementation
Match the parsed host exactly, or against `".$suffix"` with a dot boundary,
require `https`, and add a unit test with an allowed host, an
attacker-controlled look-alike, and a URL with user-info (`https://allowed@evil`).

#### False Positive Considerations
- A helper whose result is only used for logging or analytics.
- A permissive helper that a stricter check runs after. Report only if no
  stricter check runs.

### SR-ENTRY-002 — Exported component trusts intent or link data as a navigation target

- **Rule ID:** SR-ENTRY-002
- **Rule Name:** Exported component trusts intent or link data as a navigation target
- **Security Category:** Deep links and entry points (MASVS-PLATFORM) · CWE-926
- **Severity:** High
- **Affected Platforms:** Android, iOS
- **Reference:** VULN-37994

#### Description
An exported activity (or iOS URL scheme or universal link handler) reads an
extra or parameter that describes where to navigate, such as a CTA with a target
URL and "open in app". Any installed app can send it, so another app can open an
arbitrary page inside the trusted app. Queued CTAs that run after the next
login make this worse.

#### Root Cause
Internal navigation objects are accepted from external intents without signing
or verification.

#### Detection Logic
- Android: activities with `android:exported="true"` or an intent filter that
  read `getStringExtra`/`getParcelableExtra` into a navigation, CTA or URL
  model. Look for extras such as `arg_app_target_cta`.
- iOS: `application(_:open:options:)`, `onOpenURL`, or `continue userActivity`
  that turn query parameters into a route or URL target.
- Pending CTA queues that survive logout or login.

#### Vulnerable Code Examples
VULN-37994 gives only the reproduction shape: an `am start` command to the
exported `MainActivity` with `--es arg_app_target_cta '<CTA JSON with targetType=URL, targetUrlPrimary=https://<attacker>, openIn=IN_APP>'`.

#### Recommended Secure Implementation
Do not accept internal navigation objects from intents. Accept only verified
App Links or signed links (for example validated OneLink parameters), map them
to a fixed set of routes, check any URL target against SR-ENTRY-001's
allowlist, and drop unverified CTAs at the login boundary (VULN-37994).

#### False Positive Considerations
- Extras read only when the intent comes from the app's own `PendingIntent`
  (non-exported component, or `FLAG_IMMUTABLE` with an explicit component).
- Launcher intents that carry no navigation data.

### SR-ENTRY-003 — External or push-supplied URL opened without validation

- **Rule ID:** SR-ENTRY-003
- **Rule Name:** External or push-supplied URL opened without validation
- **Security Category:** Deep links and entry points (MASVS-PLATFORM) · CWE-601
- **Severity:** Medium
- **Affected Platforms:** Android, iOS
- **Reference:** VULN-37158; R-CAR-1118 Loyalty home SEC-02

#### Description
A URL from a push payload, campaign or CMS field is passed straight to the
system URL opener (`openURL`, `ACTION_VIEW`). A compromised push or campaign
account can send users to a phishing site that appears to come from the app.

#### Root Cause
Push and campaign links are treated as trusted because operations staff create them.

#### Detection Logic
- iOS: `userInfo["url"]` (or another payload key) passed to `UIApplication.open`
  or `openURL` without a scheme and host check.
- Android: `Intent(ACTION_VIEW, Uri.parse(payloadUrl))` from `RemoteMessage.data`
  or a CMS model without a check.

#### Vulnerable Code Examples
```swift
// iOS (VULN-37158)
} else if let url = userInfo["url"] as? String {
    openURL(url)  // push payload
}
```

#### Recommended Secure Implementation
Allow only `https` and the known schemes, then either check the host against an
allowlist or send unknown hosts through a link gateway or interstitial. The
ticket's discussion also lists signed links and campaign governance as
alternatives where a static allowlist is impractical (VULN-37158, comment
2026-11-16).

#### False Positive Considerations
- URLs built from constants.
- Opening an `https` URL in the external browser is lower risk than opening it
  in-app. Weigh severity by where it opens.

---

## Authentication and session

### SR-AUTH-001 — Raw password or credential kept on the device

- **Rule ID:** SR-AUTH-001
- **Rule Name:** Raw password or credential kept on the device
- **Security Category:** Authentication and session (MASVS-AUTH, MASVS-STORAGE) · CWE-256
- **Severity:** High
- **Affected Platforms:** Android, iOS
- **Reference:** R-CAR-1117 App-wide SEC-11, Biometric access SEC-01, SEC-02; R-CAR-1118 App-wide SEC-13, Biometric access SEC-01, SEC-02

#### Description
The user's password is saved after login (for example for biometric re-login),
or held in UI state, so anyone who can read app storage or memory gets the
reusable credential. Storing it before the server confirms the action, and
keeping it on failure, widens the window.

#### Root Cause
Biometric login is built by replaying the password instead of by a
server-issued, device-bound credential.

#### Detection Logic
- Calls such as `setUserSecret(password)`, `setUserSecretEncrypted`, or saving
  `password` to preferences, DataStore, UserDefaults or the Keychain.
- `password` fields in UI state or ViewModel state that outlive the login call.
- The order of the store call relative to the server response on
  enable/disable flows.

#### Vulnerable Code Examples
```kotlin
// illustrative, from R-CAR-1117 App-wide SEC-11
prefHelper.setUserSecret(password)            // raw password persisted at login
```

#### Recommended Secure Implementation
Keep no password. After login, have the server issue a device-bound refresh
credential, or register a Keystore/Secure Enclave key pair whose use requires
biometric authentication (`setUserAuthenticationRequired(true)`,
`.biometryCurrentSet`). Store only after the server confirms, and clear on
failure.

#### False Positive Considerations
- Passing the password in memory for the duration of one login call.
- A field named `secret` that holds a server-issued token. Then the rule is
  SR-STORE-001 if it is stored in plaintext.

### SR-AUTH-002 — Session not fully ended on logout or timeout

- **Rule ID:** SR-AUTH-002
- **Rule Name:** Session not fully ended on logout or timeout
- **Security Category:** Authentication and session (MASVS-AUTH) · CWE-613
- **Severity:** Medium
- **Affected Platforms:** Android, iOS
- **Reference:** R-CAR-1117 Auto logout SEC-01, SEC-02; R-CAR-1118 Auto logout SEC-01

#### Description
On idle timeout or logout, the app only changes local UI state. It does not
call the server logout or clear tokens and cached user data. The idle timer may
also be off for some build flavors.

#### Root Cause
Logout is split across UI events, and each platform clears a different set of
state.

#### Detection Logic
- Follow the timeout and logout paths: look for a server logout call and for
  clearing access, refresh and other tokens, user IDs and caches.
- Timers gated on `BuildConfig.FLAVOR`, `BuildConfig.DEBUG` or a remote flag.
- Compare the platforms. One platform clearing tokens while the other does not
  is a parity finding.

#### Vulnerable Code Examples
```kotlin
// illustrative, from R-CAR-1117 Auto logout SEC-02
if (BuildConfig.FLAVOR != "dev") startIdleTimer()   // no timeout in dev-flavor builds
```

#### Recommended Secure Implementation
Use one `logout()` that calls the server, clears every credential and
user-scoped cache, and is used by both manual logout and timeout. Gate a
flavor-specific timer only on build types that never ship.

#### False Positive Considerations
- Flavors that are never distributed outside the team. Check the build
  configuration before reporting.
- Clearing that happens in a shared session owner the module does not show.
  Find it before reporting it missing.

### SR-AUTH-003 — Server-returned OTP or verification code shown or prefilled in the client

- **Rule ID:** SR-AUTH-003
- **Rule Name:** Server-returned OTP or verification code shown or prefilled in the client
- **Security Category:** Authentication and session (MASVS-AUTH) · CWE-640
- **Severity:** High
- **Affected Platforms:** Android, iOS, Backend
- **Reference:** R-CAR-1117 Link account SEC-01; R-CAR-1118 Link account SEC-01

#### Description
The app asks the server to return the OTP (`showCode = true`) and prefills it,
so the second factor proves nothing. If the server honours the flag in
production, anyone who can call the API gets the code.

#### Root Cause
A testing convenience left in the request contract without a build gate.

#### Detection Logic
- Request models with `showCode`, `returnOtp`, `debugOtp`, or response models
  with `otpCode` or `code` fields that are written to an OTP input.
- Check for a `BuildConfig.DEBUG` or `#if DEBUG` gate.

#### Vulnerable Code Examples
```kotlin
// illustrative, from R-CAR-1117 Link account SEC-01
val req = SendOtpRequest(msisdn = msisdn, showCode = true)
otpField.value = response.otpCode            // second factor prefilled
```

#### Recommended Secure Implementation
Remove the flag from release builds. The server must never return an OTP
outside test environments. Use SMS Retriever (Android) or `oneTimeCode`
autofill (iOS) for convenience.

#### False Positive Considerations
- Code paths compiled only into debug builds.
- The server ignoring the flag in production makes this Medium, but that needs
  runtime evidence: use Confidence `Runtime Verification Required`.

---

## Secure storage

### SR-STORE-001 — Tokens or personal data in unencrypted preferences

- **Rule ID:** SR-STORE-001
- **Rule Name:** Tokens or personal data in unencrypted preferences
- **Security Category:** Secure storage (MASVS-STORAGE) · CWE-312
- **Severity:** Medium
- **Affected Platforms:** Android, iOS
- **Reference:** R-CAR-1118 Miscellaneous SEC-02, Loyalty home SEC-01, Auto pay SEC-01, Link account SEC-03

#### Description
Access or refresh tokens, verification tokens, MSISDNs, account numbers or
profile data are written to plain `SharedPreferences`, DataStore or
`UserDefaults`. These are readable from backups and on rooted or jailbroken
devices.

#### Root Cause
A general preference helper is used for every value, regardless of sensitivity.

#### Detection Logic
- `getSharedPreferences` / `PreferenceManager` / `preferencesDataStore` /
  `UserDefaults` writes whose keys or values are tokens, IDs or PII.
- Check whether the helper wraps `EncryptedSharedPreferences`, Tink or the
  Keychain before reporting.

#### Vulnerable Code Examples
```swift
// illustrative, from R-CAR-1118 Miscellaneous SEC-02
UserDefaultsManager.shared.accessToken = response.accessToken
```

#### Recommended Secure Implementation
Keep tokens in the Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`)
and in Keystore-backed encrypted storage (Tink or
`EncryptedSharedPreferences`). Exclude them from backups (`dataExtractionRules`,
`isExcludedFromBackup`).

#### False Positive Considerations
- Non-sensitive flags (onboarding seen, theme).
- A helper whose name suggests plain storage but whose implementation encrypts.
  Read it first.

---

## Sensitive data exposure

### SR-DATA-001 — Credentials or personal data sent to analytics or third-party SDKs

- **Rule ID:** SR-DATA-001
- **Rule Name:** Credentials or personal data sent to analytics or third-party SDKs
- **Security Category:** Sensitive data exposure (MASVS-PRIVACY) · CWE-359
- **Severity:** Medium
- **Affected Platforms:** Android, iOS
- **Reference:** R-CAR-1117 App-wide SEC-13, Link account SEC-02, Bill payment SEC-01; R-CAR-1118 App-wide SEC-14, Notification center SEC-01, Chatbot support SEC-01

#### Description
Login identifiers (phone, email), card brand and last four digits, or an
unsalted hash of a phone or account number are set as analytics user IDs,
event parameters, campaign callbacks or chat attributes. An unsalted hash of a
phone number can be reversed by trying every number.

#### Root Cause
Analytics calls reuse whatever identifier is at hand.

#### Detection Logic
- `setUserId`, `setUserProperty`, `logEvent`, `setCustomKey`, AppsFlyer
  `customerUserId`, Genesys/CRM attributes with values from login, profile,
  MSISDN, email or payment models.
- `SHA-256` or `MD5` of an MSISDN or account number without a secret salt.

#### Vulnerable Code Examples
```kotlin
// illustrative, from R-CAR-1117 App-wide SEC-13
analytics.setAnalyticsUserIdFromLoginCredential(loginId)   // raw phone or email
```

#### Recommended Secure Implementation
Use an opaque, server-issued user ID, or an HMAC with a secret kept on the
server. Never send raw credentials or card data. Review every third-party SDK
call against a data inventory.

#### False Positive Considerations
- Masked values (last four digits alone, with no brand-plus-account context) where
  privacy policy allows them.
- An analytics manager that hashes with a secret salt internally. Check it
  before reporting.

### SR-DATA-002 — Verbose network or debug logging in release builds

- **Rule ID:** SR-DATA-002
- **Rule Name:** Verbose network or debug logging in release builds
- **Security Category:** Sensitive data exposure (MASVS-PRIVACY, MASVS-CODE) · CWE-532
- **Severity:** Medium
- **Affected Platforms:** Android, iOS
- **Reference:** R-CAR-1117 App-wide SEC-14; R-CAR-1118 App-wide SEC-11, SEC-12, Miscellaneous SEC-05

#### Description
HTTP headers and bodies (tokens, decrypted payloads, PII), JWT claims, pin
hashes or chat messages are written to logcat or the console, or captured by an
in-app inspector, in builds that ship.

#### Root Cause
Debug tools (curl printers, Chucker, `print`, logger wrappers) are added
without a build-type gate or redaction.

#### Detection Logic
- `HttpLoggingInterceptor` at `BODY`, curl-printer interceptors,
  `ChuckerInterceptor` (check for the `library-no-op` release artifact),
  `redactHeaders(emptySet())`.
- `print`, `NSLog`, `os_log` or `Log.d` with headers, bodies or tokens, with no
  `#if DEBUG` / `BuildConfig.DEBUG` gate.

#### Vulnerable Code Examples
```kotlin
// illustrative, from R-CAR-1118 Miscellaneous SEC-05
builder.addInterceptor(ChuckerInterceptor.Builder(context).redactHeaders(emptySet()).maxContentLength(250_000L).build())
```

#### Recommended Secure Implementation
Add network loggers only in debug builds (`debugImplementation`, no-op release
artifacts, `#if DEBUG`), and redact `Authorization`, cookies and sensitive body
fields even there. Strip `Log.d`/`Log.v` in release with R8 rules.

#### False Positive Considerations
- Loggers gated by `BuildConfig.DEBUG` or `debugImplementation`.
- Loggers that print only path and status.

### SR-DATA-003 — Sensitive screens not protected from screenshots and the app switcher

- **Rule ID:** SR-DATA-003
- **Rule Name:** Sensitive screens not protected from screenshots and the app switcher
- **Security Category:** Sensitive data exposure (MASVS-PLATFORM) · CWE-200
- **Severity:** Low
- **Affected Platforms:** Android, iOS
- **Reference:** VULN-32718; R-CAR-1118 Notification center SEC-02

#### Description
Screens that show account, payment or premium content can be captured by
screenshots, screen recording or the app-switcher snapshot.

#### Root Cause
No `FLAG_SECURE`, or no iOS equivalent (a secure-text-entry overlay or a blur
on `willResignActive`), on sensitive screens.

#### Detection Logic
- Android: no `FLAG_SECURE` (`window.setFlags(...FLAG_SECURE...)` or
  `addFlags`) on activities or composables showing sensitive data.
- iOS: no screenshot shield or app-switcher blur.
- Compare platforms and remote-config gates. Protection on one platform only is
  a parity finding.

#### Vulnerable Code Examples
VULN-32718 cites no code. Its recommended fix:
```java
getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
```

#### Recommended Secure Implementation
Set `FLAG_SECURE` on sensitive screens (or app-wide in release builds) and use
the iOS equivalent. Protect premium media with DRM such as Widevine (VULN-32718).

#### False Positive Considerations
- Screens with no sensitive data, and a deliberate product decision recorded in
  the requirements.

---

## Platform hardening and client-side trust

### SR-RES-001 — Integrity or anti-tamper verdict decided on the device

- **Rule ID:** SR-RES-001
- **Rule Name:** Integrity or anti-tamper verdict decided on the device
- **Security Category:** Platform hardening (MASVS-RESILIENCE) · CWE-602
- **Severity:** High
- **Affected Platforms:** Android, iOS
- **Reference:** R-CAR-1117 App-wide SEC-10; R-CAR-1118 App-wide SEC-07, SEC-08

#### Description
The app decrypts a Play Integrity or App Attest verdict itself and returns a
boolean, or checks it with a rule that always passes (for example a certificate
digest against `listOf("")`). Root or jailbreak detection that can be skipped
by a build flag works the same way. A modified app can flip the local result.

#### Root Cause
The verdict is evaluated on the client instead of being sent to the server and
evaluated there.

#### Detection Logic
- Play Integrity token decryption or JWE parsing on the device;
  `certificateSha256Digest`, `appRecognitionVerdict` or `deviceRecognitionVerdict`
  compared locally; empty expected lists.
- Root and jailbreak checks gated by `BuildConfig.DEBUG ||` a remote flag, or
  whose result only changes the UI.

#### Vulnerable Code Examples
```kotlin
// illustrative, from R-CAR-1118 App-wide SEC-07
val expected = listOf("")
val ok = verdict.certificateSha256Digest.all { d -> expected.any { d.contains(it) } }   // always true
```

#### Recommended Secure Implementation
Send the integrity token to the back end, decrypt and evaluate it there, and
make the server deny sensitive operations. The app should only fetch and send
tokens.

#### False Positive Considerations
- Local checks used only for UX (a warning banner) while the server enforces.
  Look for that before reporting.

### SR-RES-002 — Debug mocks or developer tools reachable in release builds

- **Rule ID:** SR-RES-002
- **Rule Name:** Debug mocks or developer tools reachable in release builds
- **Security Category:** Platform hardening (MASVS-CODE) · CWE-489
- **Severity:** Medium
- **Affected Platforms:** Android, iOS
- **Reference:** R-CAR-1117 App-wide SEC-12, Bill payment SEC-02; R-CAR-1118 App-wide SEC-15, Superapp home SEC-02

#### Description
Mock repositories, response overlays or network-logger buttons are compiled
into release builds behind a runtime flag. If the flag turns on, a payment can
look successful without reaching the server, or real login responses are
rewritten.

#### Root Cause
Test scaffolding is gated by a runtime boolean instead of a build type or
source set.

#### Detection Logic
- Names such as `*Mock`, `*DebugMock`, `Fake*`, `isDebugPresent` or
  `mockEnabled`, referenced from production code without a
  `BuildConfig.DEBUG` / `#if DEBUG` gate or a debug-only source set.

#### Vulnerable Code Examples
```kotlin
// illustrative, from R-CAR-1117 Bill payment SEC-02
if (PaymentsFlowMock.enabled) return PaymentResult.Success(mock)
```

#### Recommended Secure Implementation
Move mocks to `src/debug` or test source sets (Android) or wrap them in
`#if DEBUG` (iOS), so release builds cannot contain them.

#### False Positive Considerations
- Mocks referenced only from tests or previews.
- Flags that the build sets to a compile-time `false` constant in release.

### SR-RES-003 — Client-side enforcement of business or eligibility rules

- **Rule ID:** SR-RES-003
- **Rule Name:** Client-side enforcement of business or eligibility rules
- **Security Category:** Client-side trust (MASVS-PLATFORM) · CWE-602
- **Severity:** Medium
- **Affected Platforms:** Android, iOS, Backend
- **Reference:** VULN-32723, VULN-32725; R-CAR-1118 Bill payment SEC-01, Invoice payment SEC-01, Topup SEC-02, Auto pay SEC-02

#### Description
Amounts, currencies, eligibility, geo-restriction or completion of a hosted
payment are decided on the device and sent to the server as facts. A modified
client, a location-spoofing app or a proxy can change them.

#### Root Cause
Rules are implemented where the UI needs them, and the server trusts the result.

#### Detection Logic
- Amount, currency, line-of-business or eligibility values computed on the
  client and placed in request bodies.
- Geo checks based on a single device location signal; success decided by
  matching a redirect URL.
- Cite the business-logic `BL-xx` row for the rule, and report only the
  security consequence.

#### Vulnerable Code Examples
```swift
// illustrative, from R-CAR-1118 Invoice payment SEC-01
let amount = checkoutAmountOverride ?? context.amount   // sent to the server as the charge amount
```

#### Recommended Secure Implementation
The server recomputes or validates every amount, eligibility and status from its
own data. For geo restriction, combine server-side IP checks with device signals
and spoofing detection (VULN-32723, VULN-32725). Confirm hosted-payment status
with a server call, not a URL match.

#### False Positive Considerations
- Client checks that only improve UX, where the server is known to validate.
  Mark them `Requirements Gap` when the server behaviour is unknown, not
  Confirmed.

### SR-RES-004 — Minimum OS version below the security baseline

- **Rule ID:** SR-RES-004
- **Rule Name:** Minimum OS version below the security baseline
- **Security Category:** Platform hardening (MASVS-CODE) · CWE-1104
- **Severity:** Low
- **Affected Platforms:** Android, iOS
- **Reference:** VULN-32720

#### Description
The app installs on OS versions that no longer get security patches, so platform
protections it relies on may be missing.

#### Root Cause
A low `minSdk` or deployment target kept for reach without a security review.

#### Detection Logic
- `minSdk` / `minSdkVersion` in Gradle, or `IPHONEOS_DEPLOYMENT_TARGET`.
  VULN-32720 recommends Android 10 (API 29) or later. Report the actual value
  and the gap; the threshold is a policy decision.

#### Vulnerable Code Examples
```kotlin
// build.gradle.kts (VULN-32720 confirms minSdk = 26)
defaultConfig { minSdk = 26 }
```

#### Recommended Secure Implementation
Raise the minimum after a product decision, or document the risk acceptance.
Check that security-critical dependencies support the new minimum.

#### False Positive Considerations
- A risk that is already accepted and recorded. Report it as Info.

---

## Out of scope for the static client audit

These came up in the sources but cannot be detected in the app code. They are
kept so the knowledge base stays complete, and the audit lists them under
*Not assessed* when relevant.

### SR-SRV-001 — API response exposes more data than the client needs

- **Rule ID:** SR-SRV-001
- **Rule Name:** API response exposes more data than the client needs
- **Security Category:** Sensitive data exposure (server) · CWE-213
- **Severity:** Medium
- **Affected Platforms:** Backend
- **Reference:** VULN-32724

#### Description
The back end or CMS returns internal metadata, such as staff email addresses,
that the app never shows. That information helps social engineering.

#### Root Cause
Responses serialise whole records instead of a client view.

#### Detection Logic
Not detectable from app code alone. A client model with fields the app never
reads is only a hint; record it under *Not assessed*.

#### Vulnerable Code Examples
None in the source ticket.

#### Recommended Secure Implementation
Return minimal fields (data minimisation), classify data, and review responses
regularly (VULN-32724).

#### False Positive Considerations
Fields that the app reads in a module the current audit did not cover.

---

## Adding or changing a rule

The audit proposes rules but never merges them.

1. When a finding has no matching rule, the security pass sets **Rule** to `NEW`
   and adds a row to the report's *Proposed rules* table: proposed name,
   category, the finding IDs it came from, the cited code, and the closest
   existing rule with what is missing from it.
2. After the run, Mirror AI writes `proposed-security-rules.md` next to the
   report. It keeps only proposals backed by at least one finding with a file
   citation. It drops proposals that name a rule ID or repeat an existing rule's
   name, and repeats within the report. It also lists findings whose Rule ID is
   not defined in this file.
3. A person reviews the proposal against the cited code and opens a PR to this
   file. They either add a new rule with the next free number in its area or
   extend an existing rule's Detection Logic, False Positive Considerations or
   Reference. Never remove an existing reference.
4. Record the change in the change log below.

## Change log

| Date | Change | Source |
|------|--------|--------|
| 2026-11-18 | First version: 27 rules from 23 VULN tickets and two Mirror AI security reports. Google Sheets `SHEET-A` and `SHEET-B` pending. | JQL `project = VULN AND statusCategory != Done AND (summary ~ "panama" OR description ~ "panama") ORDER BY created DESC`; R-CAR-1117; R-CAR-1118 |
