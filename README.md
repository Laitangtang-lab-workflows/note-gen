# note-gen

**Curate a research literature library with an AI in the loop: dual-zone notes generation (journal six-part notes, longform overview+TOC with line anchors), heuristic metadata extraction with AI verification, decision-tree classification, scripted moves across a dual-root layout, index reconciliation, and Crossref-based citation sync.**

> [!NOTE]
> This repository is **written and maintained entirely by AI agents** under human direction — see [AI-maintained](#ai-maintained).
> Documentation is English-first; a Chinese README is available ([README.zh-CN.md](README.zh-CN.md)).

## Why

A research library rots unless every paper gets real notes, a real classification, and a citation file that matches the official record — but doing all that by hand doesn't scale, and letting an AI freelance doesn't stay correct. This skill splits the work the only way that works: **the AI does the understanding, scripts do the mechanics**:

- **Dual-zone notes** — journal papers get six-part notes (title, authors, full abstract translation, per-section summaries, conclusions, interesting bits); books and theses get a ≤300-char overview plus an accurate TOC with fulltext line-number anchors (never read a 10⁴-line book end to end).
- **Best-effort extraction with mandatory verification** — a heuristic extractor pulls title/authors/affiliations/DOI/year across Elsevier/Springer/AIP/OCR layouts; every field is flagged for AI verification, with known traps documented (journal-name headings, flattened superscripts, accepted-vs-published years).
- **Decision-tree classification** — the AI classifies by each zone's decision tree and writes a reviewable decisions file; `apply` moves the md triplet in the repo and the PDF in the sync-drive vault together, refusing cross-zone moves, gated behind dry-run previews.
- **Index reconciliation** — two per-zone `_index.json` files kept in lockstep with the filesystem; every subcommand stateless and idempotent.
- **Citation sync with teeth** — per-paper RIS regenerated from Crossref, then file-level cross-checked against the official doi.org RIS; any ❌ stops the pipeline.
- **Guarded by tests** — the extractor carries a self-contained regression suite; every new failure becomes a fixture before it gets fixed.

## Install as a skill

```
git clone https://github.com/Laitangtang-lab-workflows/note-gen ~/.agents/skills/note-gen
```

Works with any agent harness supporting the SKILL.md convention (Claude Code, DeepSeek Harness, …). Node.js required; the optional citation sync additionally needs the `引用信息/脚本/` Python 3.10+ toolchain beside `reference_materials/`. The sync-drive PDF vault has no default location — set `NOTEGEN_PDF_ROOT` (or `--pdf-root`) to activate PDF-side features.

## Repository layout

| Path | Content |
|---|---|
| `SKILL.md` | Skill entry point: pipeline, AI contracts per zone, classification stage |
| `references/subcommands.md` | The full subcommand reference |
| `scripts/note-gen.mjs` + `scripts/lib/` | The pipeline implementation (zero dependencies) incl. regression tests |

## AI-maintained

Every file in this repository — code, documentation, this README — is written and updated by AI agents under human supervision, and the pipeline exists so that AI sessions curate a real research library under auditable rules. Expect commits to be machine-authored; humans review direction and decisions, not lines.

## License

[CC0-1.0](LICENSE) — released to the public domain. Use, fork and vendor it into anything, no attribution required (a nod is always appreciated).

By submitting a pull request you agree that your contributions are dedicated under CC0 as well.
