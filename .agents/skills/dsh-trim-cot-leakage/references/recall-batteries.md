# Recall batteries

Probes for [the taxonomy](../SKILL.md#taxonomy), tuned during the 2026-08 purge. Every hit needs semantic judgment — the batteries over-match by design, and they under-match by nature: each review round of the purge found cases no battery caught, so pair them with an unpatterned read of the densest prose in scope.

## Invocation rules

- Add `--hidden --glob '!.git/**'` so `.agents/` is searched; ripgrep skips dot-directories by default and the purge's biggest miss risk was Agent Notes.
- Exclusions go last so a later include cannot re-admit them: `--glob '!vendor/**' --glob '!node_modules/**' --glob '!.agents/notes/archived/**' --glob '!.agents/skills/dsh-trim-cot-leakage/**'` (the skill's own files quote leaked wording as calibration), plus recorded fixture and snapshot directories in scope. The [owning reference](../SKILL.md) also self-hits through its quoted evidence; judge it as evidence, not usage.
- Natural-language lines carry `-i` so sentence-initial capitals hit ("This PR adds…", "Probably fine…"); the first line, which matches code patterns, stays case-sensitive — `-i` would turn `\bT\d\b` and `\bP-I\b` into noise.
- Bound complete phrases. `\bthis PR\b` must match "this PR adds" without matching "this project", "this process", or "this provider".
- A zero-hit pattern proves nothing until it matches a known positive, and a noisy pattern proves nothing until it rejects a near-miss negative. Calibrate both before trusting a corpus result.
- Target authoring-language probes at the opposite-language surface: search Chinese residue in otherwise-English Markdown and code comments/JSDoc, and search Chinese change narration within `*.zh.md`. A generic ASCII search for English residue in Chinese prose is too noisy around code and identifiers; compare the prose additions against their counterpart instead.

## English battery

```sh
rg -n --hidden '\(decision \d|\(audit [A-Z]\d|design §|plan §|design ledger|\(B ruling|\bP-I\b|\bW\d\b|\bT\d\b' ...
rg -n --hidden -i '\bthis PR\b|\bthis branch\b|\bthis stack\b|\blater PRs?\b|\bprevious commits?\b|\bthis commit\b' ...
rg -n --hidden -i '\bused to\b|\bno longer\b|\bpreviously\b|\bthe old\b|\bwas renamed\b|\bwas moved\b' ...
rg -n --hidden -i '\bv1\b|this cut|\bcut \d|\btoday\b|\bfor now\b|roadmap' ...
rg -n --hidden -i 'rejected in review|review round|reviewer|as of v\d' ...
rg -n --hidden -i 'probably |should be enough|should suffice|it simply|is safe —|is safe --' ...
rg -n --hidden '§\d' ...
```

## Chinese batteries

```sh
# Change or review narration in translated counterparts. The PCRE escapes keep
# the historical Han probes exact while keeping this source file ASCII-only.
rg -n --pcre2 --hidden '\x{8BC4}\x{5BA1}|\x{4E0A}\x{4E00}?\x{8F6E}|\x{65E7}\x{7248}|\x{8001}\x{7684}|\x{4E0D}\x{518D}|\x{4EE5}\x{524D}|\x{672C}\x{7248}|\x{9057}\x{7559}' --glob '*.zh.md' ...

# Authoring-language slips in English Markdown. The same escaped literals
# preserve the legacy detector without embedding Han characters in this skill.
rg -n --pcre2 --hidden '\x{8BBE}\x{8BA1}\x{7A3F}|\x{8BC4}\x{5BA1}|\x{4E0A}\x{4E00}?\x{8F6E}|\x{65E7}\x{7248}|\x{8001}\x{7684}|\x{4E0D}\x{518D}|\x{4EE5}\x{524D}|\x{672C}\x{7248}|\x{9057}\x{7559}|\x{79C1}\x{6709}|(^|[^a-zA-Z])\x{7AEF}([^a-zA-Z]|$)' --glob '*.md' --glob '!*.zh.md' ...

# Chinese authoring-language slips in English code comments and JSDoc.
rg -n --pcre2 --hidden '(^[[:space:]]*(//|/\*|\*)|//|/\*)[^\r\n]*(\x{8BBE}\x{8BA1}\x{7A3F}|\x{8BC4}\x{5BA1}|\x{4E0A}\x{4E00}?\x{8F6E}|\x{65E7}\x{7248}|\x{8001}\x{7684}|\x{4E0D}\x{518D}|\x{4EE5}\x{524D}|\x{672C}\x{7248}|\x{9057}\x{7559}|\x{79C1}\x{6709}|\x{7AEF})' --glob '*.{ts,tsx,js,jsx,mjs,cjs,css}' ...
rg -n --pcre2 --hidden '#[^\r\n]*(\x{8BBE}\x{8BA1}\x{7A3F}|\x{8BC4}\x{5BA1}|\x{4E0A}\x{4E00}?\x{8F6E}|\x{65E7}\x{7248}|\x{8001}\x{7684}|\x{4E0D}\x{518D}|\x{4EE5}\x{524D}|\x{672C}\x{7248}|\x{9057}\x{7559}|\x{79C1}\x{6709}|\x{7AEF})' --glob '*.py' ...
```

## Known false-positive families

Judged and kept during the purge; expect them again:

- **Instrumental "used to"** — "the key used to sign requests" is instrumental, not temporal. The temporal form has a subject state before it ("colors used to come from…").
- **Runtime old/new** — "the old connection drains before the new one accepts" names live objects during handover, not repo states.
- **"This PR" in process docs** — documentation *about* PR workflow ("the PR body should…", templates, this repo's process notes) legitimately says "PR"; the ban is on a doc adopting one PR's vantage about the code.
- **`v1` as protocol or path segment** — `/v1/chat` endpoints and wire-format names are identifiers, not version stamps.
- **`§N` with a committed owner** — external standards (RFC 9110 §10.1.5) and committed docs that own their §-numbering stay citable by section.
- **Contrastive "actually" and noun "wait"** — ordinary English, not hedging; no committed line probes them, so they surface only when you extend the battery with broader hedging patterns.
- **Runtime "today" and recorded timestamps** — prompts or tests that ask for the current date use natural time, not a repository version stamp; recorded CLI output keeps its voice. Wording that reaches a model or user still follows the behavior-evidence rule before any edit.
- **A translated rendering of "this release"** — legitimate in versioned-artifact contexts; the banned indexical is the bare stamp that mirrors "this cut".
- **Alternatives-considered sections** — "rejected" inside an Agent Note's genre slot is the sanctioned home, not review choreography.
