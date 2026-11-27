#!/usr/bin/env node
/**
 * Build and sign the lightweight native Android APK for AGY Studio Remote.
 * - Auto-detects JDK 17 (Homebrew openjdk@17 / JAVA_HOME) & Android SDK (Homebrew android-commandlinetools / ANDROID_HOME)
 * - Auto-generates a persistent local release keystore under ~/.gemini/antigravity/anti-claude/remote/android-release.jks (0600)
 * - Outputs signed APK to ~/.gemini/antigravity/anti-claude/remote/AGY-Studio-Remote.apk
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(REPO_ROOT, 'remote', 'android');
const STATE_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'anti-claude', 'remote');
const KEYSTORE_PATH = path.join(STATE_DIR, 'android-release.jks');
const KEYSTORE_META_PATH = path.join(STATE_DIR, 'android-release.json');
const OUTPUT_APK_PATH = path.join(STATE_DIR, 'AGY-Studio-Remote.apk');
const OUTPUT_META_PATH = path.join(STATE_DIR, 'android-latest.json');

function readGradleVersionInfo() {
  const gradlePath = path.join(ANDROID_DIR, 'app', 'build.gradle.kts');
  const src = fs.readFileSync(gradlePath, 'utf8');
  const codeMatch = /versionCode\s*=\s*(\d+)/.exec(src);
  const nameMatch = /versionName\s*=\s*"([^"]+)"/.exec(src);
  return {
    versionCode: codeMatch ? Number(codeMatch[1]) : 1,
    versionName: nameMatch ? nameMatch[1] : '0.0.0',
  };
}

function resolveJavaHome() {
  const candidates = [
    process.env.AGY_JAVA_HOME,
    '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    '/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    process.env.JAVA_HOME,
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'bin', 'java'))) return dir;
  }
  throw new Error('JDK 17 not found. Install via: brew install openjdk@17');
}

function resolveAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    '/opt/homebrew/share/android-commandlinetools',
    '/usr/local/share/android-commandlinetools',
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'platforms'))) return dir;
  }
  throw new Error('Android SDK not found. Install via: brew install --cask android-commandlinetools');
}

function ensureReleaseKeystore(javaHome) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const keyAlias = 'agy-remote';
  if (fs.existsSync(KEYSTORE_PATH) && fs.existsSync(KEYSTORE_META_PATH)) {
    const meta = JSON.parse(fs.readFileSync(KEYSTORE_META_PATH, 'utf8'));
    if (meta && typeof meta.password === 'string' && meta.password.length >= 12) {
      return { keystorePath: KEYSTORE_PATH, password: meta.password, keyAlias: meta.keyAlias || keyAlias };
    }
  }
  const password = crypto.randomBytes(18).toString('base64url');
  const keytool = path.join(javaHome, 'bin', 'keytool');
  if (fs.existsSync(KEYSTORE_PATH)) fs.unlinkSync(KEYSTORE_PATH);
  execFileSync(
    keytool,
    [
      '-genkeypair',
      '-v',
      '-keystore',
      KEYSTORE_PATH,
      '-storepass',
      password,
      '-keypass',
      password,
      '-alias',
      keyAlias,
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '10000',
      '-dname',
      'CN=AGY Studio Remote, OU=Local, O=AGY Studio, L=Local, ST=Local, C=US',
    ],
    { stdio: 'pipe' }
  );
  fs.chmodSync(KEYSTORE_PATH, 0o600);
  fs.writeFileSync(
    KEYSTORE_META_PATH,
    JSON.stringify({ keyAlias, password, createdAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 }
  );
  return { keystorePath: KEYSTORE_PATH, password, keyAlias };
}

function main() {
  const isDebug = process.argv.includes('--debug');
  const javaHome = resolveJavaHome();
  const androidHome = resolveAndroidSdk();
  const gradlew = path.join(ANDROID_DIR, 'gradlew');
  if (!fs.existsSync(gradlew)) {
    throw new Error(`Missing Gradle wrapper at ${gradlew}`);
  }

  fs.writeFileSync(
    path.join(ANDROID_DIR, 'local.properties'),
    `sdk.dir=${androidHome.replace(/\\/g, '\\\\')}\n`,
    'utf8'
  );

  const env = {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_HOME: androidHome,
    ANDROID_SDK_ROOT: androidHome,
    PATH: `${path.join(javaHome, 'bin')}:${path.join(androidHome, 'platform-tools')}:${process.env.PATH || ''}`,
  };

  if (!isDebug) {
    const signing = ensureReleaseKeystore(javaHome);
    env.AGY_KEYSTORE_PATH = signing.keystorePath;
    env.AGY_KEYSTORE_PASSWORD = signing.password;
    env.AGY_KEY_ALIAS = signing.keyAlias;
    env.AGY_KEY_PASSWORD = signing.password;
  }

  const task = isDebug ? 'assembleDebug' : 'assembleRelease';
  const res = spawnSync(gradlew, [task, '--no-daemon'], {
    cwd: ANDROID_DIR,
    env,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    process.exit(res.status || 1);
  }

  const builtApk = path.join(
    ANDROID_DIR,
    'app',
    'build',
    'outputs',
    'apk',
    isDebug ? 'debug' : 'release',
    isDebug ? 'app-debug.apk' : 'app-release.apk'
  );
  if (!fs.existsSync(builtApk)) {
    throw new Error(`Expected APK not found at ${builtApk}`);
  }

  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const destPath = isDebug ? path.join(STATE_DIR, 'AGY-Studio-Remote-debug.apk') : OUTPUT_APK_PATH;
  fs.copyFileSync(builtApk, destPath);
  const buf = fs.readFileSync(destPath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const { versionCode, versionName } = readGradleVersionInfo();

  if (!isDebug) {
    const meta = {
      schema: 1,
      versionCode,
      versionName,
      filename: 'AGY-Studio-Remote.apk',
      bytes: buf.length,
      sha256,
      builtAt: new Date().toISOString(),
    };
    const tmpMeta = `${OUTPUT_META_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmpMeta, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpMeta, OUTPUT_META_PATH);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        variant: isDebug ? 'debug' : 'release',
        versionCode,
        versionName,
        apkPath: destPath,
        metaPath: isDebug ? null : OUTPUT_META_PATH,
        bytes: buf.length,
        mb: Number((buf.length / (1024 * 1024)).toFixed(2)),
        sha256,
      },
      null,
      2
    )
  );
}

main();
