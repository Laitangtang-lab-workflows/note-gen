// extract.mjs — best-effort metadata extraction from a fulltext's header.
// Extracted from note-gen.mjs (2026-07-23) so the logic is independently testable
// (note-gen.mjs is a CLI script with no import guard; importing it would run it).
//
// All extraction is heuristic and best-effort — scaffold flags every field
// `# 待校验`; the AI must verify against the fulltext and remove the marker.
//
// Design notes (hardened 2026-07-23 after a 6-paper regression):
//  - Title: skip ScienceDirect journal-name / banner headings (the first `#`
//    line in Elsevier fulltexts is the journal name or "Short communication" /
//    "Journal Pre-proof"), and prefer the heading immediately preceding the
//    author line.
//  - Year: tolerate day/month digits between the date keyword and the year
//    (old regex broke on "Accepted 17 April 2016" because of the "17").
//  - Abstract: tolerant of `**`/`_` emphasis on the "Abstract" heading, and
//    reject Elsevier pre-proof / license disclaimer paragraphs in the fallback.
//  - Affiliations: strip copyright / funding / license boilerplate sentences
//    (e.g. "U.S. Government's right … Department of Energy") and cut
//    corresponding-author / e-mail / received-date tails.
//  - Authors: split on " AND "/" & " case-insensitively; read author names even
//    when the OCR put them inside a `#` heading; ignore long prose/abstract lines.
//
// Design notes (hardened 2026-07-24 after a second 6-paper regression):
//  - Title: looksLikeAuthorLine was false-triggering on affiliation lines that
//    start with a superscript marker (<sup>1</sup>Department…) or on
//    corresponding-author <sup>*</sup> footnotes, so the "heading before the
//    author line" rule picked the section header ("Introduction" / "AFFILIATIONS")
//    instead of the title. Now require a real author line (≥2 names, non-leading
//    marker, not an affiliation); else fall back to the first non-banner heading.
//  - Authors: also split on the middle-dot "·" / bullet "•" (Springer & some
//    European journals separate authors with "·"), strip a trailing backslash
//    left by an escaped "\*" corresponding-author marker, and reject prose lines
//    (lowercase-leading, "Note: …", "This paper …", "Compared to …").
//  - Affiliations: multilingual keywords (departamento / faculdade / univers… /
//    escola / centro / institut), reject "Name email@host" corresponding-author
//    contact lines, and cap length at 320 chars (drops formula / paragraph
//    pollution that sneaks past the keyword check on old OCR fulltexts).

// Headings that are structural banners, not article titles.
const GENERIC_HEADINGS = new Set([
  'article', 'review', 'abstract', 'references', 'introduction', 'keywords',
  'article info', 'article history', 'article informations',
  'short communication', 'short paper', 'journal pre-proof', 'journal preproof',
  'contents lists available', 'elsevier', 'sciencedirect',
  // article-type labels that sit above the real title (Springer / Wiley / ACS)
  'research article', 'full research article', 'original research',
  'original article', 'original paper', 'review article', 'full paper',
  'credit authorship contribution statement', 'author contributions',
  'declaration of competing interest', 'declaration of interests',
  'data availability', 'data availability statement',
  'acknowledgements', 'acknowledgments', 'acknowledgement',
  'conflict of interest', 'funding', 'appendix',
  // legacy entries kept for backwards compatibility
  'bioactive materials', 'remiero', 'polymers for additive manufacturing prospective',
]);

// Copyright / funding / license boilerplate — never an affiliation.
const BOILERPLATE = /government'?s\s+right|royalty[- ]?free|non[- ]?exclusive|copyright|©|all\s+rights\s+reserved|under\s+the\s+auspices|this\s+work\s+was\s+(performed|supported|funded|carried)|acknowledged|funded\s+and\s+supported|gratefully\s+acknowledg|contract\s+(no\.|number)|grant\s+(no\.|number)|licensed\s+under|creative\s+commons|open\s+access|published\s+by|CC\s+BY/i;

// Elsevier pre-proof / "please cite" disclaimer — never an abstract.
const DISCLAIMER = /this\s+is\s+a\s+pdf\s+file|pre-?proof|please\s+cite\s+this\s+article|has\s+undergone\s+enhancements|definitive\s+version\s+of\s+record|copyediting|typesetting|subject\s+to\s+change/i;

// Prose (paper-organization / abstract sentences) — never an affiliation.
const PROSE = /\bsection\s+\d|\bfigure\s+\d|\b(?:are|is)\s+(?:discussed|presented|described|organized)|\bwe\s+(?:present|describe|develop|propose|show|perform)|\bin\s+this\s+(?:work|paper|study|article)\b|\bthe\s+paper\s+is\s+organized|\belectronic\s+annex|\bsupplementary\s+material/i;

function cleanMd(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/^#+\s*/, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\\*_]+$/, '')      // trailing escaped footnote / emphasis markers (e.g. "...\*", "**")
    .trim();
}

function nextNonEmpty(lines, fromIdx) {
  for (let i = fromIdx; i < lines.length; i++) {
    if (lines[i].trim()) return lines[i];
  }
  return '';
}

// Is this heading a journal-name / banner rather than the article title?
function isBannerHeading(cand, nextLine) {
  const low = cand.toLowerCase();
  if (GENERIC_HEADINGS.has(low)) return true;
  if (/^journal homepage|doi\s*[:/]|www\.elsevier\.com/i.test(cand)) return true;
  if (/^(short\s+communication|journal\s+pre-?proof|contents\s+lists\s+available|elsevier|sciencedirect)\b/i.test(cand)) return true;
  if (/^article\s+(info|history|informations)\b/i.test(cand)) return true;
  // ScienceDirect pattern: the journal-name heading is followed by a "journal homepage:" line
  if (nextLine && /journal\s+homepage|www\.elsevier\.com\/locate/i.test(nextLine)) return true;
  return false;
}

// Author-line indicator: a real author line carries superscript markers / an
// ORCID *and* multiple capitalized names. Crucially, a leading superscript
// (`<sup>1</sup>Department…`) or an institution keyword means it is an
// AFFILIATION line, not an author line — treating those as author lines is what
// made the "title = heading before author line" rule pick section headers
// ("Introduction" / "AFFILIATIONS") instead of the real title.
function looksLikeAuthorLine(s) {
  if (s.length > 200) return false;
  if (looksLikeAffiliation(s)) return false;
  // a leading superscript (optionally after a list bullet "- "/"* ") is an
  // affiliation marker, not an author line — e.g. "- <sup>3</sup> Flow Science, Inc"
  if (/^[-*•]?\s*<sup/i.test(s) || /^\^[a-z\d]+/i.test(s)) return false;
  if (!(/<sup[^>]*>/i.test(s) || /orcid/i.test(s))) return false;
  const names = (s.replace(/<[^>]+>/g, ' ').match(/\b[A-Z][A-Za-zÀ-ÿ.\-]{1,}\b/g) || []).length;
  return names >= 2;
}

function looksLikeAffiliation(s) {
  // Broadened for Romance / Germanic languages: "univers" covers university /
  // universidade / universität / università / université; "laborat" covers
  // laboratory / laboratório / laboratoire; plus departamento / faculdade /
  // facultad / escola / centro / institut.
  return /department|departamento|univers|institute|institut|school|laborat|center|centre|centro|college|inc\b|corp|ltd\b|gmbh|academy|division|faculty|faculdade|facultad|escola|@|corresponding|作者|大学|学院|研究所|实验室/i.test(s);
}

// Real institution signal — like looksLikeAffiliation but WITHOUT the bare "@"
// catch and WITH company suffixes (inc/corp/ltd/gmbh). Used to validate a
// cleaned affiliation: a "Name email@host" corresponding-author line or an
// "a) Author to whom" fragment contains "@" / no keyword and must be rejected.
const INSTITUTION = /department|departamento|univers|institute|institut|school|laborat|center|centre|centro|college|academy|division|faculty|faculdade|facultad|escola|\binc\b|\bcorp\b|\bltd\b|\bgmbh\b|作者|大学|学院|研究所|实验室/i;

function extractTitle(head) {
  const cands = [];
  for (let i = 0; i < head.length; i++) {
    const hm = head[i].match(/^#{1,4}\s+(.+)$/);
    if (!hm) continue;
    const cand = cleanMd(hm[1]);
    if (cand.length < 12) continue;
    if (isBannerHeading(cand, nextNonEmpty(head, i + 1))) continue;
    cands.push({ idx: i, text: cand });
  }
  if (!cands.length) return '';
  // Prefer the heading closest to (just before) the first author line — that is
  // the real article title in ScienceDirect / Elsevier fulltexts.
  let authorIdx = -1;
  for (let i = 0; i < head.length; i++) {
    if (looksLikeAuthorLine(head[i])) { authorIdx = i; break; }
  }
  if (authorIdx > 0) {
    const before = cands.filter(c => c.idx < authorIdx);
    if (before.length) return before[before.length - 1].text;
  }
  return cands[0].text;
}

function cleanAuthorLine(raw) {
  let s = raw
    .replace(/^#+\s*/, '')        // author names are sometimes inside a `#` heading (OCR)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // [name](orcid) → name
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/g, ' ')
    .replace(/<\/?sup[^>]*>/g, ' ')
    .replace(/\^[^\s^]+\^/g, ' ')               // ^a^ superscript
    .replace(/\*/g, '')
    .replace(/\\+$/, '')                        // trailing backslash from escaped "\*" corresponding-author marker
    .replace(/\s+/g, ' ')
    .trim();
  // split on commas / semicolons / middle-dot · / bullet • / " & " / " and ".
  // Springer & some European journals separate authors with "·"; "and" is
  // case-insensitive because names may be uppercase.
  let parts = s.split(/,|;|·|•|\s&\s|\sand\s/i)
    .map(p => p.replace(/^[\s\d.†‡\*&+·•\\]+/, '').replace(/[\s\d.†‡\*·•\\]+$/, '').trim())
    .filter(Boolean);
  parts = parts.filter(p => /[A-Za-z一-鿿]/.test(p));
  parts = parts.filter(p => (p.match(/[A-Za-z一-鿿]/g) || []).length >= 2);  // drop single-letter affil markers (e.g. a stray "b")
  return parts;
}

function extractAuthors(head) {
  for (let i = 0; i < Math.min(head.length, 40); i++) {
    const s = head[i].trim();
    if (!s) continue;
    if (s.length > 200) continue;                                  // prose / abstract paragraph
    if (/^!\[/.test(s)) continue;                                  // image
    if (/^#{1,4}\s/.test(s) && !looksLikeAuthorLine(s)) continue;  // non-author heading
    if (/^<!--|^doi[:：]|^https?|^www\.|journal\s+homepage|elsevier\.com|\bPII\b|\breceived\b|\baccepted\b|\bpublished\b|^©|keywords|article\s+(history|info)|^reference\b/i.test(s)) continue;
    if (BOILERPLATE.test(s)) continue;
    if (looksLikeAffiliation(s)) continue;
    if (PROSE.test(s)) continue;                  // paper-organization / abstract sentences
    if (/^[a-z]/.test(s)) continue;               // prose starts lowercase; author names are Capitalized
    if (/^(note|this\s+(?:paper|work|study)|in\s+this|here\s+we|compared\s+to|figure|table|section)\b/i.test(s)) continue;
    if (!/[,.]/.test(s) && !/<sup[^>]*>/i.test(s) && !/orcid/i.test(s) && !/·/.test(s)) continue;
    const parts = cleanAuthorLine(head[i]);
    if (parts.length >= 2) return parts;
  }
  return [];
}

function extractAffiliations(head) {
  const out = [];
  for (const raw of head.slice(0, 60)) {
    const s = raw.trim();
    if (!s) continue;
    if (/^#{1,4}\s|^<!--|^doi[:：]|^https?:\/\//i.test(s)) continue;
    if (s.length < 8) continue;
    if (BOILERPLATE.test(s)) continue;
    if (PROSE.test(s)) continue;                                   // organization/abstract prose, not an affiliation
    if (/^e-?mail\s+address/i.test(s) || (s.match(/@/g) || []).length >= 2) continue;  // contact line
    const isAff = looksLikeAffiliation(s);
    const hasMarker = /^<sup/i.test(s) || /^\^[a-z\d]+\^/i.test(s) || /^[-•]\s/.test(s);
    if (!isAff && !hasMarker) continue;
    if (!isAff && /orcid|\]\(https?/.test(s)) continue;            // author line w/ links but no affil keyword
    let cleaned = s
      .replace(/<sup[^>]*>[\s\S]*?<\/sup>/g, ' ')
      .replace(/<\/?sup[^>]*>/g, '')
      .replace(/\^[^\s^]+\^/g, '')
      .replace(/^[\s•\-*]+/, '')
      .replace(/\s+/g, ' ')
      .replace(/[*\s]+$/, '')
      .trim();
    // cut corresponding-author / e-mail / date tails
    cleaned = cleaned.split(/\b(Correspondence|Corresponding author|E-?mail address|\bReceived\b|\bRevised\b|\bAccepted\b|Available online)\b/i)[0].trim();
    if (cleaned.length < 8 || cleaned.length > 320) continue;    // cap drops formula / paragraph pollution
    if (BOILERPLATE.test(cleaned)) continue;
    if (!INSTITUTION.test(cleaned)) continue;   // reject corresponding-author fragments & "Name email@host" lines
    out.push(cleaned);
    if (out.length >= 6) break;
  }
  return out.filter((v, i, a) => a.findIndex(x => x === v) === i);
}

function extractDoi(head) {
  // Search the front matter only — broadening to the full text risks grabbing
  // a DOI from the reference list (a cited paper, not this one).
  const m = head.join('\n').match(/10\.\d{4,9}\/[^\s)"'>\]]+/i);
  if (!m) return '';
  return m[0].replace(/[.,;:]$/, '');
}

function clampYear(y) { const n = Number(y); return (n >= 1900 && n <= 2030) ? n : ''; }

function extractYear(fullText) {
  // Publication-year keywords, most reliable first. The gap class `[\s\S]{0,45}?`
  // allows day/month digits between keyword and year (e.g. "Accepted 17 April 2016").
  const patterns = [
    /(?:available\s+online|published\s+online|in\s+press)[\s\S]{0,45}?\b((?:19|20)\d{2})\b/i,
    /\baccepted[\s\S]{0,45}?\b((?:19|20)\d{2})\b/i,
    /\bpublished[\s\S]{0,40}?\b((?:19|20)\d{2})\b/i,
    /\breceived[\s\S]{0,45}?\b((?:19|20)\d{2})\b/i,
    /(?:copyright|©)\s*[\s\S]{0,20}?\b((?:19|20)\d{2})\b/i,
  ];
  for (const re of patterns) {
    const m = fullText.match(re);
    if (m && clampYear(m[1]) !== '') return clampYear(m[1]);
  }
  // fallback: most recent plausible year
  const yrs = [...fullText.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)].map(m => +m[1]).filter(y => y >= 1990 && y <= 2030);
  if (!yrs.length) return '';
  return Math.max(...yrs);
}

function extractAbstract(lines) {
  // 1. explicit "Abstract" heading/label (tolerant of ** / _ emphasis)
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,4}\s*[*_]*\s*abstract\b/i.test(lines[i]) ||
        /^[*_]*abstract[*_]*\s*[:：-]/i.test(lines[i])) {
      start = i + 1; break;
    }
  }
  if (start !== -1) {
    const buf = [];
    for (let i = start; i < Math.min(lines.length, start + 60); i++) {
      const l = lines[i];
      if (/^#{1,4}\s/.test(l)) break;
      if (/^(keywords|received|accepted|published|introduction|1\s+introduction|©)/i.test(l.trim())) break;
      if (/^\*\*keywords/i.test(l)) break;
      buf.push(l);
      if (buf.join(' ').trim().length > 1200) break;
    }
    const txt = buf.join('\n').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<[^>]+>/g, '').trim();
    if (txt.length > 60 && !DISCLAIMER.test(txt)) return txt;
  }
  // 2. fallback: first long paragraph (unlabeled abstract, e.g. Nature/Nat Commun)
  for (let i = 0; i < Math.min(lines.length, 80); i++) {
    const l = lines[i];
    if (l.length < 400) continue;
    if (DISCLAIMER.test(l)) continue;
    if (/^#{1,4}\s|^!|^\s*<|^https?|^doi[:：]/i.test(l)) continue;
    if (/orcid|\]\(https?:\/\//.test(l)) continue;
    if (looksLikeAffiliation(l)) continue;
    return l.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<[^>]+>/g, '').trim().slice(0, 1600);
  }
  return '';
}

export function extractMetadata(fulltextText) {
  const lines = fulltextText.split(/\r?\n/);
  const head = lines.slice(0, 100);
  return {
    title_en: extractTitle(head),
    authors: extractAuthors(head),
    affiliations: extractAffiliations(head),
    doi: extractDoi(head),
    year: extractYear(lines.join('\n')),
    abstract_en: extractAbstract(lines),
  };
}

// Exported for testing.
export { extractTitle, extractAuthors, extractAffiliations, extractDoi, extractYear, extractAbstract };
