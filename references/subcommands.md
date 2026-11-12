# note-gen subcommands — detailed reference

Entry point: `node .agents/skills/note-gen/scripts/note-gen.mjs <command> [options]`
Common options: `--root <dir>` (project root), `--pdf-root <dir>` (sync-drive PDF vault root), `--dry-run`, `--verbose`/`-v`.

Path resolution: **metadata root** = `--root` > `NOTEGEN_ROOT` env > walk up from
cwd to the first dir containing `reference_materials/` > cwd; **PDF vault root**
= `--pdf-root` > `NOTEGEN_PDF_ROOT` env > **none by default** (see
`lib/paths.mjs`) — set one to activate vault features. All index paths use
forward slashes relative to their own root (with zone prefixes, e.g.
`期刊文献/...` or `长篇文献/...`): `fulltext`/`notes` relative to the in-repo
metadata root, `pdf` relative to the vault root (dual-root layout, isomorphic
category trees on both sides).

**Dual zones**: under `reference_materials/`, `期刊文献/` (journal papers,
ref-NNN) and `长篇文献/` (books/theses, long-NNN) — two self-contained zones,
each with its own `_index.json`, notes spec (`文献笔记生成规范.md` or
`长篇文献笔记生成规范.md`) and `文献分类决策树.md`. A paper's zone is decided
SOLELY by its directory path (`期刊文献/` → journal, `长篇文献/` → long),
never by content/line-count heuristics.

**Dual roots**: md-class assets (notes/fulltext/indexes/citation info) live in
the in-repo metadata library; PDFs live only in the sync-drive vault — new PDFs
are downloaded into its `期刊文献/未归类/` or `长篇文献/未归类/` landing dirs.

Scan filter: directories and files with `_`/`.` prefixes are skipped (so
`_noteops/`, hidden items, `文献分类决策树.md`/notes specs/`_index.json`/`AGENTS.md`/`引用信息`
never count as literature — same-named files inside zone subdirs are ignored
too); one paper = one `*.fulltext.md` inside a repo directory, its
`<id>.notes.md` sits beside it, and `<id>.pdf` resolves at the same relative
path in the **sync-drive vault**.

---

## status
Read-only full-library scan, reporting **in two sections — journal zone and longform zone**:
- **To scaffold**: fulltexts without notes (listed as `[dir] <id>`).
- **Awaiting AI completion**: notes with `draft:true`.
- **Awaiting AI verification**: notes with leftover `# 待校验` (with counts).
- **To classify**: `draft:false` notes still in 未归类/.
- Whether the classification decision file exists (`_noteops/classify.json`).
- Index ↔ filesystem drift: papers not in the index; index orphans (files deleted/moved away).
- **Longform PDF-only** (PDF in the vault without a fulltext, awaiting
  pdf_to_markdown) reported separately.
Always runnable; errors and exits if `reference_materials/` is absent; warns if the vault root is unreachable.

## scaffold [--all | --id ID] [--dry-run]
Generate notes skeletons for **fulltexts lacking notes**. Default and `--all`:
scan `未归类/`; `--id` targets one paper (full-library search). Notes exist → skip.

Generated notes.md (template):
```yaml
---
id: <id>                              # filename minus .fulltext.md
ref: ref-0NN                          # _index.json max ref + 1
source: 未归类/<id>.fulltext.md
title_en: "<extracted>"               # script
title_zh: ""                          # AI translation
authors: [...]  # 待校验              # script extract + AI verify
affiliations: [...]  # 待校验
year: 20NN  # 待校验                  # script extract + AI verify
venue: ""                             # AI
doi: "..."  # 待校验                  # script extract + AI verify
category: 未归类
keywords: []  topics: []  tags: []  takeaway: ""   # AI
draft: true                           # AI flips to false when done
generated: <today>
spec: 文献笔记生成规范.md
---
# Part-one-to-six heading skeleton (EN title/authors/affiliations/EN-abstract
# comment pre-filled; the rest left for the AI)
```

**Metadata extraction (best-effort, AI as backstop; implementation in
`scripts/lib/extract.mjs`, independently importable and tested)**:
- `title_en`: collects all markdown heading candidates of ≥12 chars, skipping
  journal names/banners ("Short communication", "Journal Pre-proof",
  "Contents lists available", a journal name followed by "journal homepage:",
  etc.); **prefers the nearest heading above the author line** (`<sup>`/orcid)
  (the first `#` in a ScienceDirect fulltext is often the journal name, not
  the article title).
- `authors`: the first author-like short line within the first 40 lines
  (contains commas/`<sup>`/orcid, and is not an institution, not boilerplate,
  not prose, length ≤200); author names inside a `#` heading are still
  recognized; split on commas/semicolons/` & `/` and ` (case-insensitive),
  dropping single-letter superscript residue.
- `affiliations`: lines containing institution keywords (or starting with
  `<sup>`/`^x^`/bullets) that are not author lines; copyright/funding/license
  boilerplate, prose (containing "Section N/we present/...") and email lines
  stripped; truncated before Corresponding author / E-mail / Received.
- `doi`: regex `10\.\d{4,9}/...` in the front matter only (first 100 lines —
  never the whole text, to avoid grabbing other papers' DOIs from the
  references).
- `year`: matched in the order `Available/Published online > Accepted >
  Published > Received > ©`, allowing digits of dates between the keyword and
  the year (e.g. "Accepted 17 April 2016"); if nothing matches, a plausible
  year nearest now (1990–2030).
- `abstract_en`: tolerates `**`/`_`-emphasized "Abstract" headings;
  **excludes pre-proof / copyright-notice paragraphs**; with no label, takes
  the first ≥400-char paragraph that is neither authors nor affiliations
  (Nature/NatCommun style).

> Publisher formats vary widely; every extraction is flagged `# 待校验`; the
> AI must verify and delete the marker.
>
> The **longform zone** uses `renderLongScaffold` (overview+TOC two parts, not
> six): longform fields like `type`/`isbn` pre-filled; the `# 目录` section is
> pre-filled from `extractToc()` (dual anchors); ref uses long-NNN.

## toc [--id ID] [--dry-run]
TOC extraction for longform fulltexts. Reads the fulltext, regex-extracts
Part / Chapter / section (N.M[.K]) headings + **1-indexed line numbers**, and
writes `_noteops/<id>.toc.raw.md` (dual anchors: heading + L number).

- **OCR tolerance**: Chapter covers three forms — `# <span>...Chapter N`,
  `# <span>...**Chapter N**` (bold), `# Chapter N`; headings are stripped of
  `**`/span uniformly.
- **No hard cut of the body start**: all candidates including duplicates are
  output (both the front Contents-table Part and the body Part remain); line
  numbers let the AI tell them apart (e.g. L115 front vs L689 body).
- **Chapter-gap detection**: chapters still missing after the regexes →
  flagged `⚠ suspected missed Chapter N (range Lx–Ly)`.
- **Missing titles**: e.g. `Chapter 8` with a number but no title → marked
  `(title missing)`, the AI fills it from the Preface.
- Default (no `--id`): process all longform fulltexts; `--id` targets one.
- Purpose: the basis for the AI's overview and TOC cleaning; when reading,
  `Read offset=<L>` jumps to the chapter. Rerun anytime to refresh numbers.

## create-category <path> [--dry-run]
Explicitly create a top-level category under `reference_materials/`
(`光固化综述`, or a sub-path like `材料挤出综述/其他`), and **mirror-create**
the same-path category in the sync-drive vault. Exists → notice;
`--dry-run` → preview without creating.
**After creation you MUST register it in `reference_materials/文献分类决策树.md`**
(decision tree and "existing categories" table — an AI task). apply never
auto-creates md-side directories.

## apply [--dry-run]
Reads `reference_materials/_noteops/classify.json`. Schema:
```json
{ "decisions": { "<id>": { "target": "<category path>", "rationale": "<one line>" } },
  "new_categories": ["<advisory only; actually create dirs via create-category>"] }
```
Per decision: locate `<id>`'s fulltext/notes/pdf library-wide → **move the md
into the repo's `target` and the PDF into the same-path category in the vault**
(vault-side dirs auto-created if absent) → rewrite the notes frontmatter
`source` and `category` to the new paths. On completion **clean up**
`classify.json` (**no** `.done` archive kept): all decisions applied (nothing
skipped) → delete `classify.json` (and remove an emptied `_noteops/`); skips
happened → rewrite `classify.json` to hold only the unapplied decisions, so
targets can be fixed and rerun.
- No classify.json → prints "no classification decisions", exit 0.
- `target` directory absent (md side) → skip that entry + warning (never auto-create).
- **Cross-zone moves forbidden** (target zone ≠ file's zone, e.g. a longform
  paper targeted at `期刊文献/...`) → skip + warning; target must share the
  file's zone.
- File no longer in place → skip.
- `--dry-run` prints the mv plan only.

## reindex [--dry-run]
Scans the whole library and reconciles **both** `_index.json` files
(`期刊文献/_index.json` and `长篇文献/_index.json`) to filesystem truth
(idempotent, per-zone independently):
- New papers (fulltext not in the index) → an entry is created in their zone's
  index, `ref` = that zone's current max+1 (journal ref-NNN / longform
  long-NNN, independent numbering spaces per zone, historical gaps never
  backfilled).
- Path/category disagreeing with the actual location → corrected.
- Backfilled from notes frontmatter: `title_en/title_zh/authors/affiliations/
  year/venue/doi/keywords/topics/tags/takeaway` (only where frontmatter is
  non-empty).
- `has_fulltext`=true; `has_notes`= notes exist and `draft!=true`.
- **Stale notes-path sync**: if a notes' `source`/`category` disagree with its
  real location (e.g. moved by other means), rewrite those two values (only
  those two lines).
- Recompute `total`/`has_notes_count`/`updated_at`; `quality` stays null for
  new entries (AI-assessed).
- Index orphans (entry in the index, file gone) → reported and **kept, not
  deleted** (human confirmation).

## validate
Read-only check of **both zones**: every index entry's `fulltext`/`notes`
paths exist relative to the metadata root, and `pdf` paths relative to the
vault root; every notes has a sibling fulltext; notes frontmatter
`category`/`source` match the actual directories; each zone's `ref` is unique
(journal ref-NNN / longform long-NNN checked separately); no leftover
`# 待校验`; `draft:true` listed as unfinished; **PDFs inside the in-repo
metadata library** listed as a problem (they belong in the vault only).
Problems → listed, exit 1; all clean → exit 0.

## cite
Citation-file sync (step 7 of the full pipeline; also runnable standalone
after manual index edits): locates
`reference_materials/引用信息/脚本/同步引用信息.py` and runs it with
`python -X utf8` (stdio passthrough, printing the build + verify logs in
turn).
- **build**: per paper from both zones' `_index.json`, take the DOI (journal
  paper/preprint missing a DOI → Crossref bibliographic search fallback;
  thesis → built from index metadata) and regenerate
  `引用信息/文献引用文件/{ref}_{first-author}{year}.ris` (exactly one file per
  paper); Crossref results cached in `引用信息/脚本/crossref_cache.json` —
  incremental reruns don't re-fetch.
- **verify**: per paper, download the official RIS via doi.org content
  negotiation (stored under `引用信息/官方文献引用文件/`), then a
  **file-level three-way comparison** of ours ↔ official RIS ↔ local index,
  reported into `引用信息/_verify_report.md`.
- Acceptance: **no ❌ pending human review**; ⚠️ minor differences must each be
  explainable. Any ❌ or missing python → exit ≠ 0.
- Dependencies: the `引用信息/脚本/` toolchain + Python 3.10+ (stdlib only);
  directory missing → error exit.

---

## Independence (design principle)

Every subcommand works from a **scan of the current state**, never from an
assumed run order of the others:
- `reindex` reads the filesystem's true positions — it does not require
  `apply` first.
- `apply` only moves files + notes frontmatter — it does not require `reindex`
  first.
- `validate`/`status` are purely read-only — no prerequisites at all.
- `cite` reads the indexes and caches directly — no other command needed first
  (it only becomes meaningful after reindex within the pipeline).
- `scaffold` does not require `_index.json` to exist (ref assignment uses the
  current max; empty library starts at ref-001).
Hence any subcommand runs alone and repeatedly; missing prerequisites degrade
gracefully — nothing ever crashes because something elsewhere wasn't run.
