"""Bounded, conservative lexical outlines for languages without AST support.

This is deliberately a heuristic (not an AST or LSP): it recognizes common
source-level declarations while masking ordinary comments and string literals.
It is intended for repository maps, not parsing, indexing, or refactoring.
"""

from __future__ import annotations

import re

SUPPORTED_LANGUAGES = frozenset({
    "go", "rust", "java", "c", "cpp", "csharp", "ruby", "php", "swift", "kotlin",
})
MAX_SOURCE_CHARS = 256 * 1024
MAX_LINE_CHARS = 8192
MAX_SYMBOLS = 512

_IDENTIFIER = r"[A-Za-z_$][\w$]*"
_ANNOTATIONS = r"(?:@[\w.]+(?:\([^()\n]*\))?\s+)*+"  # Java, Kotlin and Swift annotations or attributes
_GENERIC = r"(?:<(?:[^<>\n]|<[^<>\n]*>)*>\s*)?"  # one nested level of type parameters
_TYPE_PATTERNS: dict[str, re.Pattern[str]] = {
    "go": re.compile(r"^\s*type\s+(" + _IDENTIFIER + r")\b"),
    "rust": re.compile(r"^\s*(?:(?:pub(?:\s*\([^)]*\))?|unsafe|extern|async)\s+)*(struct|enum|trait|union|type)\s+(" + _IDENTIFIER + r")\b"),
    "java": re.compile(r"^\s*" + _ANNOTATIONS + r"(?:(?:public|protected|private|abstract|static|final|strictfp|sealed|non-sealed)\s+)*(?:@interface|(class|interface|enum|record))\s+(" + _IDENTIFIER + r")\b"),
    "c": re.compile(r"^\s*(?:(?:typedef|static|extern)\s+)*(struct|union|enum)\s+"),
    "cpp": re.compile(r"^\s*(?:template\s*<.*?>\s*)?(?:(?:typedef|static|extern|final|sealed)\s+)*(class|struct|union|enum)\s+(?:(?:class|struct)\s+)?"),
    "csharp": re.compile(r"^\s*(?:\[[^\]\n]*\]\s*)*(?:(?:public|protected|private|internal|abstract|static|sealed|partial|readonly|ref|new)\s+)*(?:(record)(?:\s+(?:class|struct))?|(class|interface|struct|enum|delegate))\s+(" + _IDENTIFIER + r")\b"),
    "ruby": re.compile(r"^\s*(?:class|module)\s+([A-Z][\w]*(?:::[A-Z][\w]*)*)\b"),
    "php": re.compile(r"^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+(" + _IDENTIFIER + r")\b", re.IGNORECASE),
    "swift": re.compile(r"^\s*" + _ANNOTATIONS + r"(?:(?:public|private|internal|fileprivate|open|final|indirect|actor)\s+)*(class|struct|enum|protocol|actor|typealias)\s+(?!(?:[a-z]+\s+)*(?:func|var|subscript)\b)(" + _IDENTIFIER + r")\b"),
    "kotlin": re.compile(r"^\s*" + _ANNOTATIONS + r"(?:(?:public|private|protected|internal|open|final|abstract|sealed|data|value|expect|actual|annotation|enum|inner|companion)\s+)*(class|interface|object)\s+(" + _IDENTIFIER + r")\b"),
}

_C_TYPE_ATTRIBUTE = re.compile(r"(?:\[\[[^\]]*\]\]|alignas\s*\([^)]*\)|__attribute__\s*\(\([^)]*\)\)|__declspec\s*\([^)]*\))\s*")
_C_TYPE_WORD = re.compile(r"(" + _IDENTIFIER + r")\s*")
# Names start only where identifiers do (\b also holds inside a$b) and dimensions end at the next bracket, keeping matching linear.
_C_TYPE_ALIAS = re.compile(r"^\s*(?:typedef\b[^;()]*?(?<![\w$])(" + _IDENTIFIER + r")\s*(?:\[[^\][]*\]\s*)?;|using\s+(" + _IDENTIFIER + r")\s*=)")
_CSHARP_DELEGATE = re.compile(r"\bdelegate\s+.*?(?<![\w$])(" + _IDENTIFIER + r")\s*(?:<[^<>()]*>\s*)?\(")

_FUNCTION_PATTERNS: dict[str, re.Pattern[str]] = {
    "go": re.compile(r"^\s*func\s+(?:\([^)]*\)\s*)?(" + _IDENTIFIER + r")(?:\s*\[(?:[^\[\]\n]|\[[^\[\]\n]*\])*\])?\s*\("),
    "rust": re.compile(r"^\s*(?:(?:pub(?:\s*\([^)]*\))?|unsafe|async|const|extern)\s+)*fn\s+([A-Za-z_]\w*)\s*(?:<[^;{}]*>)?\s*\("),
    "ruby": re.compile(r"^\s*def\s+(?:(?:self)\.)?([A-Za-z_]\w*[!?=]?)"),
    "php": re.compile(r"^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+(?:&\s*)?([A-Za-z_]\w*)\s*\(", re.IGNORECASE),
    "swift": re.compile(r"^\s*" + _ANNOTATIONS + r"(?:(?:public|private|internal|fileprivate|open|static|class|override|mutating|nonmutating|final|dynamic)\s+)*func\s+([A-Za-z_]\w*)\s*" + _GENERIC + r"\("),
    "kotlin": re.compile(r"^\s*" + _ANNOTATIONS + r"(?:(?:public|private|protected|internal|open|final|abstract|override|inline|infix|operator|suspend|tailrec|external|expect|actual)\s+)*fun\s+" + _GENERIC + r"(?:[\w$.<>?]+\.)?([A-Za-z_]\w*)\s*\("),
}

# The C-family and JVM method rule requires an explicit return type, avoiding
# most ordinary calls; constructors and destructors are matched separately.
# Possessive and atomic groups keep matching linear: a modifier is never retried as a type token.
def _method_pattern(type_parameters: str) -> re.Pattern[str]:
    return re.compile(
        r"^\s*" + _ANNOTATIONS + r"(?:(?:public|protected|private|internal|static|final|abstract|virtual|override|async|extern|unsafe|inline|constexpr|consteval|constinit|friend|explicit|synchronized|native|default|sealed|new|partial|readonly|volatile|register|typedef)\s+)*+"
        r"(?><[^;{}]+>\s+)?"
        r"(?:[\w:$~*&<>.,?\[\]]+\s+)+[*&]*"
        r"((?:[A-Za-z_$][\w$]*::)*(?:~?[A-Za-z_$][\w$]*))\s*" + type_parameters + r"\("
    )


# In C and C++ `name<T>(` is nearly always a call, so only C# declares type parameters after the name.
_METHOD_PATTERN = _method_pattern("")
_GENERIC_METHOD_PATTERN = _method_pattern(_GENERIC)
_CONSTRUCTOR_PATTERN = re.compile(
    r"^\s*" + _ANNOTATIONS + r"(?:(?:public|protected|private|internal|static|inline|async|virtual)\s+|(explicit|constexpr|consteval)\s+)*+"
    r"(~?[A-Za-z_$][\w$]*)\s*\("
)
_STATEMENT_START = re.compile(r"\s*(?:(?:return|throw|yield|case|else|await|co_await|co_return|co_yield|goto|delete)\b|default\s*:)")
_CONTROL_NAMES = {
    "if", "for", "while", "switch", "catch", "return", "throw", "new", "delete",
    "sizeof", "typeof", "instanceof", "do", "else", "case", "assert", "lock",
    "using", "yield", "await", "super", "this", "where", "when", "match",
}
_C_KEYWORDS = {"__asm__", "__attribute__", "__declspec", "alignas", "alignof", "consteval", "constexpr", "decltype", "noexcept", "static_assert"}
_LINE_END = re.compile(r"[\r\n]")
_RUBY_HEREDOC = re.compile(r"<<([~-]?)([\"'`]?)([A-Za-z_]\w*)\2")
_PHP_HEREDOC = re.compile(r"<<<[ \t]*()([\"']?)([A-Za-z_]\w*)\2")
_PHP_OPEN = re.compile(r"<\?(?:php\b|=)?", re.IGNORECASE)
_COMMENT_STYLES = {
    "go": ("//", "/*"), "rust": ("//", "/*"), "java": ("//", "/*"),
    "c": ("//", "/*"), "cpp": ("//", "/*"), "csharp": ("//", "/*"),
    "ruby": ("#",), "php": ("//", "/*", "#"), "swift": ("//", "/*"),
    "kotlin": ("//", "/*"),
}


def split_lines(text: str) -> list[str]:
    """Split on \\n, \\r\\n, and \\r only, as editors, compilers, and Git count lines.

    str.splitlines() also breaks on form feeds and Unicode separators, which
    would shift every later line number.
    """
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return lines[:-1] if lines[-1] == "" else lines


# JavaScript and TypeScript: matched on text whose comments, templates and regular expressions are masked.
JS_IMPORT_KEYWORD = re.compile(r"\b(?:import|export)\b")
# Matched from each keyword with bounded parts that stop at the characters ending them, so cost stays linear.
_JS_BINDINGS = r"(?:\*\s*(?:as\s+[\w$]+\s*)?|\{[^{}'\"`]{0,8192}\}\s*)"
JS_IMPORT_CLAUSE = re.compile(
    r"(?:import(?:\s+|(?=[{*]))(?:(?:type|source|defer)\s+)?(?:(?:[\w$]+\s*,\s*)?(?:" + _JS_BINDINGS + r"|[\w$]+\s+)from\s*)?"
    r"|export(?:\s+|(?=[{*]))(?:type\s+)?" + _JS_BINDINGS + r"from\s*)"
    r"['\"]([^'\"\n]{1,1024})['\"]"
)
_JS_TOKEN = re.compile(r"//[^\r\n]*|/\*[\s\S]*?(?:\*/|\Z)|'(?:[^'\\\r\n]|\\[\s\S])*'?|\"(?:[^\"\\\r\n]|\\[\s\S])*\"?|[`{}/]")
_JS_TEMPLATE_TEXT = re.compile(r"(?:[^`\\$]|\\[\s\S]|\$(?!\{))*")
_JS_REGEX = re.compile(r"/(?![*/])(?:[^/\\\[\r\n]|\\[^\r\n]|\[(?:[^\]\\\r\n]|\\[^\r\n])*\])+/")
_JS_PLAIN_REGEX = re.compile(r"/(?:[^/\\\[\]\r\n]|\\[^\r\n])+/")
_JS_REGEX_KEYWORD = re.compile(r"\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)\Z")
_JS_BLANK = re.compile(r"[^\r\n]")
JS_CALL_IMPORT = re.compile(r"\b(?:require|import)\s*\(\s*['\"]([^'\"]+)['\"]\s*\)")
JS_SYMBOLS = (
    (re.compile(r"^\s*+(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"), "function"),
    (re.compile(r"^\s*+(?:export\s+(?:default\s+)?)?class\s+(?!extends\b|implements\b)([A-Za-z_$][\w$]*)"), "class"),
    (re.compile(r"^\s*+(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)"), "interface"),
    (re.compile(r"^\s*+(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]"), "type"),
    (re.compile(r"^\s*+(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)"), "type"),
    (re.compile(r"^\s*+(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\("), "function"),
    (re.compile(r"^\s*+(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)"), "variable"),
)
JS_EXPORT_DECL = re.compile(
    r"(?:^|(?<=\r))[ \t]*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|(?:abstract\s+)?class|interface|type|(?:const\s+)?enum|const|let|var)\s+(?!extends\b|implements\b)([A-Za-z_$][\w$]*)",
    re.MULTILINE,
)
JS_EXPORT_LIST = re.compile(r"\bexport\s*\{([^{}]*)\}")


def mask_javascript(text: str) -> str:
    """Blank comments, template text and regular expressions, keeping offsets, newlines and quoted strings."""
    out: list[str] = []
    kept = 0
    braces: list[bool] = []  # one per open brace: True when it closes a template's ${...}
    unclosed_line_end = 0  # end of a line on which a regular expression did not close
    i = 0

    def mask(start: int, end: int) -> None:
        nonlocal kept
        out.append(text[kept:start])
        segment = text[start:end]
        out.append(_JS_BLANK.sub(" ", segment) if "\n" in segment or "\r" in segment else " " * len(segment))
        kept = end

    def template_text(start: int) -> int:
        end = _JS_TEMPLATE_TEXT.match(text, start).end()
        mask(start, end)
        if text.startswith("${", end):
            braces.append(True)
            return end + 2
        return end + 1

    while token := _JS_TOKEN.search(text, i):
        value, start, i = token.group(), token.start(), token.end()
        if value[:2] in ("//", "/*"):
            mask(start, i)
        elif value == "`":
            i = template_text(i)
        elif value == "{":
            braces.append(False)
        elif value == "}":
            if braces and braces.pop():
                i = template_text(i)
        elif value == "/":
            before = start - 1
            while before >= 0 and text[before] in " \t\r\n":
                before -= 1
            # A slash after an operator or keyword starts a regular expression; after a value it divides.
            if before < 0 or text[before] in "(,=:[!&|?{};+-*%<>~^" or _JS_REGEX_KEYWORD.search(text, max(0, before - 9), before + 1):
                # Once a literal fails on a line, later slashes there sit in its classes and fail with it from the next bracket, so only bracket-free literals are tried.
                regex = (_JS_REGEX if start >= unclosed_line_end else _JS_PLAIN_REGEX).match(text, start)
                if regex:
                    mask(start + 1, regex.end() - 1)
                    i = regex.end()
                elif start >= unclosed_line_end:
                    line_end = _LINE_END.search(text, start)
                    unclosed_line_end = line_end.start() if line_end else len(text)
    out.append(text[kept:])
    return "".join(out)


def javascript_outline(text: str, max_imports: int) -> tuple[list[dict], list[str], str | None]:
    """Symbols and import specifiers of masked JavaScript/TypeScript, with a note when either is capped."""
    symbols: list[dict] = []
    for line, source in enumerate(split_lines(text), 1):
        if not source.strip():  # masking leaves comment lines blank, and no symbol is blank
            continue
        for expression, kind in JS_SYMBOLS:
            match = expression.search(source)
            if match:
                symbols.append({"name": match.group(1), "kind": kind, "line": line})
                break
        if len(symbols) > MAX_SYMBOLS:
            break
    imports: list[str] = []
    end = 0
    for keyword in JS_IMPORT_KEYWORD.finditer(text):
        clause = JS_IMPORT_CLAUSE.match(text, keyword.start()) if keyword.start() >= end else None
        if clause:
            imports.append(clause.group(1))
            end = clause.end()
    imports += JS_CALL_IMPORT.findall(text)
    notes = [f"JavaScript/TypeScript symbol outline capped at {MAX_SYMBOLS} entries" if len(symbols) > MAX_SYMBOLS else "",
             f"local import links capped at {max_imports} import entries" if len(imports) > max_imports else ""]
    return symbols[:MAX_SYMBOLS], imports[:max_imports], "; ".join(filter(None, notes)) or None


def javascript_exports(text: str) -> list[str]:
    names = JS_EXPORT_DECL.findall(text)
    for group in JS_EXPORT_LIST.findall(text):
        for item in group.split(","):
            exported = item.strip().removeprefix("type ").split(" as ")[-1].strip()  # `a as b` exports b
            if re.fullmatch(r"[A-Za-z_$][\w$]*", exported):
                names.append(exported)
    return list(dict.fromkeys(names))[:MAX_SYMBOLS]


def _heredoc_end(source: str, start: int, terminator: str, indented: bool, php: bool) -> int:
    """Offset just after the line that closes a heredoc whose body starts at ``start``."""
    pos = start
    while pos < len(source):
        found = _LINE_END.search(source, pos)
        end = found.start() if found else len(source)
        line = source[pos:end]
        if php and re.match(r"\s*" + re.escape(terminator) + r"\b", line) or (line.strip() if indented else line) == terminator:
            return end
        pos = end + 1
    return len(source)


def _mask_comments_and_strings(source: str, language: str) -> str:
    """Blank comments/literals while preserving offsets and line numbers."""
    chars = list(source)
    line_comments = _COMMENT_STYLES[language]
    block_comments = "/*" in line_comments
    nested_comments = language in {"rust", "swift", "kotlin"}
    php = language == "php"
    heredocs = language in {"ruby", "php"}
    block_depth = 0
    quote = ""
    triple = False
    raw = False  # the open literal has no backslash escapes
    verbatim = False  # C# @"...", where a doubled quote stays inside
    escaped = False
    ruby_doc = False
    php_html = php  # PHP files start as inline HTML until <?php
    php_attribute_depth = 0
    heredoc: tuple[int, int] | None = None  # (end of opener line, end of body) still to skip
    i = 0
    length = len(source)

    def blank(start: int, end: int) -> None:
        for pos in range(start, end):
            if chars[pos] not in "\r\n":
                chars[pos] = " "

    def line_end_at(pos: int) -> int:
        end = _LINE_END.search(source, pos)
        return end.start() if end else length

    while i < length:
        if heredoc and i > heredoc[0]:
            i = max(i, heredoc[1])
            heredoc = None
            continue

        if php_html:
            opener = _PHP_OPEN.search(source, i)
            blank(i, opener.end() if opener else length)
            if not opener:
                break
            i = opener.end()
            php_html = False
            continue

        if ruby_doc:
            if source[i] in "\r\n":
                i += 1
                continue
            line_end = line_end_at(i)
            if re.match(r"=end(?:\s|$)", source[i:line_end]):
                ruby_doc = False
            blank(i, line_end)
            i = line_end
            continue

        if block_depth:
            if nested_comments and source.startswith("/*", i):
                block_depth += 1
                blank(i, i + 2)
                i += 2
            elif source.startswith("*/", i):
                block_depth -= 1
                blank(i, i + 2)
                i += 2
            else:
                if source[i] not in "\r\n":
                    chars[i] = " "
                i += 1
            continue

        if quote:
            delimiter = quote * (3 if triple else 1)
            if escaped:
                if source[i] not in "\r\n":
                    chars[i] = " "
                escaped = False
                i += 1
            elif source[i] == "\\" and not raw:
                chars[i] = " "
                escaped = True
                i += 1
            elif verbatim and source.startswith('""', i):
                blank(i, i + 2)
                i += 2
            elif source.startswith(delimiter, i):
                blank(i, i + len(delimiter))
                i += len(delimiter)
                quote = ""
                triple = raw = verbatim = False
            else:
                if source[i] not in "\r\n":
                    chars[i] = " "
                i += 1
            continue

        # C++ raw strings, Rust raw/byte-raw strings and Swift #"..."# strings.
        raw_start = None
        raw_end = None
        if language == "cpp" and source.startswith('R"', i):
            open_paren = source.find("(", i + 2, min(length, i + 20))
            if open_paren >= 0:
                delimiter = source[i + 2:open_paren]
                if not any(char.isspace() or char in "()\\" for char in delimiter):
                    raw_start = open_paren + 1
                    raw_end = ")" + delimiter + '"'
        elif language == "rust":
            match = re.match(r"(?:b)?r(#+)?\"", source[i:i + 20])
            if match:
                raw_start = i + match.end()
                raw_end = '"' + (match.group(1) or "")
        elif language == "swift" and source[i] == "#":
            match = re.match(r'(#+)("""|")', source[i:i + 40])
            if match:
                raw_start = i + match.end()
                raw_end = match.group(2) + match.group(1)
        if raw_start is not None and raw_end is not None:
            blank(i, raw_start)
            close = source.find(raw_end, raw_start)
            if close < 0:
                blank(raw_start, length)
                return "".join(chars)
            blank(raw_start, close + len(raw_end))
            i = close + len(raw_end)
            continue

        if language == "ruby" and source[i] == "=" and (i == 0 or source[i - 1] in "\r\n"):
            line_end = line_end_at(i)
            if re.match(r"=begin(?:\s|$)", source[i:line_end]):
                blank(i, line_end)
                ruby_doc = True
                i = line_end
                continue

        if heredocs and source.startswith("<<", i):
            match = (_PHP_HEREDOC if php else _RUBY_HEREDOC).match(source, i)
            # A bare Ruby <<NAME needs a capitalized name, so shifts such as a<<b stay code.
            if match and (php or match.group(1) or match.group(2) or match.group(3)[0].isupper()):
                body = heredoc[1] + 1 if heredoc else line_end_at(i) + 1
                close = _heredoc_end(source, body, match.group(3), php or bool(match.group(1)), php)
                blank(body, close)
                heredoc = (line_end_at(i), close)
                i = match.end()
                continue

        if php and source.startswith("?>", i):
            blank(i, i + 2)
            i += 2
            php_html = True
            php_attribute_depth = 0
            continue
        if block_comments and source.startswith("/*", i):
            block_depth = 1
            blank(i, i + 2)
            i += 2
            continue
        if php and source.startswith("#[", i):
            php_attribute_depth += 1
            blank(i, i + 2)
            i += 2
            continue
        line_marker = next((marker for marker in line_comments if source.startswith(marker, i)), None)
        if line_marker:
            line_end = line_end_at(i)
            if php:
                # A PHP line comment also ends at ?>, which returns to inline HTML.
                close_tag = source.find("?>", i, line_end)
                line_end = close_tag if close_tag >= 0 else line_end
            blank(i, line_end)
            i = line_end
            continue

        if source.startswith('"""', i) and language in {"java", "swift", "kotlin", "csharp"}:
            quote, triple, raw = '"', True, language in {"kotlin", "csharp"}
            blank(i, i + 3)
            i += 3
            continue
        if source[i] in {'"', "'", "`"}:
            char = source[i]
            if char == "`" and language not in {"go", "rust", "cpp", "csharp", "php"}:
                i += 1
                continue
            # Rust and C-family apostrophes are char literals only if closed;
            # Rust lifetimes such as 'a are therefore left as code.
            if char == "'" and language in {"rust", "c", "cpp", "java", "csharp", "kotlin"}:
                end = i + 1
                if end < length and source[end] == "\\":
                    end += 2
                else:
                    end += 1
                if end >= length or source[end] != "'":
                    i += 1
                    continue
            quote = char
            triple = False
            verbatim = char == '"' and language == "csharp" and (source[max(0, i - 2):i].endswith("@") or source[max(0, i - 2):i] == "@$")
            raw = verbatim or char == "`" and language == "go"
            chars[i] = " "
            i += 1
            continue
        if php_attribute_depth:
            # Quotes and comments have already been consumed, so only code brackets affect depth.
            if source[i] == "[":
                php_attribute_depth += 1
            elif source[i] == "]":
                php_attribute_depth -= 1
            blank(i, i + 1)
        i += 1
    return "".join(chars)


def _c_type_declaration(match: re.Match[str], line: str) -> tuple[str, str] | None:
    """Name a C/C++ type after attributes and export macros, accepting only declarations, not variables or returns."""
    pos = match.end()
    while attribute := _C_TYPE_ATTRIBUTE.match(line, pos):
        pos = attribute.end()
    words = []
    while word := _C_TYPE_WORD.match(line, pos):
        words.append(word.group(1))
        pos = word.end()
    if words[-1:] in (["final"], ["sealed"]):
        words.pop()
    rest = line[pos:]
    if not words or not all(word.isupper() for word in words[:-1]):
        return None
    if rest.startswith(("{", ":", "<")) or not rest.strip() or rest.startswith(";") and len(words) == 1:
        return match.group(1), words[-1]
    return None


def _next_code(lines: list[str], index: int) -> str:
    return next((line.strip() for line in lines[index:index + 8] if line.strip()), "")


def _type_declaration(language: str, line: str) -> tuple[str, str] | None:
    match = _TYPE_PATTERNS[language].search(line)
    if language in {"c", "cpp"}:
        declaration = _c_type_declaration(match, line) if match else None
        alias = None if declaration else _C_TYPE_ALIAS.match(line)
        return declaration or (("type", alias.group(1) or alias.group(2)) if alias else None)
    if not match:
        return None
    if language in {"java", "php", "swift", "kotlin", "rust"}:
        kind, name = match.groups()

    elif language == "csharp":
        kind = match.group(1) or match.group(2)
        # A delegate's first identifier is its return type; the name is the one before the parameters.
        delegate = _CSHARP_DELEGATE.match(line, match.start(2)) if kind == "delegate" else None
        name = delegate.group(1) if delegate else match.group(3)
    elif language == "ruby":
        kind_match = re.search(r"\b(class|module)\b", line)
        kind, name = (kind_match.group(1), match.group(1)) if kind_match else ("class", match.group(1))
    else:  # Go
        kind, name = "type", match.group(1)
    if language == "java" and "@interface" in line:
        kind = "interface"
    if language == "kotlin" and kind == "class" and "enum" in line[:match.start(1)].split():
        kind = "enum"
    return kind.lower(), name


def _function_name(language: str, line: str, type_names: set[str]) -> str | None:
    pattern = _FUNCTION_PATTERNS.get(language)
    if pattern:
        match = pattern.search(line)
        if match:
            return match.group(1)
        return None
    if _STATEMENT_START.match(line):
        return None
    match = (_GENERIC_METHOD_PATTERN if language == "csharp" else _METHOD_PATTERN).search(line)
    if match:
        name = match.group(1).split("::")[-1].lstrip("~")
        if name.lower() not in _CONTROL_NAMES and name not in _C_KEYWORDS:
            return name
    constructor = _CONSTRUCTOR_PATTERN.search(line)
    if constructor:
        name = constructor.group(2).lstrip("~")
        # Constructor-only keywords and destructors cannot start a call, so they need no body or known type.
        if name not in _C_KEYWORDS and (constructor.group(1) or constructor.group(2).startswith("~") or ("{" in line or "=>" in line) and name in type_names):
            return name
    return None


def outline(text: str, language: str, max_symbols: int = 512) -> tuple[list[dict], str | None]:
    """Extract likely declarations as ``{"name", "kind", "line"}`` records.

    Line numbers are 1-based. Only ``SUPPORTED_LANGUAGES`` are recognized.
    Input is capped at 256 KiB of characters (not bytes), candidate lines at
    8192 characters, and output at 512 symbols regardless of the requested limit.
    The optional note reports
    unsupported input, skipped oversized lines, or truncation/limits.
    """
    if not isinstance(text, str):
        return [], "Input must be text."
    language = language.lower() if isinstance(language, str) else ""
    if language not in SUPPORTED_LANGUAGES:
        return [], f"Unsupported language: {language or 'unknown'}."
    try:
        requested_limit = max(0, int(max_symbols))
    except (TypeError, ValueError, OverflowError):
        requested_limit = MAX_SYMBOLS
    limit = min(requested_limit, MAX_SYMBOLS)

    notes: list[str] = []
    if len(text) > MAX_SOURCE_CHARS:
        text = text[:MAX_SOURCE_CHARS]
        notes.append(f"Input truncated at {MAX_SOURCE_CHARS} characters.")
    masked = _mask_comments_and_strings(text, language)
    lines = split_lines(masked)
    declarations: list[dict] = []
    type_names: set[str] = set()
    candidates: list[tuple[int, str, str]] = []

    for line_no, line in enumerate(lines, 1):
        if len(line) > MAX_LINE_CHARS:
            notes.append(f"Skipped line {line_no} longer than {MAX_LINE_CHARS} characters.")
            continue
        if not line.strip():
            continue
        type_decl = _type_declaration(language, line)
        # A template parameter alone on its line, such as "class Alloc" before ">", declares no type.
        if type_decl and language == "cpp" and line.rstrip().endswith(type_decl[1]) and _next_code(lines, line_no).startswith((">", ",")):
            continue
        if type_decl:
            kind, name = type_decl
            type_names.add(name)
            candidates.append((line_no, name, kind))
    typed = {(line_no, name) for line_no, name, _ in candidates}
    for line_no, line in enumerate(lines, 1):
        if len(line) > MAX_LINE_CHARS or not line.strip():
            continue
        name = _function_name(language, line, type_names)
        # Records and primary constructors already appear as their type on the same line.
        if name and name.lower() not in _CONTROL_NAMES and (line_no, name) not in typed:
            candidates.append((line_no, name, "function"))

    seen: set[tuple[int, str, str]] = set()
    for line_no, name, kind in sorted(candidates, key=lambda item: (item[0], item[1], item[2])):
        key = (line_no, name, kind)
        if key in seen:
            continue
        seen.add(key)
        if len(declarations) >= limit:
            notes.append(f"Symbol limit reached ({limit}).")
            break
        declarations.append({"name": name, "kind": kind, "line": line_no})

    return declarations, "; ".join(dict.fromkeys(notes)) or None
