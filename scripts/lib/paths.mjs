// paths.mjs — Centralized project-root resolution for the note-gen skill.
// Decouples scripts from their install location: the "reference root" is found
// from the user's current working directory (or an explicit override), NOT from
// this script's own directory. The skill lives at .agents/skills/note-gen/ but
// operates on <root>/reference_materials/ wherever the user actually is.
//
// Override precedence (highest first):
//   1. --root <dir> on the CLI  (the note-gen entry point sets NOTEGEN_ROOT)
//   2. NOTEGEN_ROOT env var
//   3. walk up from cwd until a directory containing reference_materials/ is found
//   4. cwd (last resort; commands will report "reference_materials/ not found")
//
// This module is read at import time, so the entry point MUST set NOTEGEN_ROOT
// before importing any lib module that imports this file.

import path from 'path';
import fs from 'fs';

/** Resolve the project root that contains reference_materials/. */
export function getRootDir() {
  if (process.env.NOTEGEN_ROOT) return process.env.NOTEGEN_ROOT;
  // Walk up from cwd to find a dir containing reference_materials/.
  let cur = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(cur, 'reference_materials'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

/** <root>/reference_materials — the literature library this skill curates. */
export function getRefsDir() {
  return path.join(getRootDir(), 'reference_materials');
}

/** True iff reference_materials/ exists. */
export function refsDirExists() {
  return fs.existsSync(getRefsDir());
}

// ─── Dual-root layout (in-repo metadata library / sync-drive PDF vault) ──────
// Since the vault split, the library is dual-rooted: notes/fulltext/index/
// citations live in the in-repo reference_materials/ (getRefsDir above, tracked
// by Git), while every *.pdf lives in a SAME-SHAPED category tree on the sync
// drive (heavy binaries never enter the repo). New PDFs are downloaded into the
// vault's per-zone 未归类/ landing dirs. The vault has NO default location —
// set the NOTEGEN_PDF_ROOT env var (or --pdf-root on the CLI) to activate it;
// when unset, every vault feature degrades gracefully to a clear warning.
const DEFAULT_PDF_REFS_DIR = '';

/** Sync-drive PDF vault root (same-shaped category tree as getRefsDir()). */
export function getPdfRefsDir() {
  return process.env.NOTEGEN_PDF_ROOT || DEFAULT_PDF_REFS_DIR;
}

/** True iff the sync-side PDF vault exists. */
export function pdfRefsDirExists() {
  return fs.existsSync(getPdfRefsDir());
}

/** Resolve a library-relative path (forward slashes) against the PDF vault. */
export function pdfRefAbs(rel) {
  return path.join(getPdfRefsDir(), ...String(rel).split('/'));
}

/** Convert an absolute path to one relative to the PDF vault, forward slashes. */
export function relToPdfRefs(absPath) {
  return path.relative(getPdfRefsDir(), absPath).split(path.sep).join('/');
}

// ─── Dual-zone layout (journal 期刊文献区 / longform 长篇文献区) ───────────
// The library is split into two self-contained zones, each with its own index,
// notes spec (文献笔记生成规范.md / 长篇文献笔记生成规范.md), and classification
// tree. A paper's zone is decided SOLELY by its
// directory path (never by content/line-count heuristics): dirRel starting with
// 期刊文献 → journal, 长篇文献 → long.
export const JOURNAL_ZONE = '期刊文献';
export const LONG_ZONE = '长篇文献';

/** Decide a paper's zone from its category path relative to reference_materials/. */
export function zoneOf(dirRel) {
  if (!dirRel) return 'journal';
  if (dirRel === JOURNAL_ZONE || dirRel.startsWith(JOURNAL_ZONE + '/')) return 'journal';
  if (dirRel === LONG_ZONE || dirRel.startsWith(LONG_ZONE + '/')) return 'long';
  return 'journal'; // top-level stragglers (mid-migration) default to journal
}

/** <refs>/期刊文献 — the journal literature zone. */
export function getJournalDir() { return path.join(getRefsDir(), JOURNAL_ZONE); }

/** <refs>/长篇文献 — the longform (books/theses) zone. */
export function getLongDir() { return path.join(getRefsDir(), LONG_ZONE); }

/** <journal>/_index.json — journal notes index (v2 schema, 期刊文献/文献笔记生成规范.md §6). */
export function getJournalIndexFile() { return path.join(getJournalDir(), '_index.json'); }

/** <longform>/_index.json — longform notes index (longform v1 schema, 长篇文献/长篇文献笔记生成规范.md §6). */
export function getLongIndexFile() { return path.join(getLongDir(), '_index.json'); }

/** Route to the correct index file by zone. */
export function getIndexFileForZone(zone) {
  return zone === 'long' ? getLongIndexFile() : getJournalIndexFile();
}

/** Back-compat alias for the journal index (legacy callers). Prefer getIndexFileForZone(zone). */
export function getIndexFile() {
  return getJournalIndexFile();
}

/** <refs>/_noteops — transient working dir holding classify.json (shared across zones); emptied by apply on success. */
export function getOpsDir() {
  return path.join(getRefsDir(), '_noteops');
}

/** <refs>/_noteops/classify.json — AI-written classification decisions. */
export function getClassifyFile() {
  return path.join(getOpsDir(), 'classify.json');
}

/** <refs>/引用信息 — citation-info dir (per-paper RIS, official RIS archive, reports, scripts). */
export function getCiteDir() {
  return path.join(getRefsDir(), '引用信息');
}

/** <refs>/引用信息/脚本/同步引用信息.py — one-shot citation sync (build + verify); needs Python 3.10+. */
export function getCiteSyncScript() {
  return path.join(getCiteDir(), '脚本', '同步引用信息.py');
}

/**
 * Should a directory/file name be skipped when scanning the library?
 * Skips: dot-prefixed (.), underscore-prefixed (_), and known non-literature
 * top-level files (文献分类决策树.md, 文献笔记生成规范.md, _index.json). Underscore-prefixed
 * top-level categories like _noteops/ are thus never treated as literature.
 */
const SKIP_FILES = new Set([
  '文献分类决策树.md', '_index.json',
  'NOTES_SPEC.md',                          // 旧规范名,保留兼容
  '文献笔记生成规范.md', '长篇文献笔记生成规范.md',  // 现行笔记规范(原 NOTES_SPEC.md 改名)
  'AGENTS.md', '引用信息',                    // 引用文件区/库级说明,不算文献
]);
export function isSkippedName(name) {
  if (!name) return true;
  if (name.startsWith('.') || name.startsWith('_')) return true;
  if (SKIP_FILES.has(name)) return true;
  return false;
}

/**
 * Convert an absolute path to one relative to reference_materials/, using
 * forward slashes (the index convention per 文献笔记生成规范.md §6).
 */
export function relToRefs(absPath) {
  return path.relative(getRefsDir(), absPath).split(path.sep).join('/');
}

export default {
  getRootDir,
  getRefsDir,
  refsDirExists,
  getPdfRefsDir,
  pdfRefsDirExists,
  pdfRefAbs,
  relToPdfRefs,
  JOURNAL_ZONE,
  LONG_ZONE,
  zoneOf,
  getJournalDir,
  getLongDir,
  getIndexFile,
  getJournalIndexFile,
  getLongIndexFile,
  getIndexFileForZone,
  getOpsDir,
  getClassifyFile,
  getCiteDir,
  getCiteSyncScript,
  isSkippedName,
  relToRefs,
};
