/**
 * The security skill (prompts/skills/security-skill.md) is opt-in. When it is
 * on, every module gets a module-level Security Analysis section, and the audit
 * gets one more section, "App-wide Security", that reads the security layers of
 * the whole app once: manifests, network and backup config, Info.plist,
 * entitlements, build and obfuscation config, lockfiles, and the network,
 * storage, crypto, session, logging and hardening code. A per-module pass never
 * sees those files (modules are picked by keyword), so app-wide controls are
 * judged here, once, instead of once per module.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isTestPath } from "./misc-scope.ts";
import { readSources, type RepoSource } from "./scan.ts";
import type { ModuleDef } from "./types.ts";

/** File name of the opt-in skill, without `.md`. */
export const SECURITY_SKILL = "security-skill";
/** Id of the App-wide Security section. */
export const SECURITY_MODULE_ID = "app-wide-security";
export const SECURITY_MODULE_LABEL = "App-wide Security";

/** True when MIRROR_AI_SECURITY is 1/on/true/yes. Off by default, so existing audits are unchanged. */
export function securityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|on|true|yes)$/i.test(env.MIRROR_AI_SECURITY?.trim() ?? "");
}

export function isSecurityDef(def: Pick<ModuleDef, "id">): boolean {
  return def.id === SECURITY_MODULE_ID;
}

/**
 * The passes a module runs: the App-wide Security section runs only the
 * security skill; every other module runs every pass.
 */
export function passesFor<T extends { id: string }>(def: Pick<ModuleDef, "id">, passes: T[]): T[] {
  return isSecurityDef(def) ? passes.filter((pass) => pass.id === SECURITY_SKILL) : passes;
}

const SKIP_DIRS = new Set(["node_modules", "build", ".git", ".gradle", "DerivedData", "out", "Pods", ".build", "Carthage", ".idea", ".swiftpm"]);

/** Non-code files that hold security configuration, by file name. */
const CONFIG_FILE = [
  /^AndroidManifest\.xml$/,
  /network_security_config.*\.xml$/i,
  /(backup|data_extraction)_?rules.*\.xml$/i,
  /^proguard-rules.*\.pro$/i,
  /^consumer-rules\.pro$/i,
  /^build\.gradle$/,
  /^libs\.versions\.toml$/,
  /^gradle\.properties$/,
  /^Info\.plist$/,
  /\.entitlements$/,
  /\.xcconfig$/,
  /^Podfile(\.lock)?$/,
  /^Package\.resolved$/,
  /^GoogleService-Info\.plist$/,
];

/** Code that implements a security layer: each pattern is one signal; more signals rank higher. */
const SECURITY_SIGNALS: RegExp[] = [
  // transport
  /CertificatePinner|X509TrustManager|TrustManager\b|HostnameVerifier|sslSocketFactory|network_security_config/,
  /URLSessionDelegate|didReceive\s+challenge|SecTrust|serverTrust|ServerTrustManager|pinnedCertificates|NSAllowsArbitraryLoads/,
  /OkHttpClient\.Builder|addInterceptor|addNetworkInterceptor/,
  // storage
  /EncryptedSharedPreferences|MasterKey|AndroidKeyStore|KeyStore\.getInstance|KeyGenParameterSpec/,
  /kSecClass|kSecAttrAccessible|SecItemAdd|SecItemCopyMatching|KeychainWrapper|Keychain\b/,
  /SQLCipher|SupportFactory|isExcludedFromBackup|NSURLIsExcludedFromBackupKey/,
  // crypto
  /Cipher\.getInstance|SecretKeySpec|IvParameterSpec|GCMParameterSpec|MessageDigest|Mac\.getInstance/,
  /CryptoKit|CommonCrypto|CCCrypt|AES\.GCM|SymmetricKey|SecKeyCreate/,
  /tink|Aead\b|KeysetHandle/i,
  // session and auth
  /BiometricPrompt|BiometricManager|LAContext|evaluatePolicy/,
  /refresh_?token|accessToken|jwt|JWT|Authorization["'\s]*[:,]/,
  // exposure
  /FLAG_SECURE|isSecureTextEntry|UIApplication\.userDidTakeScreenshotNotification|applicationWillResignActive/,
  /ClipboardManager|UIPasteboard/,
  // hardening
  /RootBeer|isRooted|isJailbroken|jailbreak|IntegrityManager|PlayIntegrity|DeviceCheck|AppAttest|isDebuggable|BuildConfig\.DEBUG|#if\s+DEBUG/,
  // web and entry points
  /addJavascriptInterface|setJavaScriptEnabled|WebViewClient|shouldOverrideUrlLoading|WKWebView|WKScriptMessageHandler|evaluateJavaScript/,
  /onNewIntent|getIntent\(\)\.data|intent\.data|application\(_:\s*open|continue\s+userActivity|onOpenURL|handleDeepLink|DeepLink/,
  // logging and analytics
  /HttpLoggingInterceptor|Timber\.plant|os_log|Logger\(|Crashlytics|setCustomKey|logEvent\(/,
];

/** Files whose names say they are a security layer, even before reading them. */
const SECURITY_NAME = /(Security|Secure|Crypto|Cipher|Encrypt|Decrypt|Keychain|KeyStore|Keystore|Pinning|Pinner|Trust|Session|Token|Auth|Biometric|Root|Jailbreak|Integrity|Interceptor|NetworkModule|HttpClient|ApiClient|Logger|Logging|DeepLink|WebView|Storage|Preference|DataStore|Prefs)/;

export interface ScoredFile {
  relativePath: string;
  score: number;
}

/** Security config files (non-code) under `root`, by relative path. */
export function securityConfigFiles(root: string): string[] {
  const resolved = path.resolve(root);
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!CONFIG_FILE.some((pattern) => pattern.test(entry.name))) continue;
      const relative = path.relative(resolved, full).split(path.sep).join("/");
      if (isTestPath(relative)) continue;
      out.push(relative);
    }
  };
  if (statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) visit(resolved);
  return out.sort();
}

/** How strongly a code file looks like a security layer: one point per distinct signal, plus a name bonus. */
export function securityScore(source: Pick<RepoSource, "relativePath" | "text">): number {
  let score = SECURITY_SIGNALS.reduce((sum, pattern) => sum + (pattern.test(source.text) ? 1 : 0), 0);
  if (SECURITY_NAME.test(path.basename(source.relativePath))) score += 2;
  return score;
}

/** Code files that implement a security layer, strongest first. */
export function securityCodeFiles(root: string, minScore = 2): ScoredFile[] {
  return readSources(root)
    .filter((source) => !isTestPath(source.relativePath))
    .map((source) => ({ relativePath: source.relativePath, score: securityScore(source) }))
    .filter((file) => file.score >= minScore)
    .sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath));
}

/**
 * The files the App-wide Security section reads on one platform: config files
 * first (small, and they settle backup, cleartext, ATS, debuggable and
 * entitlements outright), then security code by strength. The budget reads in
 * this order and lists what it could not fit as unread.
 */
export function securityFiles(root: string): string[] {
  return [...securityConfigFiles(root), ...securityCodeFiles(root).map((file) => file.relativePath)];
}

/** The App-wide Security section, or null when neither platform has a security file. */
export function securityBaselineDef(androidPath: string, iosPath: string): ModuleDef | null {
  const android = securityFiles(androidPath);
  const ios = securityFiles(iosPath);
  if (android.length === 0 && ios.length === 0) return null;
  return {
    id: SECURITY_MODULE_ID,
    label: SECURITY_MODULE_LABEL,
    keywords: [],
    files: { android, ios },
    ordered: true,
  };
}

/** Reads a file that is not a code source (XML, plist, toml), for the App-wide Security section. */
export function readConfigSource(root: string, relativePath: string): RepoSource | null {
  try {
    const text = readFileSync(path.join(root, relativePath), "utf8");
    return { relativePath, text, lower: text.toLowerCase() };
  } catch {
    return null;
  }
}

/** Brief for the App-wide Security section. */
export function securityBriefLines(def: ModuleDef): string[] {
  return [
    `Module: **${def.label}** — the security layers of the whole app, read once.`,
    "- Publish **only** `### 4. Security Analysis`. This section has no Business Logic, UI or API section.",
    "- Cover domains 1, 3, 4, 5, 11, 12 and 13 and the app-wide parts of 2 and 6. Mark every finding `App-wide`.",
    "- This section owns the full Control parity and Hard-coded secrets tables for the app.",
    `- Files: ${def.files?.android.length ?? 0} Android, ${def.files?.ios.length ?? 0} iOS (config files first, then security code by strength).`,
  ];
}
