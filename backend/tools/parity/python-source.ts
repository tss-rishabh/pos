/**
 * Static reading of pinned legacy Python source as text. Nothing is executed or
 * imported; this only recovers statement boundaries, top-level definitions,
 * imports and string constants that the parity tools previously read through
 * Python's `ast` module.
 */

interface LineInfo {
  /** The line begins a new logical statement (not inside a string, bracket or continuation). */
  statementStart: boolean;
  /** Leading whitespace width at the start of the physical line. */
  indent: number;
  /** The line contributes code or string content (not blank and not comment-only). */
  content: boolean;
}

export interface StringToken {
  line: number;
  prefix: string;
  body: string;
  /** Index just after the closing quote. */
  end: number;
  start: number;
}

const prefixPattern = /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/;

/** Single pass over the text that classifies every physical line and collects string tokens. */
export function scanPython(text: string) {
  const lines = text.split('\n'),
    starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const info: LineInfo[] = lines.map((line) => ({
    statementStart: false,
    indent: line.length - line.trimStart().length,
    content: false,
  }));
  const strings: StringToken[] = [];
  let depth = 0,
    continuation = false,
    index = 0,
    lineNumber = 0;
  const lineOf = (position: number) => {
    while (lineNumber + 1 < starts.length && starts[lineNumber + 1]! <= position) lineNumber++;
    return lineNumber;
  };
  let atLineStart = true;
  while (index < text.length) {
    const character = text[index]!;
    const current = lineOf(index);
    if (atLineStart) {
      info[current]!.statementStart = depth === 0 && !continuation;
      continuation = false;
      atLineStart = false;
    }
    if (character === '\n') {
      index++;
      atLineStart = true;
      continue;
    }
    if (character === '#') {
      while (index < text.length && text[index] !== '\n') index++;
      continue;
    }
    if (character === '\\' && text[index + 1] === '\n') {
      continuation = true;
      index += 2;
      atLineStart = true;
      continue;
    }
    if (character === ' ' || character === '\t' || character === '\r' || character === '\f') {
      index++;
      continue;
    }
    info[current]!.content = true;
    if (character === '"' || character === "'") {
      let prefixStart = index;
      while (prefixStart > 0 && /[A-Za-z]/.test(text[prefixStart - 1]!)) prefixStart--;
      const prefix = text.slice(prefixStart, index);
      const validPrefix = prefix === '' || prefixPattern.test(prefix);
      const triple = text.startsWith(character.repeat(3), index),
        quote = triple ? character.repeat(3) : character;
      let cursor = index + quote.length;
      while (cursor < text.length && !text.startsWith(quote, cursor)) {
        if (text[cursor] === '\\') cursor++;
        else if (!triple && text[cursor] === '\n') break;
        cursor++;
      }
      const end = Math.min(text.length, cursor + quote.length);
      for (let line = current; line <= lineOf(Math.max(index, end - 1)); line++)
        info[line]!.content = true;
      if (validPrefix)
        strings.push({
          line: current + 1,
          prefix,
          body: text.slice(index + quote.length, cursor),
          start: prefixStart,
          end,
        });
      index = end;
      continue;
    }
    if ('([{'.includes(character)) depth++;
    else if (')]}'.includes(character)) depth = Math.max(0, depth - 1);
    index++;
  }
  return { text, lines, info, strings, starts };
}

export type PythonScan = ReturnType<typeof scanPython>;

/** Python `end_lineno` of the compound statement opened at 1-based `line`. */
export function definitionEnd(scan: PythonScan, line: number): number {
  const indent = scan.info[line - 1]!.indent;
  let end = line;
  for (let index = line; index < scan.lines.length; index++) {
    const value = scan.info[index]!;
    if (value.statementStart && value.content && value.indent <= indent) break;
    if (value.content) end = index + 1;
  }
  return end;
}

/** First top-level `class`/`def`/`async def` with this name, as Python `module.body` order. */
export function topLevelDefinition(scan: PythonScan, name: string) {
  for (let index = 0; index < scan.lines.length; index++) {
    const value = scan.info[index]!;
    if (!value.statementStart || value.indent !== 0) continue;
    const match = /^(?:class|def|async\s+def)\s+([A-Za-z_]\w*)\b/.exec(scan.lines[index]!);
    if (match?.[1] === name) return { line: index + 1, end: definitionEnd(scan, index + 1) };
  }
  return null;
}

/** A `def`/`async def` statement starting at this exact 1-based line, at any depth. */
export function functionAt(scan: PythonScan, line: number) {
  const value = scan.info[line - 1];
  if (!value?.statementStart) return null;
  const match = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(scan.lines[line - 1]!);
  return match ? { name: match[1]!, line, end: definitionEnd(scan, line) } : null;
}

function unescape(body: string, raw: boolean) {
  if (raw) return body;
  return body.replace(
    /\\(\n|\\|'|"|n|t|r|0|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/g,
    (_match, escape: string) => {
      if (escape === '\n') return '';
      if (escape === 'n') return '\n';
      if (escape === 't') return '\t';
      if (escape === 'r') return '\r';
      if (escape === '0') return '\0';
      if (escape[0] === 'x' || escape[0] === 'u')
        return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
      return escape;
    },
  );
}

/** String `Constant` values Python's `ast.walk` yields for source lines `[from, to]`. */
export function stringConstants(scan: PythonScan, from: number, to: number): string[] {
  const tokens = scan.strings.filter((token) => token.line >= from && token.line <= to);
  const output: string[] = [];
  let group: StringToken[] = [];
  const flush = () => {
    if (!group.length) return;
    if (group.some((token) => /[bB]/.test(token.prefix))) {
      group = [];
      return;
    }
    if (!group.some((token) => /[fF]/.test(token.prefix))) {
      output.push(group.map((token) => unescape(token.body, /[rR]/.test(token.prefix))).join(''));
      group = [];
      return;
    }
    let buffer = '';
    for (const token of group) {
      const raw = /[rR]/.test(token.prefix);
      if (!/[fF]/.test(token.prefix)) {
        buffer += unescape(token.body, raw);
        continue;
      }
      let index = 0;
      while (index < token.body.length) {
        const character = token.body[index]!;
        if (character === '{' && token.body[index + 1] === '{') {
          buffer += '{';
          index += 2;
        } else if (character === '}' && token.body[index + 1] === '}') {
          buffer += '}';
          index += 2;
        } else if (character === '{') {
          if (buffer) output.push(unescape(buffer, raw));
          buffer = '';
          let nesting = 1;
          index++;
          while (index < token.body.length && nesting) {
            if (token.body[index] === '{') nesting++;
            else if (token.body[index] === '}') nesting--;
            index++;
          }
        } else {
          buffer += character;
          index++;
        }
      }
    }
    if (buffer) output.push(buffer);
    group = [];
  };
  for (const token of tokens) {
    const previous = group[group.length - 1];
    if (previous && /^[\s\\]*$/.test(sliceBetween(scan, previous.end, token.start)))
      group.push(token);
    else {
      flush();
      group.push(token);
    }
  }
  flush();
  return output;
}

function sliceBetween(scan: PythonScan, from: number, to: number) {
  return scan.text.slice(from, to).replace(/#[^\n]*/g, '');
}

/** The complete logical statement text that starts at a 1-based line. */
function statementText(scan: PythonScan, line: number) {
  let end = line;
  while (end < scan.lines.length && !scan.info[end]!.statementStart) end++;
  return scan.lines.slice(line - 1, end).join('\n');
}

/** Top-level `import`/`from … import` aliases, as `{local: dotted.target}`. */
export function topLevelImports(scan: PythonScan): Record<string, string> {
  const imports: Record<string, string> = {};
  for (let index = 0; index < scan.lines.length; index++) {
    const value = scan.info[index]!;
    if (!value.statementStart || value.indent !== 0) continue;
    const line = scan.lines[index]!;
    if (!/^(?:from|import)\s/.test(line)) continue;
    const statement = statementText(scan, index + 1)
      .replace(/#[^\n]*/g, '')
      .replace(/\\\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const from = /^from\s+(\.*)([\w.]*)\s+import\s+\(?(.*?)\)?$/.exec(statement);
    if (from) {
      const module = from[2] ?? '';
      for (const item of from[3]!.split(',')) {
        const [name, alias] = item.trim().split(/\s+as\s+/);
        if (!name) continue;
        imports[alias ?? name] = (module ? module + '.' : '') + name;
      }
      continue;
    }
    const plain = /^import\s+(.*)$/.exec(statement);
    if (plain)
      for (const item of plain[1]!.split(',')) {
        const [name, alias] = item.trim().split(/\s+as\s+/);
        if (name) imports[alias ?? name] = name;
      }
  }
  return imports;
}

/** Top-level argument texts of the first `path(`/`re_path(` call beginning on this line. */
export function routeCallArguments(scan: PythonScan, line: number): string[] | null {
  const text = scan.text,
    lineStart = scan.starts[line - 1]!,
    lineText = scan.lines[line - 1]!;
  const pattern = /(?<![\w.])(re_path|path)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(lineText))) {
    const absolute = lineStart + match.index;
    if (scan.strings.some((token) => token.start <= absolute && absolute < token.end)) continue;
    if (lineText.slice(0, match.index).includes('#')) continue;
    const open = lineStart + match.index + match[0].length - 1;
    return splitArguments(text, open);
  }
  return null;
}

function splitArguments(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0,
    current = '',
    index = open + 1;
  while (index < text.length) {
    const character = text[index]!;
    if (character === '#') {
      while (index < text.length && text[index] !== '\n') index++;
      continue;
    }
    if (character === '"' || character === "'") {
      const triple = text.startsWith(character.repeat(3), index),
        quote = triple ? character.repeat(3) : character;
      let cursor = index + quote.length;
      while (cursor < text.length && !text.startsWith(quote, cursor)) {
        if (text[cursor] === '\\') cursor++;
        cursor++;
      }
      current += text.slice(index, cursor + quote.length);
      index = cursor + quote.length;
      continue;
    }
    if ('([{'.includes(character)) depth++;
    if (')]}'.includes(character)) {
      if (depth === 0) {
        if (current.trim()) args.push(current.trim());
        return args;
      }
      depth--;
    }
    if (character === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else current += character;
    index++;
  }
  return args;
}

/** Peel `sync_to_async(…)`/`async_to_sync(…)` and `.as_view(…)`/`.as_asgi(…)` from a view argument. */
export function viewTarget(argument: string): string {
  let view = argument.replace(/\s+/g, '');
  for (;;) {
    const wrapped = /^(?:sync_to_async|async_to_sync)\((.*)\)$/s.exec(view);
    if (!wrapped) break;
    const inner = splitArguments('(' + wrapped[1]! + ')', 0);
    view = (inner[0] ?? '').replace(/\s+/g, '');
  }
  const bound = /^(.*)\.(?:as_view|as_asgi)\((.*)\)$/s.exec(view);
  if (bound && balanced(bound[2]!)) view = bound[1]!;
  return view;
}

function balanced(value: string) {
  let depth = 0;
  for (const character of value) {
    if (character === '(') depth++;
    if (character === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}
