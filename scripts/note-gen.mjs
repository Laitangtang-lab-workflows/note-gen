#!/usr/bin/env node
// note-gen.mjs — CLI entry point for the note-gen skill.
// Curates reference_materials/: scaffolds notes skeletons (with best-effort
// metadata extraction), moves classified papers, and reconciles _index.json.
// The AI does the understanding (write notes content, classify, decide new
// categories); this script does the mechanics.
//
// Portable: resolves the reference root from cwd (or --root / NOTEGEN_ROOT),
// NOT from this script's own location — so the skill can live anywhere.
//
// Usage:
//   node note-gen.mjs <command> [options]
// Commands: status | scaffold | create-category | apply | reindex | validate | cite | help
// Options:  --root <dir> | --id <id> | --all | --dry-run | --verbose

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, rmdirSync, renameSync as fsRename, copyFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import {
  getRefsDir, refsDirExists, getIndexFile, getOpsDir, getClassifyFile,
  isSkippedName, relToRefs, getCiteSyncScript,
  zoneOf, getJournalIndexFile, getLongIndexFile, getIndexFileForZone,
  getPdfRefsDir, pdfRefsDirExists, pdfRefAbs, relToPdfRefs,
} from './lib/paths.mjs';
import { extractMetadata } from './lib/extract.mjs';

const SCRIPT_PATH = '.agents/skills/note-gen/scripts/note-gen.mjs';
const UNCLASSIFIED = '未归类';
const NEEDS_VERIFY = '# 待校验';  // marker AI removes after verifying
const OVERVIEW_MAX = 300;        // 长篇概览字数上限(含标点);validate 据此校验,与 长篇文献/长篇文献笔记生成规范.md 一致

// ─── CLI dispatcher ──────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  const rootArg = extractArg(args, '--root');
  if (rootArg) process.env.NOTEGEN_ROOT = rootArg;

  const pdfRootArg = extractArg(args, '--pdf-root');
  if (pdfRootArg) process.env.NOTEGEN_PDF_ROOT = pdfRootArg;

  const command = args[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  const verbose = args.includes('--verbose') || args.includes('-v');
  const dryRun = args.includes('--dry-run');
  const idArg = extractArg(args, '--id');
  const allFlag = args.includes('--all');

  // Commands that don't need the reference library to be fully set up can still
  // run; most hard-require reference_materials/.
  if (command === 'create-category') {
    const name = args.find(a => !a.startsWith('-') && a !== command);
    await cmdCreateCategory(name, dryRun, verbose);
    return;
  }

  switch (command) {
    case 'status':         await cmdStatus(verbose); break;
    case 'scaffold':       await cmdScaffold({ id: idArg, all: allFlag, dryRun, verbose }); break;
    case 'toc':            await cmdToc({ id: idArg, dryRun, verbose }); break;
    case 'apply':          await cmdApply(dryRun, verbose); break;
    case 'reindex':        await cmdReindex(dryRun, verbose); break;
    case 'validate':       await cmdValidate(verbose); break;
    case 'cite':           await cmdCite(); break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Available: status, scaffold, toc, create-category, apply, reindex, validate, cite, help');
      process.exit(1);
  }
}

// ─── arg parsing ─────────────────────────────────────────────────
function extractArg(args, ...flags) {
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i]) && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

// ─── library scan ────────────────────────────────────────────────
/**
 * Walk the in-repo reference_materials/ (metadata root) and collect every
 * "paper" (defined by a *.fulltext.md file), with its sibling .notes.md and
 * its vault-side *.pdf. Dual-root: notes/fulltext are found here; the PDF is
 * NOT in this tree — it is resolved by convention from the sync-drive vault
 * (getPdfRefsDir()) at the same category path. Stray .pdf files inside the
 * repo root are ignore here; `validate` flags them.
 * Skips dot/underscore-prefixed dirs and non-literature files.
 * @returns {Array<{id, dirRel, fulltext, notes, pdf}>}
 *   dirRel = category path relative to refs (e.g. "未归类", "材料挤出实验/DIW")
 *   fulltext/notes = {abs, rel} or null; pdf = {abs(vault), rel} or null
 */
function scanLibrary() {
  const refsDir = getRefsDir();
  const out = [];
  function walk(dir, relDir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const byId = new Map();
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (isSkippedName(e.name)) continue;
      let id = null, kind = null;
      if (e.name.endsWith('.fulltext.md')) { id = e.name.slice(0, -'.fulltext.md'.length); kind = 'fulltext'; }
      else if (e.name.endsWith('.notes.md')) { id = e.name.slice(0, -'.notes.md'.length); kind = 'notes'; }
      else continue; // PDFs live in the sync-drive vault, never in the repo tree
      if (!byId.has(id)) byId.set(id, { id, dirRel: relDir, zone: zoneOf(relDir), fulltext: null, notes: null, pdf: null });
      const abs = path.join(dir, e.name);
      byId.get(id)[kind] = { abs, rel: relToRefs(abs) };
    }
    for (const rec of byId.values()) {
      if (!rec.fulltext) continue;
      // resolve the sibling PDF from the vault by convention <dirRel>/<id>.pdf
      const pdfRel = rec.dirRel ? `${rec.dirRel}/${rec.id}.pdf` : `${rec.id}.pdf`;
      const pdfAbs = pdfRefAbs(pdfRel);
      if (existsSync(pdfAbs)) rec.pdf = { abs: pdfAbs, rel: pdfRel };
      out.push(rec);
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (isSkippedName(e.name)) continue;
      walk(path.join(dir, e.name), relDir ? `${relDir}/${e.name}` : e.name);
    }
  }
  walk(refsDir, '');
  return out;
}

// ─── frontmatter (mini-YAML) ─────────────────────────────────────
/** Extract the YAML frontmatter object, or null if absent. Best-effort. */
function parseFrontmatter(text) {
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?/);
  if (!m) return null;
  const out = {};
  let curKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const itemM = raw.match(/^\s+-\s+(.*)$/);
    if (itemM && curKey) {
      if (!Array.isArray(out[curKey])) out[curKey] = out[curKey] ? [out[curKey]] : [];
      out[curKey].push(stripValue(itemM[1]));
      continue;
    }
    const kvM = raw.match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/);
    if (kvM) {
      const k = kvM[1];
      const v = kvM[2];
      if (v.trim() === '') { curKey = k; out[k] = ''; }
      else if (v.trim().startsWith('[')) { out[k] = parseInlineArray(v); curKey = k; }
      else { out[k] = stripValue(v); curKey = k; }
    }
  }
  return out;
}

function stripTrailingComment(v) {
  v = v.trimEnd();
  if (v.startsWith('"') || v.startsWith("'")) {
    const end = v.indexOf(v[0], 1);
    if (end !== -1) return v.slice(0, end + 1);
  }
  const h = v.indexOf(' #');
  if (h !== -1) return v.slice(0, h).trimEnd();
  return v;
}

function stripValue(v) {
  v = stripTrailingComment(v).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseInlineArray(v) {
  const s = stripTrailingComment(v).trim();
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr.map(String);
  } catch { /* fall through */ }
  const inner = s.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map(p => stripValue(p.trim())).filter(x => x !== undefined && x !== '');
}

/** Is this notes file a scaffold skeleton not yet finished by the AI? */
function isDraftNotes(notesAbs) {
  try {
    const fm = parseFrontmatter(readFileSync(notesAbs, 'utf-8'));
    if (!fm) return false;
    return fm.draft === true || fm.draft === 'true';
  } catch { return false; }
}

/** Count remaining "# 待校验" markers in a notes file (0 when AI is done). */
function countVerifyMarkers(notesAbs) {
  try {
    const txt = readFileSync(notesAbs, 'utf-8');
    return (txt.match(/# 待校验/g) || []).length;
  } catch { return 0; }
}

/** Rewrite the source & category lines inside frontmatter (used after a move). */
function rewriteFrontmatterPaths(notesText, newCategory, newSource) {
  const m = notesText.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return notesText;
  let fm = m[1];
  fm = fm.replace(/^source:.*$/m, `source: ${newSource}`);
  fm = fm.replace(/^category:.*$/m, `category: ${newCategory}`);
  return notesText.slice(0, m.index) + '---\n' + fm + '\n---' + notesText.slice(m.index + m[0].length);
}

// ─── metadata extraction (best-effort, AI verifies) ──────────────
/**
 * Heuristically extract metadata from a fulltext.md header. Cross-publisher
 * formats vary; results are flagged "# 待校验" for AI to confirm.
 * @returns {title_en, authors[], affiliations[], doi, year, abstract_en}
 */
// ─── index helpers ───────────────────────────────────────────────
function loadIndex(zone = 'journal') {
  const f = getIndexFileForZone(zone);
  if (!existsSync(f)) {
    const base = { updated_at: today(), total: 0, has_notes_count: 0, entries: [] };
    if (zone === 'long') {
      return {
        '$schema': 'reference_materials longform index v1',
        spec: '长篇文献笔记生成规范.md',
        description: '长篇文献(书籍/学位论文)索引。Auto-initialized by note-gen skill.',
        ...base,
      };
    }
    return {
      '$schema': 'reference_materials notes index v2',
      spec: '文献笔记生成规范.md',
      description: 'Auto-initialized by note-gen skill.',
      ...base,
    };
  }
  try { return JSON.parse(readFileSync(f, 'utf-8')); }
  catch (e) { throw new Error(`${relToRefs(f)} 解析失败: ${e.message}`); }
}

function saveIndex(idx, zone = 'journal') {
  idx.updated_at = today();
  idx.total = idx.entries.length;
  idx.has_notes_count = idx.entries.filter(e => e.has_notes).length;
  writeFileSync(getIndexFileForZone(zone), JSON.stringify(idx, null, 2) + '\n', 'utf-8');
}

/** Max numeric ref in use + 1, formatted ref-0NN. */
function nextRef(entries) {
  let max = 0;
  for (const e of entries) {
    const m = /^ref-(\d+)$/.exec(e.ref || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `ref-${String(max + 1).padStart(3, '0')}`;
}

/** Max longform ref in use + 1, formatted long-0NN (independent numbering space). */
function nextLongRef(entries) {
  let max = 0;
  for (const e of entries) {
    const m = /^long-(\d+)$/.exec(e.ref || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `long-${String(max + 1).padStart(3, '0')}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ─── commands ────────────────────────────────────────────────────

async function cmdStatus(verbose) {
  ensureRefs();
  if (!pdfRefsDirExists()) {
    console.log(`⚠ 同步盘 PDF 库未配置或不可达: ${getPdfRefsDir() || "(未设置 --pdf-root / NOTEGEN_PDF_ROOT)"}\n  (用 --pdf-root <目录> 或 NOTEGEN_PDF_ROOT 指定;PDF 相关检测将失真)\n`);
  }
  const papers = scanLibrary();
  const jIdx = loadIndex('journal');
  const lIdx = loadIndex('long');
  const classifyExists = existsSync(getClassifyFile());

  // 长篇区 PDF-only(有 PDF 无 fulltext)检测 — PDF 库在同步盘侧
  const allPdfs = [];
  function walkPdfs(dir, relDir) {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (isSkippedName(e.name)) continue;
      if (e.isFile() && e.name.endsWith('.pdf')) {
        if (zoneOf(relDir) === 'long') allPdfs.push({ id: e.name.slice(0, -'.pdf'.length), dirRel: relDir });
      } else if (e.isDirectory()) {
        walkPdfs(path.join(dir, e.name), relDir ? `${relDir}/${e.name}` : e.name);
      }
    }
  }
  walkPdfs(getPdfRefsDir(), '');
  const paperIds = new Set(papers.map(p => p.id));
  const longPdfOnly = allPdfs.filter(p => !paperIds.has(p.id));

  const reportZone = (label, zp, idx) => {
    console.log(`══ ${label}(scan ${zp.length} 篇,索引 ${(idx.entries || []).length} 条)`);
    const noNotes = zp.filter(p => !p.notes);
    const drafts = zp.filter(p => p.notes && isDraftNotes(p.notes.abs));
    const readyToClassify = zp.filter(p => p.dirRel.endsWith('/' + UNCLASSIFIED) && p.notes && !isDraftNotes(p.notes.abs));
    const pendingVerify = zp.filter(p => p.notes && countVerifyMarkers(p.notes.abs) > 0);
    const idsOnDisk = new Set(zp.map(p => p.id));
    const idxIds = new Set((idx.entries || []).map(e => e.id));
    const orphanIndex = (idx.entries || []).filter(e => !idsOnDisk.has(e.id));
    const unindexed = zp.filter(p => !idxIds.has(p.id));

    console.log('  待 scaffold(有 fulltext 无 notes)');
    if (noNotes.length === 0) console.log('    (无)');
    else for (const p of noNotes) console.log(`    [${p.dirRel}] ${p.id}`);
    console.log('  待 AI 完成(draft:true)');
    if (drafts.length === 0) console.log('    (无)');
    else for (const p of drafts) console.log(`    [${p.dirRel}] ${p.id}`);
    console.log('  待 AI 校验(残留 "# 待校验")');
    if (pendingVerify.length === 0) console.log('    (无)');
    else for (const p of pendingVerify) console.log(`    [${p.dirRel}] ${p.id} (${countVerifyMarkers(p.notes.abs)} 处)`);
    console.log('  待分类(未归类里已完成的 notes)');
    if (readyToClassify.length === 0) console.log('    (无)');
    else for (const p of readyToClassify) console.log(`    ${p.id}`);
    console.log(`  索引↔FS: 未入索引 ${unindexed.length}${unindexed.length ? ' — ' + unindexed.map(p => p.id).join(', ') : ''}; 孤儿 ${orphanIndex.length}${orphanIndex.length ? ' — ' + orphanIndex.map(e => e.id).join(', ') : ''}`);
  };

  reportZone('期刊文献区', papers.filter(p => p.zone === 'journal'), jIdx);
  console.log('');
  reportZone('长篇文献区', papers.filter(p => p.zone === 'long'), lIdx);
  if (longPdfOnly.length) {
    console.log('  ⚠ 长篇区有 PDF 无 fulltext(待 pdf_to_markdown):');
    for (const p of longPdfOnly) console.log(`    [${p.dirRel}] ${p.id}`);
  }
  console.log(`\n分类决策文件: ${classifyExists ? '已写 ' + relToRefs(getClassifyFile()) : '未写(需 AI 生成 → apply)'}`);
}

async function cmdScaffold({ id, all, dryRun, verbose }) {
  ensureRefs();
  const papers = scanLibrary();
  let targets;
  if (id) {
    const p = papers.find(x => x.id === id);
    if (!p) { console.error(`未找到 id=${id} 的 fulltext。`); process.exit(1); }
    targets = [p];
  } else {
    // default & --all: unclassified fulltexts missing notes (both zones:
    // 期刊文献/未归类 and 长篇文献/未归类)
    targets = papers.filter(p => (p.dirRel === UNCLASSIFIED || p.dirRel.endsWith('/' + UNCLASSIFIED)) && !p.notes);
  }
  if (targets.length === 0) {
    console.log('无需 scaffold(未归类里没有"缺 notes 的 fulltext")。');
    return;
  }
  // ref 分配按 zone 用各自索引(journal: ref-NNN, long: long-NNN)
  const jIdx = loadIndex('journal');
  const lIdx = loadIndex('long');
  const jUsed = new Set((jIdx.entries || []).map(e => e.ref));
  const lUsed = new Set((lIdx.entries || []).map(e => e.ref));
  const jRefById = new Map((jIdx.entries || []).map(e => [e.id, e.ref]));
  const lRefById = new Map((lIdx.entries || []).map(e => [e.id, e.ref]));
  let jNext = nextRef(jIdx.entries || []);
  let lNext = nextLongRef(lIdx.entries || []);
  const allocRef = (zone) => {
    if (zone === 'long') {
      let r = lNext;
      while (lUsed.has(r)) { r = `long-${String(Number(r.slice(5)) + 1).padStart(3, '0')}`; }
      lUsed.add(r); lNext = `long-${String(Number(r.slice(5)) + 1).padStart(3, '0')}`;
      return r;
    }
    let r = jNext;
    while (jUsed.has(r)) { r = `ref-${String(Number(r.slice(4)) + 1).padStart(3, '0')}`; }
    jUsed.add(r); jNext = `ref-${String(Number(r.slice(4)) + 1).padStart(3, '0')}`;
    return r;
  };

  let created = 0, skipped = 0;
  for (const p of targets) {
    const outAbs = path.join(getRefsDir(), p.dirRel, `${p.id}.notes.md`);
    if (existsSync(outAbs)) { console.log(`跳过(已有 notes): ${p.id}`); skipped++; continue; }
    let text;
    try { text = readFileSync(p.fulltext.abs, 'utf-8'); }
    catch (e) { console.error(`读取 fulltext 失败 ${p.id}: ${e.message}`); continue; }
    let meta;
    try { meta = extractMetadata(text); }
    catch (e) { meta = { title_en: '', authors: [], affiliations: [], doi: '', year: '', abstract_en: '' }; }
    // 复用索引里已有的 ref(若文献已入索引),否则 max+1 —— 避免 reindex 后再 scaffold 时 ref 漂移
    const ref = (p.zone === 'long' ? lRefById : jRefById).get(p.id) || allocRef(p.zone);

    let note;
    if (p.zone === 'long') {
      meta.isbn = extractIsbn(text);
      const toc = extractToc(text);
      note = renderLongScaffold({ id: p.id, ref, dirRel: p.dirRel, meta, toc });
    } else {
      note = renderScaffold({ id: p.id, ref, dirRel: p.dirRel, meta });
    }
    if (dryRun) {
      console.log(`[dry-run] 将生成 ${relToRefs(outAbs)} (${p.zone}, ref=${ref}, title="${(meta.title_en || '').slice(0, 40)}...")`);
    } else {
      writeFileSync(outAbs, note, 'utf-8');
      console.log(`生成 ${relToRefs(outAbs)} (${p.zone}, ref=${ref})`);
    }
    created++;
  }
  console.log(`scaffold 完成: 生成 ${created}、跳过 ${skipped}${dryRun ? '(dry-run,未写盘)' : ''}。`);
}

function renderScaffold({ id, ref, dirRel, meta }) {
  const y = (s) => String(s ?? '');
  const yamlArr = (arr) => arr && arr.length ? JSON.stringify(arr) : '[]';
  const titleEn = y(meta.title_en);
  const source = `${dirRel}/${id}.fulltext.md`;
  return `---
id: ${id}
ref: ${ref}
source: ${source}
title_en: ${titleEn ? `"${titleEn.replace(/"/g, '\\"')}"` : '""'}
title_zh: ""
authors: ${yamlArr(meta.authors)}  ${NEEDS_VERIFY}
affiliations: ${yamlArr(meta.affiliations)}  ${NEEDS_VERIFY}
year: ${meta.year === '' || meta.year == null ? '""' : y(meta.year)}  ${NEEDS_VERIFY}
venue: ""
doi: ${meta.doi ? `"${meta.doi}"` : '""'}  ${meta.doi ? NEEDS_VERIFY : ''}
category: ${dirRel}
keywords: []
topics: []
tags: []
takeaway: ""
draft: true
generated: ${today()}
spec: 文献笔记生成规范.md
---

# 一、文献标题

**英标题**: ${titleEn || '(待 AI 核对)'}
**中标题**:

# 二、主要作者及机构

**全部作者**: ${meta.authors && meta.authors.length ? meta.authors.join(', ') + '  ' + NEEDS_VERIFY : '(待 AI 从 fulltext 抽取)'}
**通讯作者**:
**所属机构**: ${meta.affiliations && meta.affiliations.length ? '\\n' + meta.affiliations.map(a => '- ' + a).join('\\n') + '  ' + NEEDS_VERIFY : '(待 AI 从 fulltext 抽取)'}

# 三、摘要完整中文翻译

<!-- 英文摘要原文(脚本抽取,供翻译参考;AI 在本注释下方写完整中文翻译,完成后可删除本注释):
${meta.abstract_en || '(未抽到英文摘要 — 请 AI 阅读 fulltext 自行翻译)'}
-->

# 四、文章各部分内容概括


# 五、文章强调的重要结论


# 六、AI 发现的有趣之处

`;
}

// ─── TOC extraction (longform fulltext, OCR-tolerant) ─────────────
/**
 * Extract chapter/section headings + 1-indexed line numbers from a longform
 * fulltext.md (OCR product). Outputs ALL candidates incl. duplicates (the
 * front-matter Contents table repeats Part headings; AI disambiguates by line
 * number). Does NOT decide content start — transparent output, AI cleans up.
 *
 * Verified heading formats (Moukalled FVM book, grep-confirmed all 20 chapters):
 *   # Part I Foundation
 *   # <span id="page-X-X"></span>Chapter N Title          (plain)
 *   # <span id="page-X-X"></span>**Chapter N Title**       (bold — Ch 5/9/10/12/16)
 *   # Chapter N Title                                       (fallback, no span)
 *   # N.M / # N.M.K  sections
 * @returns {{level:number, title:string, lineNo:number, titleMissing?:boolean}[]}
 */
function extractToc(fulltextContent) {
  const lines = fulltextContent.split(/\r?\n/);
  const out = [];
  const cleanTitle = (s) => (s || '').replace(/^\**/, '').replace(/\**$/, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    // Part
    const partM = line.match(/^#\s+(Part\s+[IVXLCDM]+)\b(.*)$/i);
    if (partM) {
      const rest = cleanTitle(partM[2]);
      out.push({ level: 0, title: `**${partM[1]}${rest ? ' ' + rest : ''}**`, lineNo });
      continue;
    }
    // Chapter (3 formats: span+plain, span+bold, bare)
    const chapM = line.match(/^#\s+(?:<span id="[^"]*"><\/span>)?\**\s*Chapter\s+(\d+)\b(.*)$/i);
    if (chapM) {
      const num = chapM[1];
      const rest = cleanTitle(chapM[2]);
      out.push({ level: 1, title: rest ? `Chapter ${num} ${rest}` : `Chapter ${num} (标题缺失)`, lineNo, titleMissing: !rest });
      continue;
    }
    // Section N.M[.K]
    const secM = line.match(/^#\s+(\d+\.\d+(?:\.\d+)?)\b(.*)$/);
    if (secM) {
      const num = secM[1];
      const rest = cleanTitle(secM[2]);
      const depth = (num.match(/\./g) || []).length + 1; // 1.x -> 2, 1.x.y -> 3
      out.push({ level: depth, title: rest ? `${num} ${rest}` : `${num}`, lineNo });
      continue;
    }
  }
  return out;
}

/** Detect chapter-number gaps (OCR漏识别) from extracted toc; returns [{num, lo, hi}]. */
function detectChapterGaps(toc) {
  const chapEntries = toc
    .filter(e => /Chapter\s+(\d+)/i.test(e.title || ''))
    .map(e => ({ num: Number(/Chapter\s+(\d+)/i.exec(e.title)[1]), lineNo: e.lineNo }))
    .sort((a, b) => a.num - b.num);
  if (chapEntries.length === 0) return [];
  const max = chapEntries[chapEntries.length - 1].num;
  const present = new Set(chapEntries.map(c => c.num));
  const gaps = [];
  for (let n = 1; n <= max; n++) {
    if (!present.has(n)) {
      const lo = chapEntries.filter(c => c.num < n).pop();
      const hi = chapEntries.find(c => c.num > n);
      gaps.push({ num: n, lo: lo ? lo.lineNo : null, hi: hi ? hi.lineNo : null });
    }
  }
  return gaps;
}

/** Render toc entries + gap warnings into toc.raw markdown (small file for AI to read). */
function renderTocRaw(id, toc) {
  const gaps = detectChapterGaps(toc);
  const lines = [];
  lines.push(`# toc.raw — ${id} (脚本抽取,待 AI 清洗整理)`);
  lines.push(`# 共 ${toc.length} 条候选标题。正文起点建议: 行号最大的重复 Part / 第一个 Chapter。`);
  lines.push(`# 前置 Contents 表会重复 Part/Chapter(行号小),正文为行号大者;AI 据行号区分、去重。`);
  lines.push('');
  for (const e of toc) {
    const flag = e.titleMissing ? '   ⚠ 标题缺失(OCR),请据 Preface 综述补' : '';
    lines.push(`[L${e.lineNo}] ${e.title}${flag}`);
  }
  if (gaps.length) {
    lines.push('');
    lines.push('## 章号断层(疑似 OCR 漏识别,请 AI 据区间精读补)');
    for (const g of gaps) {
      lines.push(`- ⚠ Chapter ${g.num} 缺失(区间 L${g.lo ?? '?'}–L${g.hi ?? '?'})`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Pure toc entries (no meta-comments) for embedding in notes.md 目录 section. */
function renderTocEntries(toc) {
  if (!toc || !toc.length) return '';
  return toc.map(e => {
    const flag = e.titleMissing ? '   ⚠ 标题缺失(OCR)' : '';
    return `[L${e.lineNo}] ${e.title}${flag}`;
  }).join('\n');
}

/** Best-effort ISBN from fulltext header (print or ebook). AI verifies. */
function extractIsbn(text) {
  const head = text.slice(0, 6000);
  const m = head.match(/ISBN[^0-9X]{0,12}(97[89][-\s]?[0-9]{1,5}[-\s]?[0-9]{1,7}[-\s]?[0-9]{1,7}[-\s]?[0-9X])/i);
  return m ? m[1].replace(/[-\s]/g, '') : '';
}

// ─── longform scaffold template (概览 + 目录, vs journal 六部分) ────
function renderLongScaffold({ id, ref, dirRel, meta, toc }) {
  const y = (s) => String(s ?? '');
  const yamlArr = (arr) => arr && arr.length ? JSON.stringify(arr) : '[]';
  const titleEn = y(meta.title_en);
  const source = `${dirRel}/${id}.fulltext.md`;
  return `---
id: ${id}
ref: ${ref}
source: ${source}
type: book  ${NEEDS_VERIFY}            # book | thesis | report | proceedings
title_en: ${titleEn ? `"${titleEn.replace(/"/g, '\\"')}"` : '""'}  ${NEEDS_VERIFY}
title_zh: ""
authors: ${yamlArr(meta.authors)}  ${NEEDS_VERIFY}
year: ${meta.year === '' || meta.year == null ? '""' : y(meta.year)}  ${NEEDS_VERIFY}
publisher: ""  ${NEEDS_VERIFY}
isbn: ${meta.isbn ? `"${meta.isbn}"` : '""'}  ${meta.isbn ? NEEDS_VERIFY : ''}
degree: ""                           # 论文: PhD/Master; 书留空
institution: ""                      # 论文: 学位授予单位; 书留空
series: ""
doi: ${meta.doi ? `"${meta.doi}"` : '""'}
category: ${dirRel}
overview: ""                         # ≤${OVERVIEW_MAX}字概览,AI 填
keywords: []
topics: []
tags: []
draft: true
generated: ${today()}
spec: 长篇文献笔记生成规范.md
---

# 文献概览

<!-- ≤${OVERVIEW_MAX}字中文概览。依据: 下方目录(toc.raw)+ Preface/引言片段(用行号 Read offset=.. limit=.. 精读,勿通读全文)。写: 讲什么、方法主线、对 DIW 挤出仿真/挤出胀大/沉积形貌研究的用处。写完删本注释。 -->


# 目录

<!-- 双锚点(标题+L行号)。脚本已从 fulltext 抽取原始目录;AI 清洗: 剥 OCR 残留、去前置区重复、补缺失标题(标[AI补])、关键章可补中文主题。行号必须来自此处,不得自造。查阅用 Read offset=行号。 -->

${toc && toc.length ? renderTocEntries(toc) : `(脚本未抽到目录 — 请跑: node .agents/skills/note-gen/scripts/note-gen.mjs toc --id ${id})`}
`;
}

// ─── toc command (longform TOC extraction) ────────────────────────
async function cmdToc({ id, dryRun, verbose }) {
  ensureRefs();
  const papers = scanLibrary();
  let targets;
  if (id) {
    const p = papers.find(x => x.id === id);
    if (!p) { console.error(`未找到 id=${id} 的 fulltext。`); process.exit(1); }
    targets = [p];
  } else {
    // default: longform-zone fulltexts (any dir)
    targets = papers.filter(p => p.zone === 'long');
  }
  if (targets.length === 0) {
    console.log('无长篇 fulltext 可提取目录(长篇区无 fulltext,或用 --id 指定)。');
    return;
  }
  let made = 0;
  for (const p of targets) {
    if (!p.fulltext) { console.log(`跳过 ${p.id}: 无 fulltext(仅 PDF?待 pdf_to_markdown)`); continue; }
    const text = readFileSync(p.fulltext.abs, 'utf-8');
    const toc = extractToc(text);
    const raw = renderTocRaw(p.id, toc);
    const outAbs = path.join(getOpsDir(), `${p.id}.toc.raw.md`);
    const gaps = detectChapterGaps(toc);
    if (dryRun) {
      console.log(`[dry-run] 将写 ${relToRefs(outAbs)} (${toc.length} 条标题, ${gaps.length} 处断层)`);
    } else {
      mkdirSync(getOpsDir(), { recursive: true });
      writeFileSync(outAbs, raw, 'utf-8');
      console.log(`TOC 提取 → ${relToRefs(outAbs)} (${toc.length} 条标题, ${gaps.length} 处断层)`);
    }
    if (verbose) console.log(raw);
    made++;
  }
  console.log(`toc 完成: ${made} 篇${dryRun ? '(dry-run,未写盘)' : ''}。`);
}

async function cmdCreateCategory(name, dryRun, verbose) {
  ensureRefs();
  if (!name) { console.error('用法: note-gen create-category <类目路径> [--dry-run]\n例如: note-gen create-category 光固化综述'); process.exit(1); }
  const refsDir = getRefsDir();
  const target = path.join(refsDir, ...name.split('/'));
  const rel = name.split('/').join('/');
  if (existsSync(target)) { console.log(`类目已存在: ${rel}`); return; }
  if (dryRun) {
    console.log(`[dry-run] 将创建目录 reference_materials/${rel}/(仓内元数据库 + 同步盘 PDF 库)`);
    return;
  }
  mkdirSync(target, { recursive: true });
  console.log(`已创建类目: reference_materials/${rel}/`);
  // dual-root: mirror the category in the sync-drive PDF vault
  if (pdfRefsDirExists()) {
    const pdfTarget = path.join(getPdfRefsDir(), ...name.split('/'));
    mkdirSync(pdfTarget, { recursive: true });
    console.log(`已同步创建 PDF 库类目: ${relToPdfRefs(pdfTarget)}/`);
  } else {
    console.log(`⚠ PDF 库不可达(${getPdfRefsDir()});未同步创建 PDF 侧类目。`);
  }
  console.log(`提示: 请同步在 reference_materials/文献分类决策树.md 决策树与"现有分类"表登记此新类目。`);
}

async function cmdApply(dryRun, verbose) {
  ensureRefs();
  const cf = getClassifyFile();
  if (!existsSync(cf)) {
    console.log('无分类决策(reference_materials/_noteops/classify.json 不存在)。');
    console.log('请先由 AI 写入 classify.json:{ "decisions": { "<id>": { "target": "<类目>", "rationale": "..." } } }');
    return;
  }
  let decisions;
  try { decisions = JSON.parse(readFileSync(cf, 'utf-8')).decisions || {}; }
  catch (e) { console.error(`classify.json 解析失败: ${e.message}`); process.exit(1); }

  const papers = scanLibrary();
  const byId = new Map(papers.map(p => [p.id, p]));
  const refsDir = getRefsDir();
  let moved = 0, skipped = 0;
  const movedList = [];
  const skippedList = [];
  for (const [id, dec] of Object.entries(decisions)) {
    const target = dec.target || dec;
    const p = byId.get(id);
    if (!p) { console.log(`跳过 ${id}: 未找到文件`); skippedList.push(id); skipped++; continue; }
    const targetDir = path.join(refsDir, ...String(target).split('/'));
    if (!existsSync(targetDir)) {
      console.log(`跳过 ${id}: 目标类目不存在 "${target}"(先 note-gen create-category ${target})`);
      skippedList.push(id); skipped++; continue;
    }
    if (zoneOf(String(target)) !== p.zone) {
      console.log(`跳过 ${id}: 跨区移动禁止(原 ${p.zone} → 目标 ${zoneOf(String(target))});检查 classify.json 的 target 前缀`);
      skippedList.push(id); skipped++; continue;
    }
    const newSource = `${target}/${id}.fulltext.md`;
    for (const kind of ['fulltext', 'notes', 'pdf']) {
      const f = p[kind];
      if (!f) continue;
      // dual-root: md files stay in the repo tree; the PDF moves inside the
      // sync-drive vault at the same category path (dir auto-created)
      let dest, srcLabel, destLabel;
      if (kind === 'pdf') {
        const pdfTargetDir = path.join(getPdfRefsDir(), ...String(target).split('/'));
        if (!existsSync(pdfTargetDir)) {
          if (dryRun) console.log(`[dry-run] mkdir(PDF库) ${target}`);
          else mkdirSync(pdfTargetDir, { recursive: true });
        }
        dest = path.join(pdfTargetDir, path.basename(f.abs));
        srcLabel = relToPdfRefs(f.abs); destLabel = relToPdfRefs(dest);
      } else {
        dest = path.join(targetDir, path.basename(f.abs));
        srcLabel = relToRefs(f.abs); destLabel = relToRefs(dest);
      }
      if (f.abs === dest) continue;
      if (dryRun) { console.log(`[dry-run] mv ${srcLabel} → ${destLabel}`); continue; }
      moveFileSafe(f.abs, dest);
    }
    // rewrite notes frontmatter paths (source/category) after the move
    const movedNotes = p.notes ? path.join(targetDir, `${id}.notes.md`) : null;
    if (movedNotes && existsSync(movedNotes) && !dryRun) {
      const txt = readFileSync(movedNotes, 'utf-8');
      writeFileSync(movedNotes, rewriteFrontmatterPaths(txt, String(target), newSource), 'utf-8');
    }
    console.log(`${dryRun ? '[dry-run] ' : ''}移动 ${id} → ${target}${p.notes ? '  (并更新 notes source/category)' : ''}`);
    movedList.push(id);
    moved++;
  }
  // 已应用的决策不再归档留存(不留 .done 文件):
  //   全部应用(skipped=0)→删除 classify.json(并清空 _noteops 目录);
  //   有跳过→改写 classify.json 仅保留未应用决策,方便修正 target 后重跑。
  if (!dryRun && moved > 0) {
    if (skipped === 0) {
      unlinkSync(cf);
      try { if (existsSync(getOpsDir()) && readdirSync(getOpsDir()).length === 0) rmdirSync(getOpsDir()); } catch (_) {}
      console.log('classify.json 已删除(全部决策已应用)。');
    } else {
      const remaining = {};
      for (const id of skippedList) remaining[id] = decisions[id];
      writeFileSync(cf, JSON.stringify({ decisions: remaining }, null, 2) + '\n', 'utf-8');
      console.log(`classify.json 已更新:仅保留 ${skipped} 条未应用决策(修正 target 后重跑 apply)。`);
    }
  }
  console.log(`apply 完成: 移动 ${moved}、跳过 ${skipped}${dryRun ? '(dry-run,未执行)' : ''}。`);
}

/** Move a file, tolerating cross-device moves (rename fails with EXDEV there). */
function moveFileSafe(src, dest) {
  try { renameSync(src, dest); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyFileSync(src, dest);
    unlinkSync(src);
  }
}

/** Reindex one zone's index against the file-system truth. Returns {idx, added, updated, notesSynced, orphans}. */
function reindexZone(zone, papers, dryRun) {
  const idx = loadIndex(zone);
  idx.entries = idx.entries || [];
  const byId = new Map(idx.entries.map(e => [e.id, e]));
  const usedRefs = new Set(idx.entries.map(e => e.ref).filter(Boolean));
  const prefix = zone === 'long' ? 'long' : 'ref';
  let counter = (() => { let m = 0; const re = new RegExp('^' + prefix + '-(\\d+)$'); for (const r of usedRefs) { const x = re.exec(r); if (x) m = Math.max(m, +x[1]); } return m; })();
  const allocRef = () => {
    counter++;
    let r = `${prefix}-${String(counter).padStart(3, '0')}`;
    while (usedRefs.has(r)) { counter++; r = `${prefix}-${String(counter).padStart(3, '0')}`; }
    usedRefs.add(r); return r;
  };

  // frontmatter 回填字段集(按 zone: journal vs longform schema)
  const journalFields = [['title_en','title_en'],['title_zh','title_zh'],['authors','authors'],['affiliations','affiliations'],['year','year'],['venue','venue'],['doi','doi'],['keywords','keywords'],['topics','topics'],['tags','tags'],['takeaway','takeaway']];
  const longFields = [['title_en','title_en'],['title_zh','title_zh'],['authors','authors'],['year','year'],['type','type'],['publisher','publisher'],['isbn','isbn'],['degree','degree'],['institution','institution'],['series','series'],['doi','doi'],['overview','overview'],['keywords','keywords'],['topics','topics'],['tags','tags']];
  const fields = zone === 'long' ? longFields : journalFields;

  let added = 0, updated = 0;
  for (const p of papers) {
    const existing = byId.get(p.id);
    let fm = null;
    if (p.notes) { try { fm = parseFrontmatter(readFileSync(p.notes.abs, 'utf-8')); } catch {} }
    const draft = p.notes ? isDraftNotes(p.notes.abs) : false;
    const hasNotes = !!p.notes && !draft;
    const fv = (k) => (fm && fm[k] !== undefined && fm[k] !== '' && !(Array.isArray(fm[k]) && fm[k].length === 0)) ? fm[k] : undefined;

    if (existing) {
      const before = JSON.stringify(existing);
      existing.category = p.dirRel;
      existing.pdf = p.pdf ? p.pdf.rel : (existing.pdf || '');
      existing.fulltext = p.fulltext.rel;
      existing.notes = p.notes ? p.notes.rel : '';
      existing.has_fulltext = true;
      existing.has_notes = hasNotes;
      if (zone === 'long') existing.draft = draft;
      for (const [k, ik] of fields) {
        const v = fv(k); if (v !== undefined) existing[ik] = v;
      }
      existing.processed_date = existing.processed_date || (hasNotes ? today() : '');
      existing.reindexed_at = today();
      if (JSON.stringify(existing) !== before) updated++;
    } else {
      const entry = zone === 'long' ? {
        id: p.id, ref: allocRef(),
        type: fv('type') || '', title_zh: fv('title_zh') || '', title_en: fv('title_en') || '',
        authors: fv('authors') || [], year: fv('year') || null,
        publisher: fv('publisher') || '', isbn: fv('isbn') || '',
        degree: fv('degree') || '', institution: fv('institution') || '', series: fv('series') || '',
        doi: fv('doi') || '', category: p.dirRel,
        pdf: p.pdf ? p.pdf.rel : '', fulltext: p.fulltext.rel, notes: p.notes ? p.notes.rel : '',
        overview: fv('overview') || '', keywords: fv('keywords') || [], topics: fv('topics') || [], tags: fv('tags') || [],
        has_fulltext: true, has_notes: hasNotes, draft,
        processed_date: hasNotes ? today() : '', reindexed_at: today(),
      } : {
        id: p.id, ref: allocRef(),
        title_zh: fv('title_zh') || '', title_en: fv('title_en') || '',
        authors: fv('authors') || [], affiliations: fv('affiliations') || [],
        year: fv('year') || null, venue: fv('venue') || '', doi: fv('doi') || '',
        category: p.dirRel,
        pdf: p.pdf ? p.pdf.rel : '', fulltext: p.fulltext.rel, notes: p.notes ? p.notes.rel : '',
        keywords: fv('keywords') || [], topics: fv('topics') || [], takeaway: fv('takeaway') || '', tags: fv('tags') || [],
        has_fulltext: true, has_notes: hasNotes, quality: null,
        processed_date: hasNotes ? today() : '', reindexed_at: today(),
      };
      idx.entries.push(entry);
      byId.set(p.id, entry);
      added++;
    }
  }
  // sync stale notes frontmatter source/category to actual location (apply already
  // does this on move; this catches notes moved by other means). Rewrites only source & category.
  let notesSynced = 0;
  for (const p of papers) {
    if (!p.notes) continue;
    const expSource = `${p.dirRel}/${p.id}.fulltext.md`;
    let fm;
    try { fm = parseFrontmatter(readFileSync(p.notes.abs, 'utf-8')); } catch { continue; }
    if (!fm) continue;
    const sourceWrong = fm.source && fm.source !== expSource;
    const catWrong = fm.category && fm.category !== p.dirRel;
    if (!sourceWrong && !catWrong) continue;
    notesSynced++;
    if (!dryRun) {
      const txt = readFileSync(p.notes.abs, 'utf-8');
      writeFileSync(p.notes.abs, rewriteFrontmatterPaths(txt, p.dirRel, expSource), 'utf-8');
    }
  }

  const onDisk = new Set(papers.map(p => p.id));
  const orphans = idx.entries.filter(e => !onDisk.has(e.id));
  return { idx, added, updated, notesSynced, orphans };
}

async function cmdReindex(dryRun, verbose) {
  ensureRefs();
  const papers = scanLibrary();
  const jPapers = papers.filter(p => p.zone === 'journal');
  const lPapers = papers.filter(p => p.zone === 'long');

  const j = reindexZone('journal', jPapers, dryRun);
  const l = reindexZone('long', lPapers, dryRun);

  if (dryRun) {
    console.log(`[dry-run] 期刊区: 新增 ${j.added}、更新 ${j.updated}、同步 notes ${j.notesSynced}、孤儿 ${j.orphans.length}; 长篇区: 新增 ${l.added}、更新 ${l.updated}、同步 notes ${l.notesSynced}、孤儿 ${l.orphans.length}。`);
    return;
  }
  saveIndex(j.idx, 'journal');
  saveIndex(l.idx, 'long');
  console.log('reindex 完成:');
  console.log(`  期刊区: 新增 ${j.added}、更新 ${j.updated}、同步 notes 路径 ${j.notesSynced}。total=${j.idx.total}, has_notes=${j.idx.has_notes_count}。`);
  console.log(`  长篇区: 新增 ${l.added}、更新 ${l.updated}、同步 notes 路径 ${l.notesSynced}。total=${l.idx.total}, has_notes=${l.idx.has_notes_count}。`);
  for (const [label, res] of [['期刊区', j], ['长篇区', l]]) {
    if (res.orphans.length) {
      console.log(`  ⚠ ${label}索引孤儿 ${res.orphans.length} 条(文件已删/移走但索引未清,保留未删):`);
      for (const o of res.orphans) console.log(`    ${o.ref} ${o.id} (${o.category})`);
    }
  }
}

// ─── cite: 引用文件同步(生成每篇 .ris + 与官方引用文件对照验证) ────
// 薄封装:机械实现沉淀在 引用信息/脚本/ 的 Python 工具链(带 Crossref 缓存,增量),
// 本命令只负责定位并调用,使 /note-gen 全流程(含引用)可由 skill 一键驱动。
async function cmdCite() {
  ensureRefs();
  const script = getCiteSyncScript();
  if (!existsSync(script)) {
    console.error(`未找到引用同步脚本: ${relToRefs(script)}(引用信息/ 目录不完整)`);
    process.exit(1);
  }
  console.log(`运行引用同步: python -X utf8 "${relToRefs(script)}"`);
  const r = spawnSync('python', ['-X', 'utf8', script], { stdio: 'inherit' });
  if (r.error) {
    console.error(r.error.code === 'ENOENT'
      ? '未找到 python:引用同步需 Python 3.10+ 且在 PATH 中。'
      : `启动 python 失败: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`引用同步失败(退出码 ${r.status});详见 引用信息/_verify_report.md`);
    process.exit(r.status || 1);
  }
  console.log('引用文件已生成,并与官方引用文件完成对照验证(报告: 引用信息/_verify_report.md)。');
}

async function cmdValidate(verbose) {
  ensureRefs();
  const papers = scanLibrary();
  const problems = [];

  // 1. notes/fulltext pairing (all papers, zone-agnostic)
  for (const p of papers) {
    if (p.notes && !p.fulltext) problems.push(`${p.id}: 有 notes 但无 fulltext`);
    if (p.notes && countVerifyMarkers(p.notes.abs) > 0) problems.push(`${p.id}: notes 残留 ${countVerifyMarkers(p.notes.abs)} 处 "# 待校验"(AI 未校验)`);
    if (p.notes && isDraftNotes(p.notes.abs)) problems.push(`${p.id}: notes 仍为 draft:true(未完成)`);
    if (p.notes) {
      const fm = parseFrontmatter(readFileSync(p.notes.abs, 'utf-8'));
      if (fm) {
        if (fm.category && fm.category !== p.dirRel) problems.push(`${p.id}: notes frontmatter category="${fm.category}" ≠ 实际目录 "${p.dirRel}"`);
        const expSource = `${p.dirRel}/${p.id}.fulltext.md`;
        if (fm.source && fm.source !== expSource) problems.push(`${p.id}: notes source="${fm.source}" ≠ 实际 "${expSource}"`);
        if (p.zone === 'long') {  // 长篇概览:字数上限 + 完整性
          const ov = typeof fm.overview === 'string' ? fm.overview : '';
          if (ov.length > OVERVIEW_MAX) problems.push(`${p.id}: 长篇概览 ${ov.length} 字 > 上限 ${OVERVIEW_MAX}(validate 强制)`);
          else if (!ov && fm.draft !== 'true') problems.push(`${p.id}: 长篇概览为空但 draft≠true(概览缺失)`);
        }
      }
    }
  }
  // 1b. PDF vault reachable? (needed for pdf path checks below)
  if (!pdfRefsDirExists()) problems.push(`同步盘 PDF 库不可达: ${getPdfRefsDir()}(--pdf-root / NOTEGEN_PDF_ROOT 可指定)`);
  // 1c. PDFs must never live inside the in-repo metadata tree
  for (const s of findRepoPdfs()) problems.push(`PDF 混入仓内资料库(应只在同步盘 PDF 库): ${s}`);

  // 2. per-zone index: path existence + ref uniqueness (dual-root: pdf → vault)
  const validateIndex = (zone) => {
    const idx = loadIndex(zone);
    for (const e of (idx.entries || [])) {
      for (const k of ['pdf', 'fulltext', 'notes']) {
        const rel = e[k];
        if (!rel) continue;
        const base = k === 'pdf' ? getPdfRefsDir() : getRefsDir();
        if (!existsSync(path.join(base, ...String(rel).split('/')))) problems.push(`[${zone}] 索引 ${e.id}.${k} 路径不存在: ${rel}`);
      }
    }
    const refs = (idx.entries || []).map(e => e.ref).filter(Boolean);
    const dupRefs = refs.filter((r, i) => refs.indexOf(r) !== i);
    for (const r of [...new Set(dupRefs)]) problems.push(`[${zone}] 重复 ref: ${r}`);
    return (idx.entries || []).length;
  };
  const jCount = validateIndex('journal');
  const lCount = validateIndex('long');

  if (problems.length === 0) {
    console.log(`validate 通过:${papers.length} 篇文献(期刊索引 ${jCount} 条 / 长篇索引 ${lCount} 条;长篇概览上限 ${OVERVIEW_MAX} 字),无问题。`);
  } else {
    console.log(`validate 发现 ${problems.length} 个问题:`);
    for (const x of problems) console.log(`  ✗ ${x}`);
    process.exitCode = 1;
  }
}

// ─── utils ───────────────────────────────────────────────────────
/** Find stray .pdf files inside the in-repo metadata tree (should be none). */
function findRepoPdfs() {
  const found = [];
  (function walk(dir, relDir) {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isFile() && e.name.endsWith('.pdf')) found.push(rel);
      else if (e.isDirectory()) walk(path.join(dir, e.name), rel);
    }
  })(getRefsDir(), '');
  return found;
}

function ensureRefs() {
  if (!refsDirExists()) {
    console.error(`未找到 reference_materials/(从 ${process.cwd()} 向上查找)。用 --root <项目根> 指定。`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`note-gen — reference_materials 笔记生成 skill(脚本侧)

用法: node ${SCRIPT_PATH} <command> [options]

布局: 双库 — 仓内 reference_materials/(notes/fulltext/索引/引用信息,入 Git)
      + 同步盘 PDF 库(仅 PDF,类目树同构;两区 未归类/ 为新 PDF 下载着陆区)。

命令:
  status                 扫描两区,报告待办(待 scaffold/待 AI 完成/待分类/索引差异/长篇 PDF-only)
  scaffold [--all|--id ID]  为缺 notes 的 fulltext 生成 notes 骨架(期刊六部分/长篇概览+目录,标 # 待校验)
  toc [--id ID]           长篇 fulltext 提取章节目录+行号 → _noteops/<id>.toc.raw.md(双锚点定位用)
  create-category <路径>    显式新建类目目录(仓内 + 同步盘 PDF 库同步创建)
  apply [--dry-run]       读 _noteops/classify.json 移动 md(仓内)+ PDF(同步盘)到目标类目,并改写 notes source/category
  reindex [--dry-run]     按文件系统分别对齐 期刊文献/_index.json 与 长篇文献/_index.json
  validate                校验两区路径(pdf 按同步盘 PDF 库)/配对/frontmatter 一致性/重复 ref/残留 # 待校验/PDF 混入仓内
  cite                    引用文件同步:生成每篇 .ris 并与 doi.org 官方引用文件对照验证(调用 引用信息/脚本/,需 Python 3.10+)

选项:
  --root <dir>      指定项目根(含 reference_materials/ 的目录)
  --pdf-root <dir>  指定同步盘 PDF 库根(无默认值,用本参数或 NOTEGEN_PDF_ROOT 激活 PDF 库功能)
  --id <id>         scaffold 指定单篇(按 fulltext 文件名去 .fulltext.md)
  --all             scaffold 处理全部未归类缺 notes 项(默认即此)
  --dry-run         预览不写盘(apply/reindex/create-category/scaffold 支持)
  --verbose, -v     详细输出

AI 负责:写 notes 正文/翻译、分类决策(写 _noteops/classify.json)、判断新类目、校验 # 待校验、venue/缺失 doi、核查 cite 对照报告(验收无 ❌)。
脚本负责:以上全部机械操作。各命令独立可跑,缺前置优雅跳过。`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
