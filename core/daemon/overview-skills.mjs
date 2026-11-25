/**
 * 4.6 Local Skills, Custom Agents, Git Status, Overview Snapshot & Host RPC Router
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  ALLOWED_AGENT_TOOLS,
  GLOBAL_AGENTS_DIR,
  GLOBAL_SKILLS_DIR,
  HOME,
  NATIVE_PROJECTS_DIR,
  RESERVED_AGENT_NAMES,
  attachedTargets,
  readJsonOrFallback,
  setBounded,
  writeAtomicUtf8
} from './env.mjs';
import {
  getBundleHash,
  loadStudioPrefs,
  rebuildBundleIfNeeded,
  saveStudioPrefs,
  saveUiPrefs
} from './prefs-bundle.mjs';
import {
  deleteProjectScheduledTask,
  getRegisteredProjectDirs,
  isPathInsideDir,
  normalizeGitRemoteUrl,
  openExternalUrl,
  pickLocalFilesNative,
  pickLocalFolderNative,
  readProjectContext,
  resolveLocalProjectDir,
  revealLocalPath,
  saveProjectContext,
  saveProjectScheduledTask
} from './projects.mjs';

function formatYamlScalar(raw, alwaysQuote = false) {
  const s = String(raw ?? '').replace(/\r?\n/g, ' ').trim();
  if (
    !alwaysQuote &&
    /^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9._\-\s\u4e00-\u9fff]*$/.test(s) &&
    !/[:#\[\]{}&*!|>'"%@`,?\\]/.test(s) &&
    !/^(?:true|false|null|yes|no|on|off|~)$/i.test(s)
  ) {
    return s;
  }
  return JSON.stringify(s);
}

function sanitizeSkillFolderName(rawName) {
  const cleaned = String(rawName || '')
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  return cleaned;
}

export function createLocalSkill(payload, { skillsDir = GLOBAL_SKILLS_DIR } = {}) {
  const rawName = String(payload?.name || '').trim();
  const description = String(payload?.description || '').trim();
  const instructions = String(payload?.instructions || '').replace(/\r\n/g, '\n').trim();
  if (!rawName || !description || !instructions) {
    return { ok: false, error: 'required_fields_missing' };
  }
  const folderName = sanitizeSkillFolderName(rawName);
  if (!folderName) return { ok: false, error: 'invalid_skill_name' };
  fs.mkdirSync(skillsDir, { recursive: true });
  const targetDir = path.join(skillsDir, folderName);
  if (!isPathInsideDir(skillsDir, targetDir)) return { ok: false, error: 'invalid_skill_path' };
  if (fs.existsSync(targetDir) && !payload?.overwrite) {
    return { ok: false, error: 'skill_already_exists' };
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const yamlName = formatYamlScalar(rawName, false);
  const yamlDesc = formatYamlScalar(description, true);
  const content = `---\nname: ${yamlName}\ndescription: ${yamlDesc}\n---\n\n${instructions}\n`;
  const skillMdPath = path.join(targetDir, 'SKILL.md');
  writeAtomicUtf8(skillMdPath, content);
  return { ok: true, name: rawName, folderName, dirPath: targetDir, skillMdPath };
}

async function importLocalSkillNative() {
  const picked = await pickLocalFolderNative();
  if (!picked || !picked.ok || picked.canceled || !picked.folderPath) {
    return { ok: true, canceled: true };
  }
  const srcDir = path.resolve(picked.folderPath);
  const srcSkillMd = path.join(srcDir, 'SKILL.md');
  if (!fs.existsSync(srcSkillMd)) {
    return { ok: false, error: 'missing_skill_md' };
  }
  const baseName = sanitizeSkillFolderName(path.basename(srcDir));
  if (!baseName) return { ok: false, error: 'invalid_skill_name' };
  fs.mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true });
  let destName = baseName;
  let destDir = path.join(GLOBAL_SKILLS_DIR, destName);
  let idx = 1;
  while (fs.existsSync(destDir)) {
    if (path.resolve(destDir) === srcDir) {
      return { ok: true, canceled: false, alreadyInstalled: true, folderName: destName, dirPath: destDir };
    }
    destName = `${baseName}-${idx++}`;
    destDir = path.join(GLOBAL_SKILLS_DIR, destName);
  }
  if (!isPathInsideDir(GLOBAL_SKILLS_DIR, destDir)) return { ok: false, error: 'invalid_skill_path' };
  fs.cpSync(srcDir, destDir, { recursive: true });
  return { ok: true, canceled: false, folderName: destName, dirPath: destDir, skillMdPath: path.join(destDir, 'SKILL.md') };
}

export function createLocalAgent(payload, { agentsDir = GLOBAL_AGENTS_DIR } = {}) {
  const rawName = String(payload?.name || '').trim();
  const description = String(payload?.description || '').trim();
  const systemPrompt = String(payload?.systemPrompt || '').replace(/\r\n/g, '\n').trim();
  if (!rawName || !description || !systemPrompt) {
    return { ok: false, error: 'required_fields_missing' };
  }
  const fileSlug = sanitizeSkillFolderName(rawName);
  if (!fileSlug) return { ok: false, error: 'invalid_agent_name' };
  if (RESERVED_AGENT_NAMES.has(fileSlug.toLowerCase())) {
    return { ok: false, error: 'reserved_agent_name' };
  }
  fs.mkdirSync(agentsDir, { recursive: true });
  const targetFile = path.join(agentsDir, `${fileSlug}.md`);
  if (!isPathInsideDir(agentsDir, targetFile)) return { ok: false, error: 'invalid_agent_path' };
  if (fs.existsSync(targetFile) && !payload?.overwrite) {
    return { ok: false, error: 'agent_already_exists' };
  }

  const roleMode = String(payload?.roleMode || 'subagent');
  const subagent = roleMode !== 'main_only';
  const mainAgent = roleMode === 'both' || roleMode === 'main_only';
  const rawTools = Array.isArray(payload?.tools) ? payload.tools : ['read_file', 'search_web'];
  const tools = rawTools.filter((t) => ALLOWED_AGENT_TOOLS.includes(t));
  const finalTools = tools.length ? tools : ['read_file'];

  const yamlName = formatYamlScalar(fileSlug, false);
  const yamlDesc = formatYamlScalar(description, true);
  const content = [
    '---',
    `name: ${yamlName}`,
    `description: ${yamlDesc}`,
    `subagent: ${subagent ? 'true' : 'false'}`,
    `mainAgent: ${mainAgent ? 'true' : 'false'}`,
    `tools: [${finalTools.join(', ')}]`,
    '---',
    '',
    systemPrompt,
    ''
  ].join('\n');
  writeAtomicUtf8(targetFile, content);
  return { ok: true, name: fileSlug, filePath: targetFile, dirPath: agentsDir };
}

async function importLocalAgentNative() {
  const picked = await pickLocalFilesNative();
  if (!picked || !picked.ok || picked.canceled || !Array.isArray(picked.paths) || picked.paths.length === 0) {
    return { ok: true, canceled: true };
  }
  const mdFiles = picked.paths.filter((p) => /\.md$/i.test(p) && fs.existsSync(p));
  if (!mdFiles.length) return { ok: false, error: 'missing_md_file' };
  fs.mkdirSync(GLOBAL_AGENTS_DIR, { recursive: true });
  const imported = [];
  for (const src of mdFiles) {
    const absSrc = path.resolve(src);
    const stem = sanitizeSkillFolderName(path.basename(absSrc, path.extname(absSrc)));
    if (!stem) continue;
    let destName = stem;
    let destPath = path.join(GLOBAL_AGENTS_DIR, `${destName}.md`);
    let idx = 1;
    while (fs.existsSync(destPath)) {
      if (path.resolve(destPath) === absSrc) break;
      destName = `${stem}-${idx++}`;
      destPath = path.join(GLOBAL_AGENTS_DIR, `${destName}.md`);
    }
    if (!isPathInsideDir(GLOBAL_AGENTS_DIR, destPath)) continue;
    if (path.resolve(destPath) !== absSrc) fs.copyFileSync(absSrc, destPath);
    imported.push({ name: destName, filePath: destPath });
  }
  if (!imported.length) return { ok: false, error: 'invalid_agent_name' };
  return { ok: true, canceled: false, imported, dirPath: GLOBAL_AGENTS_DIR };
}

const CONNECTOR_DISPLAY_OVERRIDES = {
  'chrome-devtools': 'Chrome devtools',
  'chrome-devtools_chrome-devtools': 'Chrome devtools',
  github: 'GitHub',
  gitlab: 'GitLab',
  playwright: 'Playwright',
  perplexity: 'Perplexity',
  gdrive: 'Google Drive',
  gcalendar: 'Google Calendar'
};

function prettifyConnectorName(rawId) {
  const s = String(rawId || '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (CONNECTOR_DISPLAY_OVERRIDES[lower]) return CONNECTOR_DISPLAY_OVERRIDES[lower];
  const spaced = s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : s;
}

const overviewGitCache = new Map();
const overviewGitInFlight = new Map();
const projectWorkspaceCache = new Map();
const projectWorkspaceInFlight = new Map();
const commitDetailCache = new Map();

export function normalizeNumstatPath(rawPath) {
  const s = String(rawPath || '').trim();
  if (!s) return '';
  const braceM = s.match(/^(.*?)\{([^{}]*?)\s*=>\s*([^{}]*?)\}(.*)$/);
  if (braceM) {
    return `${braceM[1]}${braceM[3].trim()}${braceM[4]}`.replace(/\/{2,}/g, '/');
  }
  const arrowIdx = s.indexOf(' => ');
  if (arrowIdx !== -1) {
    return s.slice(arrowIdx + 4).trim();
  }
  return s;
}

export function parseNumstatZ(numstatZ) {
  const entries = [];
  if (!numstatZ) return entries;
  const parts = String(numstatZ).split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i].replace(/^(?:\r?\n)+/, '');
    if (!raw) continue;
    const cols = raw.split('\t');
    if (cols.length < 3) continue;
    const a = parseInt(cols[0], 10);
    const d = parseInt(cols[1], 10);
    const added = Number.isFinite(a) ? a : 0;
    const deleted = Number.isFinite(d) ? d : 0;
    let filePath = cols.slice(2).join('\t');
    if (filePath === '' && i + 2 < parts.length) {
      // git --numstat -z encodes renames/copies as "<added>\t<deleted>\t\0<old>\0<new>\0"
      filePath = parts[i + 2];
      i += 2;
    }
    if (!filePath) continue;
    entries.push({ path: filePath, added, deleted });
  }
  return entries;
}

function parseNumstatPerFile(numstatZ) {
  const map = new Map();
  for (const entry of parseNumstatZ(numstatZ)) {
    const prev = map.get(entry.path) || { added: 0, deleted: 0 };
    prev.added += entry.added;
    prev.deleted += entry.deleted;
    map.set(entry.path, prev);
  }
  return map;
}

function parsePorcelainDirtyFiles(porcelainZ, numstatMap) {
  const files = [];
  if (!porcelainZ) return files;
  const entries = String(porcelainZ).split('\0');
  for (let i = 0; i < entries.length && files.length < 30; i += 1) {
    const rec = entries[i];
    if (!rec || rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const filePath = rec.slice(3);
    if (!filePath) continue;
    if (xy.includes('R') || xy.includes('C')) i += 1;
    let status = 'M';
    if (xy === '??') status = '?';
    else if (xy.includes('D')) status = 'D';
    else if (xy.includes('A')) status = 'A';
    else if (xy.includes('R')) status = 'R';
    const stat = numstatMap.get(filePath) || { added: 0, deleted: 0 };
    files.push({ path: filePath, status, added: stat.added, deleted: stat.deleted });
  }
  return files;
}

export async function readGitCommitDetailAsync(rawDir, rawHash) {
  const absDir = resolveLocalProjectDir(rawDir);
  if (!absDir) return { ok: false, error: 'invalid_project_dir' };
  const hash = String(rawHash || '').trim();
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return { ok: false, error: 'invalid_commit_hash' };
  const cacheKey = `${absDir}:${hash.toLowerCase()}`;
  const cached = commitDetailCache.get(cacheKey);
  if (cached) return cached;

  const commitRev = `${hash}^{commit}`;
  const [metaOut, statOut] = await Promise.all([
    execGitAsync(absDir, ['show', '--no-patch', '--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%b', '--date=short', commitRev], 1200),
    execGitAsync(absDir, ['show', '--numstat', '-z', '--format=', commitRev], 1200)
  ]);
  if (!metaOut) return { ok: false, error: 'commit_not_found' };
  const [fullHash = '', shortHash = hash, author = '', date = '', subject = '', body = ''] = metaOut.split('\x1f');
  if (!fullHash.trim()) return { ok: false, error: 'commit_not_found' };

  const allFiles = parseNumstatZ(statOut);
  const res = {
    ok: true,
    fullHash: fullHash.trim(),
    hash: shortHash.trim(),
    author: author.trim(),
    date: date.trim(),
    subject: subject.trim(),
    body: body.trim().slice(0, 600),
    files: allFiles.slice(0, 30),
    totalFiles: allFiles.length
  };
  setBounded(commitDetailCache, cacheKey, res, 64);
  return res;
}

function execGitAsync(absDir, args, timeoutMs = 1200) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', absDir, ...args],
      { timeout: timeoutMs, maxBuffer: 256 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err) resolve(null);
        else resolve(String(stdout || ''));
      }
    );
  });
}

function parseNumstatOutput(numstatZ) {
  let added = 0;
  let deleted = 0;
  for (const entry of parseNumstatZ(numstatZ)) {
    added += entry.added;
    deleted += entry.deleted;
  }
  return { added, deleted };
}

export async function readOverviewGitStatusAsync(absDir) {
  const now = Date.now();
  const cached = overviewGitCache.get(absDir);
  if (cached && now - cached.ts < 5000) return cached.git;
  if (overviewGitInFlight.has(absDir)) return overviewGitInFlight.get(absDir);

  const task = (async () => {
    let git = null;
    try {
      const [statusOut, headNumstat] = await Promise.all([
        execGitAsync(absDir, ['status', '--porcelain=v2', '--branch'], 1200),
        execGitAsync(absDir, ['diff', 'HEAD', '--numstat', '-z'], 1200)
      ]);
      if (statusOut !== null) {
        let branch = '';
        let changedFiles = 0;
        for (const line of statusOut.split(/\r?\n/)) {
          if (!line) continue;
          if (line.startsWith('# branch.head ')) {
            const rawHead = line.slice('# branch.head '.length).trim();
            branch = rawHead === '(detached)' ? 'HEAD' : rawHead;
          } else if (!line.startsWith('#')) {
            changedFiles += 1;
          }
        }
        if (branch) {
          let numstatZ = headNumstat;
          if (numstatZ === null && changedFiles > 0) {
            const [unstaged, staged] = await Promise.all([
              execGitAsync(absDir, ['diff', '--numstat', '-z'], 1000),
              execGitAsync(absDir, ['diff', '--cached', '--numstat', '-z'], 1000)
            ]);
            numstatZ = `${unstaged || ''}\0${staged || ''}`;
          }
          const { added, deleted } = parseNumstatOutput(numstatZ);
          git = { branch, added, deleted, changedFiles };
        }
      }
    } catch {
      git = null;
    }
    setBounded(overviewGitCache, absDir, { ts: Date.now(), git }, 32);
    return git;
  })().finally(() => {
    overviewGitInFlight.delete(absDir);
  });

  overviewGitInFlight.set(absDir, task);
  return task;
}

export async function readProjectWorkspaceStatusAsync(rawDir, { force = false } = {}) {
  const absDir = resolveLocalProjectDir(rawDir);
  if (!absDir) return { ok: false, error: 'invalid_project_dir' };
  if (force) {
    overviewGitCache.delete(absDir);
    projectWorkspaceCache.delete(absDir);
  }
  const now = Date.now();
  const cached = projectWorkspaceCache.get(absDir);
  if (!force && cached && now - cached.ts < 8000) return cached.data;
  if (projectWorkspaceInFlight.has(absDir)) return projectWorkspaceInFlight.get(absDir);

  const task = (async () => {
    let git = null;
    const recentCommits = [];
    let latestTag = null;
    let remoteUrl = '';
    let remoteLabel = '';
    let dirtyFiles = [];
    try {
      const [gitRes, logOut, tagOut, remoteOut, porcelainZ] = await Promise.all([
        readOverviewGitStatusAsync(absDir),
        execGitAsync(absDir, ['log', '-n', '3', '--format=%h%x1f%H%x1f%s%x1f%cr'], 1000),
        execGitAsync(absDir, ['describe', '--tags', '--abbrev=0'], 800),
        execGitAsync(absDir, ['config', '--get', 'remote.origin.url'], 800),
        execGitAsync(absDir, ['status', '--porcelain=v1', '-z'], 1200)
      ]);
      git = gitRes || null;
      if (logOut) {
        for (const line of logOut.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const [hash = '', fullHash = '', subject = '', relTime = ''] = line.split('\x1f');
          if (hash) {
            recentCommits.push({
              hash: hash.trim(),
              fullHash: fullHash.trim() || hash.trim(),
              subject: subject.trim(),
              relTime: relTime.trim()
            });
          }
        }
      }
      if (tagOut && tagOut.trim()) latestTag = tagOut.trim();
      const parsedRemote = normalizeGitRemoteUrl(remoteOut);
      if (parsedRemote) {
        remoteUrl = parsedRemote.url;
        remoteLabel = parsedRemote.label;
      }
      if (porcelainZ) {
        let numstatZ = await execGitAsync(absDir, ['diff', 'HEAD', '--numstat', '-z'], 1200);
        if (numstatZ === null) {
          const [unstaged, staged] = await Promise.all([
            execGitAsync(absDir, ['diff', '--numstat', '-z'], 1000),
            execGitAsync(absDir, ['diff', '--cached', '--numstat', '-z'], 1000)
          ]);
          numstatZ = `${unstaged || ''}\0${staged || ''}`;
        }
        dirtyFiles = parsePorcelainDirtyFiles(porcelainZ, parseNumstatPerFile(numstatZ));
      }
    } catch {}

    let pkgVersion = null;
    let scripts = [];
    try {
      const pkgPath = path.join(absDir, 'package.json');
      const st = fs.statSync(pkgPath, { throwIfNoEntry: false });
      if (st && st.isFile() && st.size > 0 && st.size < 65536) {
        const pkg = readJsonOrFallback(pkgPath, null);
        if (pkg && typeof pkg === 'object') {
          if (typeof pkg.version === 'string' && pkg.version.trim()) pkgVersion = pkg.version.trim();
          if (pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)) {
            scripts = Object.keys(pkg.scripts).slice(0, 16);
          }
        }
      }
    } catch {}

    const data = {
      ok: true,
      dirPath: absDir,
      git,
      recentCommits,
      latestTag,
      pkgVersion,
      scripts,
      remoteUrl,
      remoteLabel,
      dirtyFiles,
      fetchedAt: Date.now()
    };
    setBounded(projectWorkspaceCache, absDir, { ts: Date.now(), data }, 32);
    return data;
  })().finally(() => {
    projectWorkspaceInFlight.delete(absDir);
  });

  projectWorkspaceInFlight.set(absDir, task);
  return task;
}

function scanSkillsDirectory(dirPath, source, skillMap) {
  if (!dirPath) return;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    if (ent.name.startsWith('.')) continue;
    const skillDir = path.join(dirPath, ent.name);
    const skillMd = path.join(skillDir, 'SKILL.md');
    const st = fs.statSync(skillMd, { throwIfNoEntry: false });
    if (!st || !st.isFile()) continue;
    if (!skillMap.has(ent.name)) {
      skillMap.set(ent.name, { name: ent.name, path: skillMd, source });
    }
  }
}

export function collectOverviewSnapshot(payload = {}, opts = {}) {
  const homeDir = opts.homeDir ? path.resolve(opts.homeDir) : HOME;
  const geminiDir = opts.geminiDir ? path.resolve(opts.geminiDir) : path.join(homeDir, '.gemini');
  const configDir = opts.configDir ? path.resolve(opts.configDir) : path.join(geminiDir, 'config');
  const skillsDir = opts.skillsDir ? path.resolve(opts.skillsDir) : GLOBAL_SKILLS_DIR;
  const agentsDir = opts.agentsDir ? path.resolve(opts.agentsDir) : GLOBAL_AGENTS_DIR;
  const builtinSkillsDir = opts.builtinSkillsDir
    ? path.resolve(opts.builtinSkillsDir)
    : path.join(geminiDir, 'antigravity', 'builtin', 'skills');

  let absDir = '';
  const rawDir = typeof payload?.dirPath === 'string' ? payload.dirPath.trim() : '';
  if (rawDir) {
    const resolved = resolveLocalProjectDir(rawDir);
    if (resolved) absDir = resolved;
  }

  const workspace = {
    dirPath: absDir,
    name: absDir ? path.basename(absDir) || absDir : '',
    git: opts.gitResolved !== undefined ? opts.gitResolved : null
  };

  const rootCfg = readJsonOrFallback(path.join(configDir, 'config.json'), {});
  const pluginsCfg = rootCfg && typeof rootCfg.plugins === 'object' && rootCfg.plugins ? rootCfg.plugins : {};
  const enabledPlugins = Object.entries(pluginsCfg)
    .filter(([, cfg]) => !cfg || cfg.enabled !== false)
    .map(([name, cfg]) => ({
      name,
      cfg: cfg && typeof cfg === 'object' ? cfg : {},
      dir: path.join(configDir, 'plugins', name)
    }))
    .filter((p) => {
      const st = fs.statSync(p.dir, { throwIfNoEntry: false });
      return Boolean(st && st.isDirectory());
    });

  const rules = [];
  const globalAgentsPath = path.join(geminiDir, 'AGENTS.md');
  const globalAst = fs.statSync(globalAgentsPath, { throwIfNoEntry: false });
  if (globalAst && globalAst.isFile()) {
    rules.push({
      label: '~/.gemini/AGENTS.md',
      path: globalAgentsPath,
      scope: 'global',
      bytes: globalAst.size
    });
  }
  if (absDir) {
    const projAgentsPath = path.join(absDir, 'AGENTS.md');
    const projAst = fs.statSync(projAgentsPath, { throwIfNoEntry: false });
    if (projAst && projAst.isFile()) {
      rules.push({
        label: 'AGENTS.md',
        path: projAgentsPath,
        scope: 'project',
        bytes: projAst.size
      });
    }
  }
  for (const pl of enabledPlugins) {
    const rulesDir = path.join(pl.dir, 'rules');
    let ruleFiles = [];
    try {
      ruleFiles = fs.readdirSync(rulesDir).filter((f) => /\.md$/i.test(f));
    } catch {}
    for (const file of ruleFiles) {
      const fp = path.join(rulesDir, file);
      const st = fs.statSync(fp, { throwIfNoEntry: false });
      if (st && st.isFile()) {
        rules.push({
          label: `${pl.name}/${file}`,
          path: fp,
          scope: 'plugin',
          bytes: st.size
        });
      }
    }
  }

  const skillMap = new Map();
  scanSkillsDirectory(skillsDir, 'user', skillMap);
  for (const pl of enabledPlugins) {
    scanSkillsDirectory(path.join(pl.dir, 'skills'), 'plugin', skillMap);
  }
  scanSkillsDirectory(builtinSkillsDir, 'builtin', skillMap);
  const rankSource = { user: 0, plugin: 1, builtin: 2 };
  const allSkills = Array.from(skillMap.values()).sort((a, b) => {
    const r = (rankSource[a.source] ?? 9) - (rankSource[b.source] ?? 9);
    return r !== 0 ? r : a.name.localeCompare(b.name);
  });
  const userCount = allSkills.filter((s) => s.source === 'user').length;
  const skills = {
    total: allSkills.length,
    userCount,
    items: allSkills.slice(0, 80)
  };

  const agentItems = [];
  const seenAgentNames = new Set();
  const collectAgentMd = (dirPath, source) => {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if ((!ent.isFile() && !ent.isSymbolicLink()) || !/\.md$/i.test(ent.name)) continue;
      const name = ent.name.replace(/\.md$/i, '');
      if (seenAgentNames.has(name)) continue;
      seenAgentNames.add(name);
      agentItems.push({ name, path: path.join(dirPath, ent.name), source });
    }
  };
  collectAgentMd(agentsDir, 'user');
  for (const pl of enabledPlugins) {
    collectAgentMd(path.join(pl.dir, 'agents'), 'plugin');
  }
  const agents = { total: agentItems.length, items: agentItems };

  const connectors = [];
  const seenConnIds = new Set();
  const rootMcpPath = path.join(configDir, 'mcp_config.json');
  const rootMcp = readJsonOrFallback(rootMcpPath, null);
  if (rootMcp && typeof rootMcp.mcpServers === 'object' && rootMcp.mcpServers) {
    for (const [id, def] of Object.entries(rootMcp.mcpServers)) {
      if (!def || def.disabled === true || seenConnIds.has(id)) continue;
      seenConnIds.add(id);
      connectors.push({ id, name: prettifyConnectorName(id), kind: 'mcp', configPath: rootMcpPath });
    }
  }
  for (const pl of enabledPlugins) {
    const plMcpPath = path.join(pl.dir, 'mcp_config.json');
    const plMcp = readJsonOrFallback(plMcpPath, null);
    if (plMcp && typeof plMcp.mcpServers === 'object' && plMcp.mcpServers) {
      for (const [id, def] of Object.entries(plMcp.mcpServers)) {
        if (!def || def.disabled === true || seenConnIds.has(id)) continue;
        seenConnIds.add(id);
        connectors.push({ id, name: prettifyConnectorName(id), kind: 'mcp', configPath: plMcpPath });
      }
    }
    const plJsonPath = path.join(pl.dir, 'plugin.json');
    const plJson = readJsonOrFallback(plJsonPath, null);
    const hasAuth = fs.existsSync(path.join(pl.dir, 'auth.json'));
    const isExternalConnector = Boolean(
      plJson && (pl.cfg.installedFrom || plJson.auth || plJson.cli || plJson.mcp || hasAuth)
    );
    if (isExternalConnector && !seenConnIds.has(pl.name)) {
      seenConnIds.add(pl.name);
      connectors.push({
        id: pl.name,
        name: String(plJson.displayName || plJson.name || prettifyConnectorName(pl.name)),
        kind: 'plugin',
        configPath: plJsonPath
      });
    }
  }

  return { ok: true, workspace, rules, skills, agents, connectors };
}

export async function collectOverviewSnapshotAsync(payload = {}, opts = {}) {
  const skipGit = Boolean(opts.skipGit);
  let absDir = '';
  const rawDir = typeof payload?.dirPath === 'string' ? payload.dirPath.trim() : '';
  if (rawDir) {
    const resolved = resolveLocalProjectDir(rawDir);
    if (resolved) absDir = resolved;
  }
  const gitResolved = absDir && !skipGit ? await readOverviewGitStatusAsync(absDir) : null;
  return collectOverviewSnapshot(payload, Object.assign({}, opts, { gitResolved }));
}

function getSafePluginDocRoots(configDir = path.join(HOME, '.gemini', 'config')) {
  const pluginsRoot = path.join(configDir, 'plugins');
  const roots = [];
  let entries = [];
  try {
    entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const ent of entries) {
    if ((!ent.isDirectory() && !ent.isSymbolicLink()) || ent.name.startsWith('.')) continue;
    for (const sub of ['skills', 'rules', 'agents']) {
      roots.push(path.join(pluginsRoot, ent.name, sub));
    }
  }
  return roots;
}

export async function handleProjectRpcRequest(rawPayload, callerEntry = null) {
  let req;
  try {
    req = JSON.parse(String(rawPayload || '{}'));
  } catch {
    return null;
  }
  const reqId = req?.reqId;
  const action = req?.action;
  const payload = req?.payload || {};
  if (!reqId || !action) return null;

  try {
    if (action === 'saveUiPrefs') {
      const res = saveUiPrefs(payload);
      rebuildBundleIfNeeded();
      const nextHash = getBundleHash();
      if (callerEntry && callerEntry.hostConfirmed) {
        callerEntry.injectedBundleHash = nextHash;
        await callerEntry.updateNewDocScript().catch(() => {});
      }
      for (const [, other] of attachedTargets.entries()) {
        if (other !== callerEntry && other.hostConfirmed) {
          other.updateNewDocScript().catch(() => {});
          other.checkAndInject(true).catch(() => {});
        }
      }
      return { reqId, result: res };
    }
    if (action === 'getStudioPrefs') {
      return { reqId, result: { ok: true, prefs: loadStudioPrefs() } };
    }
    if (action === 'saveStudioPrefs') {
      const res = saveStudioPrefs(payload);
      rebuildBundleIfNeeded();
      const nextHash = getBundleHash();
      if (callerEntry && callerEntry.hostConfirmed) {
        callerEntry.injectedBundleHash = nextHash;
        await callerEntry.updateNewDocScript().catch(() => {});
      }
      for (const [, other] of attachedTargets.entries()) {
        if (other !== callerEntry && other.hostConfirmed) {
          other.updateNewDocScript().catch(() => {});
          other.checkAndInject(true).catch(() => {});
        }
      }
      return { reqId, result: res };
    }
    if (action === 'listContexts') {
      const paths = Array.isArray(payload.paths) ? payload.paths.slice(0, 80) : [];
      const projectIds = Array.isArray(payload.projectIds) ? payload.projectIds.slice(0, 120) : [];
      const contexts = {};
      for (const raw of paths) {
        const res = readProjectContext(raw);
        if (res.ok) contexts[raw] = res;
      }
      const projectMtimes = {};
      for (const rawId of projectIds) {
        const id = String(rawId || '').trim();
        if (!id || !/^[a-zA-Z0-9._-]+$/.test(id)) continue;
        const projFile = path.join(NATIVE_PROJECTS_DIR, `${id}.json`);
        if (!isPathInsideDir(NATIVE_PROJECTS_DIR, projFile)) continue;
        try {
          const st = fs.statSync(projFile, { throwIfNoEntry: false });
          if (st && st.isFile()) projectMtimes[id] = Math.floor(st.mtimeMs);
        } catch {}
      }
      return { reqId, result: { ok: true, contexts, projectMtimes } };
    }
    if (action === 'readContext') {
      return { reqId, result: readProjectContext(payload.dirPath) };
    }
    if (action === 'readProjectWorkspaceStatus') {
      const result = await readProjectWorkspaceStatusAsync(payload?.dirPath, { force: Boolean(payload?.force) });
      return { reqId, result };
    }
    if (action === 'readGitCommitDetail') {
      const result = await readGitCommitDetailAsync(payload?.dirPath, payload?.hash);
      return { reqId, result };
    }
    if (action === 'openExternalUrl') {
      return { reqId, result: openExternalUrl(payload?.url) };
    }
    if (action === 'saveContext') {
      return { reqId, result: saveProjectContext(payload) };
    }
    if (action === 'pickFiles') {
      const res = await pickLocalFilesNative();
      return { reqId, result: res };
    }
    if (action === 'pickFolder') {
      const res = await pickLocalFolderNative();
      return { reqId, result: res };
    }
    if (action === 'saveScheduledTask') {
      return { reqId, result: saveProjectScheduledTask(payload) };
    }
    if (action === 'deleteScheduledTask') {
      return { reqId, result: deleteProjectScheduledTask(payload) };
    }
    if (action === 'openSkillsDir') {
      fs.mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true });
      return { reqId, result: revealLocalPath(GLOBAL_SKILLS_DIR, { openFolderContents: true }) };
    }
    if (action === 'createLocalSkill') {
      return { reqId, result: createLocalSkill(payload) };
    }
    if (action === 'importLocalSkill') {
      const res = await importLocalSkillNative();
      return { reqId, result: res };
    }
    if (action === 'openAgentsDir') {
      fs.mkdirSync(GLOBAL_AGENTS_DIR, { recursive: true });
      return { reqId, result: revealLocalPath(GLOBAL_AGENTS_DIR, { openFolderContents: true }) };
    }
    if (action === 'createLocalAgent') {
      return { reqId, result: createLocalAgent(payload) };
    }
    if (action === 'importLocalAgent') {
      const res = await importLocalAgentNative();
      return { reqId, result: res };
    }
    if (action === 'getOverviewSnapshot') {
      const result = await collectOverviewSnapshotAsync(payload);
      return { reqId, result };
    }
    if (action === 'getUsageStats') {
      const { collectUsageStatsAsync } = await import('../../studio/daemon/usage-service.mjs');
      const result = await collectUsageStatsAsync(payload);
      return { reqId, result };
    }
    if (action === 'getSubagentMetrics') {
      const { collectSubagentMetrics } = await import('../../studio/daemon/subagent-metrics.mjs');
      const result = collectSubagentMetrics(payload);
      return { reqId, result };
    }
    if (action === 'getResumeState') {
      const { collectResumeState } = await import('../../studio/daemon/resume-detector.mjs');
      const result = collectResumeState(payload);
      return { reqId, result };
    }
    if (
      action === 'saveQuotaState' ||
      action === 'getOpusGateStatus' ||
      action === 'dismissOpusGateProposal' ||
      action === 'buildOpusHandoffBrief' ||
      action === 'syncOpusGatePlugin'
    ) {
      const { handleOpusGateRpc } = await import('../../studio/daemon/opus-gate-service.mjs');
      return { reqId, result: await handleOpusGateRpc(action, payload) };
    }
    if (action === 'revealFile') {
      const rawTarget = typeof payload?.targetPath === 'string' ? payload.targetPath.trim() : '';
      if (!rawTarget) return { reqId, result: { ok: false, error: 'missing_path' } };
      const absTarget = path.resolve(rawTarget);
      const explicitProj = resolveLocalProjectDir(payload?.dirPath);
      const globalAgentsMd = path.join(HOME, '.gemini', 'AGENTS.md');
      const builtinRootDir = path.join(HOME, '.gemini', 'antigravity', 'builtin');
      const allowedRoots = [
        ...(explicitProj ? [explicitProj] : []),
        ...getRegisteredProjectDirs(),
        GLOBAL_SKILLS_DIR,
        GLOBAL_AGENTS_DIR,
        builtinRootDir,
        ...getSafePluginDocRoots()
      ];
      const authorized =
        absTarget === globalAgentsMd ||
        allowedRoots.some((root) => absTarget === root || isPathInsideDir(root, absTarget));
      if (!authorized) {
        return { reqId, result: { ok: false, error: 'path_outside_project' } };
      }
      return { reqId, result: revealLocalPath(absTarget, { openFolderContents: Boolean(payload?.openFolder) }) };
    }
    return { reqId, result: { ok: false, error: `unknown_action:${action}` } };
  } catch (err) {
    return { reqId, result: { ok: false, error: String(err?.message || err) } };
  }
}
