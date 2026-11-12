---
name: note-gen
description: Curate the reference_materials/ literature library across TWO zones — 期刊文献/ (journal papers, six-part notes) and 长篇文献/ (books/theses, overview+TOC notes with line-number anchors). Scaffold notes.md skeletons (best-effort metadata extraction), extract longform tables of contents (toc), classify unclassified papers, move files, and reconcile each zone's _index.json. Also owns citation sync (cite)—regenerates per-paper RIS from Crossref metadata and file-level cross-checks them against official doi.org RIS — runs automatically at the end of /note-gen; acceptance is no ❌ in 引用信息/_verify_report.md. The AI does only the understanding work; all mechanics are scripted. Invoke via /note-gen to run the full pipeline end-to-end (scaffold → AI fill → classify → apply → reindex → validate → cite, with dry-run + confirmation before any move). Use when there are *.fulltext.md papers in either 未归类/ needing notes, when the user asks to 生成笔记/分类文献/更新索引/生成引用文件/process the reference library, or after pdf_to_markdown has produced new fulltexts.
---

# note-gen — notes generation & curation for the reference_materials library (dual-zone)

A note-generation + curation pipeline for `reference_materials/`, which is split
into **two self-contained zones**:

| Zone | Directory | Index | Notes spec | Note structure |
|------|-----------|-------|------------|----------------|
| **Journal** | `期刊文献/` | `期刊文献/_index.json` (v2, ref-NNN) | `期刊文献/文献笔记生成规范.md` | six parts (title / authors / abstract translation / per-section summaries / conclusions / interesting bits) |
| **Longform** | `长篇文献/` (books/theses) | `长篇文献/_index.json` (longform v1, long-NNN) | `长篇文献/长篇文献笔记生成规范.md` | two parts (**overview ≤300 chars + accurate TOC**, entries carrying fulltext line-number anchors) |

The user's `pdf_to_markdown` step produces `*.fulltext.md` in the in-repo
metadata root (either zone's `未归类/`); the sibling PDF lives in the sync-drive
PDF vault (`pdf_to_markdown` is run by the user separately — not by this skill).
This skill scaffolds the right note template per zone, classifies,
moves md in the repo tree and the PDF in the vault at the same category path,
and reconciles that zone's index.
**The AI writes content and makes judgments; scripts do every mechanical
operation.** A paper's zone is decided SOLELY by its directory path
(`期刊文献/` vs `长篇文献/`), never by content heuristics.

## Dual-root layout (metadata in-repo / PDF vault on sync drive)

| Root | Location | Content |
|------|----------|---------|
| **Metadata library (in repo)** | `<project root>/reference_materials/` | notes / fulltext / both zones' `_index.json` / citation info / scripts (Git-tracked) |
| **PDF vault (sync drive)** | `getPdfRefsDir()` — **no default**; set `--pdf-root` or `NOTEGEN_PDF_ROOT` to activate | PDFs only; category tree **isomorphic** to the in-repo one; each zone's `未归类/` is the landing dir for new downloads |

New-paper flow: download PDF → vault `未归类/` → `pdf_to_markdown` → fulltext.md
into the **repo** root's same `未归类/` → `/note-gen`. `apply` moves md in the
repo and the PDF in the vault together. Index paths: `fulltext`/`notes` relative
to the repo root, `pdf` relative to the vault root.

**`/note-gen` is the single entry point** — it runs the full pipeline below by
default; ask for a single step in one sentence ("just status", "only scaffold",
"extract the longform TOC").

## When to use

- Either `期刊文献/未归类/` or `长篇文献/未归类/` contains `*.fulltext.md`
  with no `*.notes.md` yet.
- The user asks to generate notes / classify literature / archive the
  unclassified / update the index / extract TOCs / process the reference library.
- After `pdf_to_markdown` produced new fulltexts (journal or longform).

## Prerequisites

- `reference_materials/` must exist with two zone subdirs (`期刊文献/`,
  `长篇文献/`), each carrying its own notes spec (`文献笔记生成规范.md` /
  `长篇文献笔记生成规范.md`, formerly NOTES_SPEC.md), `文献分类决策树.md`,
  and `_index.json`. This skill **reads** them as single sources of truth.
- `cite` additionally requires `reference_materials/引用信息/脚本/`
  (Python 3.10+ toolchain) and `python` on PATH.
- The sync-drive **PDF vault** must be configured and reachable
  (`--pdf-root` / `NOTEGEN_PDF_ROOT` — there is no default); `status`/`validate`/`apply`
  resolve every `pdf` path against it, and `apply` moves classified PDFs inside it.
- Each new paper is a `*.fulltext.md` in the repo root with its PDF in the vault
  at the same category path;
- Longform fulltexts can be huge (10⁴+ lines): **never read them whole**. Use
  `toc` to get the chapter map + line numbers, then `Read offset=.. limit=..`
  for targeted sections.

## AI / script division of labor

| Work | Who |
|------|-----|
| Scan both zones' status, generate notes skeletons, extract metadata (journal: title_en/authors/affiliations/doi/year/abstract; longform: +isbn/type) | script (`scaffold`) |
| **Longform**: extract chapter TOC + line numbers from fulltext → `_noteops/<id>.toc.raw.md` (for dual-anchor locating) | script (`toc`) |
| **Journal notes body**: title_zh, abstract translation, four summaries, five conclusions, six interesting bits | **AI** |
| **Longform notes body**: ≤300-char overview (read toc.raw + Preface fragments), cleaned TOC (strip OCR noise / dedupe front matter / fill missing titles) | **AI** |
| Judgment fields: keywords/topics/takeaway/overview/tags (MDPI judgment), venue, missing doi (may use crossref) | **AI** |
| Verify `# 待校验` fields → fix then **delete the marker** | **AI** |
| `draft: true` → `draft: false` | **AI** |
| Classification decisions (write `_noteops/classify.json`), decide whether a new category is needed | **AI** |
| Create categories, move the triplet, rewrite notes source/category, reconcile each zone's `_index.json`, validate | script |
| Citation regeneration + file-level cross-check against official doi.org RIS (`cite`, calls the `引用信息/脚本/` Python toolchain) | script |
| Review `引用信息/_verify_report.md`: any ❌ → stop and report to the user; ⚠️ → each individually explainable | **AI** |

## Run the full pipeline — what `/note-gen` does by default

You orchestrate the mechanical steps via Bash and perform the understanding
steps yourself. `status`/`scaffold`/`reindex`/`validate` all handle BOTH zones
in one run. The only steps that modify files are `apply` (moves), `reindex`
(index), and `cite` (citation files) — the first two gated behind a dry-run
preview + your explicit confirmation; `cite` is idempotent and safe to rerun.

### 0. Preflight
```bash
test -d reference_materials || { echo "ERROR: reference_materials/ 不存在。"; exit 1; }
node .agents/skills/note-gen/scripts/note-gen.mjs status
```
Report what needs doing (per zone). If nothing pending → tell the user the
library is up-to-date and stop.

### 1. Scaffold skeletons
```bash
node .agents/skills/note-gen/scripts/note-gen.mjs scaffold --all
```
Creates one `notes.md` per unclassified fulltext in **both** zones — journal
template (six-part) or longform template (overview + TOC, the TOC pre-filled from
`extractToc`). Mechanical fields filled, metadata extracted (flagged
`# 待校验`, `draft:true`). Longform ref uses the `long-NNN` space.

### 2. Fill notes content — YOUR understanding step
For **each** newly scaffolded notes (`draft:true` from `status`), follow the
**AI contract** for its zone (journal or longform contract below). For longform, you may
first run `toc --id <id>` to (re)generate `_noteops/<id>.toc.raw.md` if you want
the standalone file.

### 3. Classify — YOUR judgment step
For each finished (`draft:false`) note in a zone's `未归类/`, read THAT zone's
decision tree (`期刊文献/文献分类决策树.md` or `长篇文献/文献分类决策树.md`),
decide `target`; if a new category is needed, `create-category` first + register
it in that zone's tree; write `reference_materials/_noteops/classify.json`.
Show the user proposed classifications before moving.

### 4. Apply (move) — preview + confirm
```bash
node .agents/skills/note-gen/scripts/note-gen.mjs apply --dry-run
```
Show the preview. Then **AskUserQuestion**: "Apply moves" → run `apply` (moves
triplets, rewrites notes source/category, refuses cross-zone moves, deletes
classify.json); "Stop here" → pause.

### 5. Reindex
```bash
node .agents/skills/note-gen/scripts/note-gen.mjs reindex
```
Reconciles **both** indexes (per-zone: new entries, ref=max+1 in that zone's
space, paths, has_notes, frontmatter backfill, stale-notes sync, counts).

### 6. Validate
```bash
node .agents/skills/note-gen/scripts/note-gen.mjs validate
```
Report. Any `draft:true` / `# 待校验` / path mismatches flagged (per zone).

### 7. Cite — citation files sync
```bash
node .agents/skills/note-gen/scripts/note-gen.mjs cite
```
Thin wrapper running `引用信息/脚本/同步引用信息.py`: regenerates each
paper's RIS in `引用信息/文献引用文件/` from Crossref metadata (DOI missing →
bibliographic search fallback; thesis/preprint → index-built records), then
file-level cross-checks ours ↔ official doi.org RIS ↔ local index. Read the
printed verify summary: **any ❌ → STOP and report to the user**; ⚠️ must be
individually explainable (online-first/volume-year drift, journal abbreviations,
the official formatter's GENERIC type). Cached DOIs are not re-fetched —
rerunning is cheap.

### Error handling
Any Bash step exiting non-zero → STOP, report command + output. (Steps 0–1
only create skeletons in `未归类/`; fully reversible.)

### Notes
- `apply` is the first to move files; `reindex` the first to touch indexes.
- Each subcommand is idempotent and independently runnable.
- AI never hand-edits `_index.json` or moves files directly — always via
  `apply`/`reindex`.

## Subcommands (cheat-sheet; each also runs standalone)

| Command | Purpose | If precondition missing |
|---------|---------|-------------------------|
| `status` | scan both zones and report (to scaffold / awaiting AI / to classify / index drift / longform PDF-only) | always runnable |
| `scaffold [--all\|--id ID]` | generate skeletons for notes-less fulltexts (journal six-part / longform overview+TOC, flagged `# 待校验`, `draft:true`) | notes exist → skip |
| `toc [--id ID]` | extract chapter TOC + line numbers from longform fulltext → `_noteops/<id>.toc.raw.md` (dual-anchor locating; OCR-tolerant, incl. bold `**Chapter**` forms) | longform fulltext missing → notice |
| `create-category <path> [--dry-run]` | explicitly create a category (e.g. `期刊文献/光固化综述` or `长篇文献/流变学`) | exists → notice |
| `apply [--dry-run]` | read `_noteops/classify.json` and move: md within the repo tree, PDF at the same path in the vault + rewrite notes source/category (refuses cross-zone moves) | no decisions → exit 0 |
| `reindex [--dry-run]` | reconcile `期刊文献/_index.json` and `长篇文献/_index.json` separately | no notes → has_notes=false |
| `validate` | check both zones' paths/pairing/frontmatter/duplicate refs/leftover `# 待校验`/draft | read-only |
| `cite` | citation sync: regenerate each .ris and cross-check against official doi.org RIS (`引用信息/_verify_report.md`) | 引用信息/脚本 missing → error |

Every subcommand is **standalone and idempotent**. Full detail: `references/subcommands.md`.

## AI contract — journal zone (after scaffold)

Read `<fulltext>.fulltext.md` + `期刊文献/文献笔记生成规范.md`, then:

1. **Verify metadata** (including `title_en` not flagged `# 待校验`): check
   `title_en`/`authors`/`affiliations`/`year`/`doi` against the fulltext head.
   Script extraction is best-effort and still errs across publishers
   (Elsevier / Springer / AIP / old OCR) — typical traps: the title extracted
   as a section heading ("Introduction" / "AFFILIATIONS"); authors merged into
   body text or carrying OCR-flattened superscript letters (e.g. "Afonsoa");
   `year` taken from the received/accepted date (usually one year before
   publication). After fixing, **delete the field's `# 待校验` marker** (and
   resolve any in-body `(待 AI 核对)` notes).
2. **Fill `title_zh`** (translated title).
3. **Part three, full abstract translation**: translate the English abstract
   inside the section-three HTML comment **fully** below the comment (the
   comment may be deleted once done). If the comment says "(no English
   abstract extracted — AI to read the fulltext and translate)", read the
   fulltext and translate directly.
4. **Parts four/five/six**: per-section summaries, key conclusions, AI
   interesting bits (each noting its section, tied to the host research
   project's topics). See 文献笔记生成规范 §3.
5. **Judgment fields**: `keywords`/`topics`/`takeaway` (≤40 chars)/`tags`
   (MDPI journals get the `MDPI` tag; where the body cites their conclusions,
   add `<!-- ⚠️ MDPI source — scrutinize -->`). `venue` is usually not in the
   fulltext head — judge from the whole text. **A missing or doubtful `doi`
   MUST be verified via the crossref MCP (`crossref_search_works` /
   `crossref_get_work`) — never guessed from filenames/ISSN/year** (a
   field-confirmed case: `…jnnfm.2016.12.007` was actually `…12.002`). `year`
   also follows crossref's published year (received/accepted years run ~1
   early).
6. **`draft: true` → `draft: false`** (once all six parts are complete and no
   `# 待校验` remains).

## AI contract — longform zone (after scaffold)

**Core constraint: never read the fulltext through (often 10⁴+ lines).**
Work from `_noteops/<id>.toc.raw.md` (script-extracted, ~100–300 lines, every
chapter/section title + L line number) + selective reading.

1. **Verify metadata** `# 待校验`: check `type` (book/thesis/report),
   `title_en`, `authors` (book = authors/editors; **the script easily mistakes
   series editors or institutions for authors**), `year`, `publisher`, `isbn`
   (the script grabs the print ISBN; switch to the eBook ISBN for e-books),
   `doi` (books can carry one, e.g. Springer `10.1007/...`), `series`. After
   fixing, delete `# 待校验`.
2. **Fill `title_zh`** (translated book/thesis title).
3. **Overview (≤300 chars, hard cap)**: based on toc.raw + selective
   `Read offset=.. limit=..` of the **Preface / Introduction / per-chapter
   survey paragraphs** (locate via toc.raw line numbers, **do not read chapters
   through**). Most textbooks' prefaces contain a "one sentence per chapter"
   paragraph — the best overview material. Write: what it covers, the method
   mainline, its use to the host research project. Also backfill the
   frontmatter `overview`.
4. **Clean the TOC (dual anchors)**: clean from toc.raw — strip OCR residue,
   **dedupe the front matter** (the Contents-table `# Part I` has a small line
   number, the body `# Part I` a large one; keep the body one), **fill
   OCR-missing titles** (e.g. `Chapter 8 (title missing)` → fill from the
   Preface survey, marked `[AI补]`); key chapters may carry a one-phrase topic
   note. **Line numbers must come from toc.raw — the AI never invents them.**
   Final form `- Chapter 3 Mathematical description (L1834)` /
   `  - 3.4 Mass conservation (L1922)`, hierarchical indentation.
5. **Judgment fields**: `keywords`/`topics`/`tags` (e.g. `book`/`thesis`/
   `reference-textbook`). The MDPI rule does not apply to longform.
6. **`draft: true` → `draft: false`** (once overview + TOC are complete and no
   `# 待校验` remains).

> TOC line numbers are fulltext line numbers: `Read offset=<L>` jumps straight
> to that chapter. If the fulltext is re-OCR'd and numbers drift, the title
> text is the fallback — rerun `toc` to refresh.

## Classification stage

Once all notes are `draft:false`: read **that zone's** decision tree (journal →
`期刊文献/文献分类决策树.md`; longform → `长篇文献/文献分类决策树.md`) and assign
a `target` category per unclassified paper. **For edge cases, first grep the
zone's already-classified papers** (keywords, authors, DOI prefixes) to follow
precedent. Then write `reference_materials/_noteops/classify.json`:

```json
{ "decisions": { "<id>": { "target": "<category path with zone prefix>", "rationale": "<one-line reason>" } },
  "new_categories": ["<categories needing creation>"] }
```

`target` must carry the zone prefix (e.g. `期刊文献/材料挤出仿真/DIW` or
`长篇文献/CFD数值方法`). For a new category: first `create-category <prefixed
path>`, then register it in **that zone's** decision tree. `apply` moves only
into **existing** directories and **refuses cross-zone moves** (target zone ≠
file's zone → skip + warning).

## Maintenance: run the tests whenever extraction logic changes

`scripts/lib/extract.mjs` metadata extraction is heuristic and regresses
easily across publishers. After touching it, run the regression tests and pass
all before closing:

```bash
node .agents/skills/note-gen/scripts/lib/extract.test.mjs   # 14 cases, exit 0 = all pass
```

The tests are self-contained inline mini-fixtures (no library content needed),
working wherever the skill is copied. **On every new extraction failure, first
add a fixture reproducing it, then fix extract.mjs until all pass** — turning a
one-off discovery into a permanent guardrail. `extractToc` (longform TOC
extraction) is equally heuristic: on new formats (thesis-style
`Abstract/Introduction` headings, different numbering schemes) check toc.raw
and extend the regexes if needed.

## Portability / reuse

Self-contained under `.agents/skills/note-gen/`. **Copy just this folder** into
another project's `.agents/skills/` and it works immediately — `/note-gen` is
auto-registered from the folder name, no command files to install, no
`settings.json` changes. Scripts resolve the reference root from cwd (walks up
to find `reference_materials/`); no path edits needed. The sync-drive **PDF
vault** has no default location — set `NOTEGEN_PDF_ROOT` (or pass `--pdf-root`)
per machine; without a reachable vault, md-side commands still work while pdf
resolution and `apply`'s pdf moves degrade gracefully. Independent of the
academic-markup skill (own `lib/paths.mjs`, no shared code). **`cite` is the one
exception**: it shells out to
`reference_materials/引用信息/脚本/同步引用信息.py` (Python 3.10+, stdlib only).
Copying the skill alone gives the notes pipeline; citation sync additionally
needs that dir to exist beside `reference_materials/`.
