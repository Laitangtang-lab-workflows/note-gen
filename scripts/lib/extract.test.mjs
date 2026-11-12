// extract.test.mjs — regression guard for the metadata-extraction heuristics.
//
// Self-contained: every fixture is an inline mini-header, so this test does
// NOT depend on any file in reference_materials/ and travels with the skill
// when it is copied to another project.
//
// Run:  node scripts/lib/extract.test.mjs
// Exit status is non-zero if any assertion fails, so it can gate CI / a
// pre-commit check. Each fixture encodes a real failure observed during
// note generation (see the "hardened" notes in extract.mjs).

import { extractTitle, extractAuthors, extractAffiliations } from './extract.mjs';

let failures = 0;
const log = (ok, label, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${label}] ${detail}`);
  if (!ok) failures++;
};

// ---------- TITLE ----------
// Each title fixture ends with a trailing section heading ("1 Introduction" /
// "AFFILIATIONS") that must NOT be mistaken for the title.

log(
  extractTitle([
    '# Journal of Non-Newtonian Fluid Mechanics',
    '',
    'journal homepage: www.elsevier.com/locate/jnnfm',
    '# The log-conformation tensor approach in the FVM framework',
    'A. Afonso, P.J. Oliveira, F.T. Pinho, M.A. Alves <sup>a</sup>',
    '#### 1. Introduction',
  ]).startsWith('The log-conformation'),
  'title/elsevier-journal-banner',
  'must skip the ScienceDirect journal-name heading',
);

log(
  extractTitle([
    '#### **FULL RESEARCH ARTICLE**',
    '# **Geometric characterization of orthogonally printed layers**',
    '**Sina Jafarzadeh · Raphaël Comminal**',
    '# 1 Introduction',
  ]).startsWith('Geometric characterization'),
  'title/article-type-label',
  'must skip the "FULL RESEARCH ARTICLE" label above the title',
);

// The core 2026-07-24 bug: a superscript-marked affiliation line was read as
// the author line, so the section header after it was returned as the title.
log(
  extractTitle([
    '# Real Title of the Paper on Elastoviscoplastic Flow',
    '',
    '# AFFILIATIONS',
    '',
    '<sup>1</sup>Department of Physics, Some University, Country',
    '# ABSTRACT',
  ]).startsWith('Real Title of the Paper'),
  'title/leading-sup-affiliation',
  'a leading-<sup> affiliation line is not an author line',
);

// Same bug, bullet-prefixed affiliation ("- <sup>3</sup> Flow Science, Inc").
log(
  extractTitle([
    '# Another Real Title About Strand Deposition',
    '',
    '- <sup>1</sup>Department of Mechanical Engineering, Some University',
    '- <sup>3</sup>Flow Science, Inc, Santa Fe, USA',
    '# 1 Introduction',
  ]).startsWith('Another Real Title'),
  'title/bullet-sup-affiliation',
  'a bullet + <sup> affiliation line is not an author line',
);

// Brackbill-style: title is an H2 with an escaped trailing "\*", no <sup>/orcid
// author line at all — must fall back to the first non-banner heading.
log(
  extractTitle([
    '<!-- extracted via marker + surya_table OCR -->',
    '',
    '## A Continuum Method for Modeling Surface Tension\\*',
    '',
    'J. U. BRACKBILL, D. B. KOTHE, AND C. ZEMACH',
    '#### I. INTRODUCTION',
  ]) === 'A Continuum Method for Modeling Surface Tension',
  'title/h2-no-authorline',
  'falls back to first non-banner heading when no author line exists',
);

// ---------- AUTHORS ----------

// Springer / European journals separate authors with the middle dot "·".
log(
  JSON.stringify(extractAuthors([
    '**Alessio Pricci<sup>1</sup> · Md. Tusher Mollah<sup>2</sup> · Jon Spangenberg<sup>3</sup>**',
  ]).sort()) === JSON.stringify(['Alessio Pricci', 'Jon Spangenberg', 'Md. Tusher Mollah'].sort()),
  'authors/middle-dot-split',
  'must split on "·" and strip trailing superscript digits',
);

// Escaped "\*" corresponding-author marker leaves a trailing backslash.
log(
  JSON.stringify(extractAuthors(['F. Pimenta, M.A. Alves\\*'])) === JSON.stringify(['F. Pimenta', 'M.A. Alves']),
  'authors/trailing-backslash',
  'must strip the trailing backslash from "\\*"',
);

// Prose lines must never be returned as authors.
log(
  extractAuthors(['Note: This paper is part of the Special Topic, Non-Newtonian Fluids']).length === 0,
  'authors/reject-note-prose',
  '"Note: …" is prose, not authors',
);
log(
  extractAuthors(['times compared to traditional subtractive formative processes']).length === 0,
  'authors/reject-lowercase-prose',
  'lowercase-leading prose is not authors',
);

// ---------- AFFILIATIONS ----------

// Romance-language affiliations (Departamento / Faculdade / Universidade).
log(
  extractAffiliations([
    'CEFT, Departamento de Engenharia Química, Faculdade de Engenharia da Universidade do Porto, Portugal',
  ]).length === 1,
  'affil/romance-keywords',
  'must recognise Departamento / Faculdade / Universidade',
);

// "Name email@host" corresponding-author contact line is not an affiliation.
log(
  !extractAffiliations(['Sina Jafarzadeh sinja@dtu.dk']).some(a => /sinja@dtu/.test(a)),
  'affil/reject-name-email',
  '"Name email@host" must not be grabbed as an affiliation',
);

// Corresponding-author fragment left after cutting the email tail.
log(
  !extractAffiliations(['a) Author to whom correspondence should be addressed: yefh@ncu.edu.cn']).some(a => /Author to whom/i.test(a)),
  'affil/reject-fragment',
  '"a) Author to whom …" fragment must be rejected',
);

// Formula / paragraph pollution is dropped by the length cap.
log(
  extractAffiliations([
    'where sigma is the fluid surface tension coefficient (in units of force per unit length), pa is the pressure in fluid for the viscous stress tensor, and this sentence just keeps going and going far beyond any real affiliation to exceed the length cap and test that long formula paragraphs are not grabbed as an affiliation line at all',
  ]).length === 0,
  'affil/reject-formula-pollution',
  'long formula / paragraph text must be rejected',
);

// A company affiliation with "Inc" (no department/university keyword) is kept.
log(
  extractAffiliations(['Flow Science, Inc, 683 Harkle Road, Santa Fe, NM 87505, USA']).length === 1,
  'affil/keep-company-inc',
  'a company affiliation ("Inc") must be kept',
);

// ---------- summary ----------
console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
