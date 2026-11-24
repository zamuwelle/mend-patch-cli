// mend applies all four edit formats in SPEC.md with Node 22's standard library.
// Parsing and matching finish against an in-memory tree before any file is written.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function diskStat(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function safe(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  const segments = p.split('/');
  if (segments.some(s => !s || s === '.' || s === '..')) return false;
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    if (diskStat(prefix)?.isSymbolicLink()) return false;
  }
  return true;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  requireVacant(path: string): void {
    if (this.get(path) !== null || diskStat(path)?.isDirectory()) throw new Fail('exists', path);
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
      if (this.get(parent) !== null) throw new Fail('exists', path);
    }
    for (const [existing, content] of this.now) {
      if (content !== null && existing.startsWith(path + '/')) throw new Fail('exists', path);
    }
  }
}

type Edit = (tree: Tree) => void;

function fileLines(text: string) {
  const first = text.indexOf('\n');
  const br = first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text ? text.split(br) : [];
  if (final) lines.pop();
  return { lines, br, final };
}

function writeLines(lines: string[], br = '\n', final = true): string {
  return lines.length ? lines.join(br) + (final ? br : '') : '';
}

function occurrences(file: string[], old: string[], strict: boolean, start = 0, eof = false) {
  const transforms = [(s: string) => s, (s: string) => s.replace(/[ \t]+$/, ''), (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, '')];
  for (let tier = 0; tier < (strict ? 1 : transforms.length); tier++) {
    const normalize = transforms[tier]!;
    const needle = old.map(normalize);
    const positions: number[] = [];
    const last = file.length - old.length;
    for (let at = eof ? Math.max(last, start) : start; at <= last; at++) {
      if (needle.every((line, i) => line === normalize(file[at + i]!))) positions.push(at);
    }
    if (positions.length) return { tier, positions };
  }
  return { tier: 0, positions: [] };
}

type NewLine = { text: string; context?: number; noFinal?: boolean };

function replacement(file: string[], at: number, old: string[], next: NewLine[], tier: number) {
  const leading = (s: string) => /^[ \t]*/.exec(s)![0];
  const originalIndent = leading(file[at] ?? '');
  const patchIndent = leading(old[0] ?? '');
  return next.map(({ text, context }) => {
    if (context !== undefined) return file[at + context]!;
    if (tier === 2 && !blank(text) && text.startsWith(patchIndent)) return originalIndent + text.slice(patchIndent.length);
    return text;
  });
}

function parseFault(at: number): never {
  throw new Exit2(`error: parse ${at + 1}`);
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let priorPath: string | undefined;
  let priorEnd = -1;
  for (let start = 0; start < lines.length; start++) {
    if (lines[start]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path = priorPath;
    for (let i = start - 1; i > priorEnd; i--) {
      const candidate = lines[i]!.trim();
      if (!candidate || candidate.startsWith('```')) continue;
      path = candidate;
      break;
    }
    if (path === undefined) parseFault(start);
    const divider = lines.findIndex((line, i) => i > start && line.trimEnd() === '=======');
    const end = lines.findIndex((line, i) => i > divider && line.trimEnd() === '>>>>>>> REPLACE');
    if (divider < 0 || end < 0) parseFault(start);
    const old = lines.slice(start + 1, divider);
    const next = lines.slice(divider + 1, end).map(text => ({ text }));
    const p = path;
    edits.push(tree => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (!old.length) {
        tree.requireVacant(p);
        tree.now.set(p, writeLines(next.map(line => line.text)));
        return;
      }
      if (before === null) throw new Fail('missing', p);
      const { lines: file, br, final } = fileLines(before);
      const { tier, positions } = occurrences(file, old, strict);
      if (positions.length !== 1) throw new Fail(positions.length ? 'ambiguous' : 'no-match', p);
      const at = positions[0]!;
      file.splice(at, old.length, ...replacement(file, at, old, next, tier));
      tree.now.set(p, writeLines(file, br, final));
    });
    priorPath = path;
    priorEnd = end;
    start = end;
  }
  return edits;
}

type Chunk = { old: string[]; next: NewLine[]; added: NewLine[] };

function chunkFrom(body: string[]): Chunk {
  const old: string[] = [];
  const next: NewLine[] = [];
  const added: NewLine[] = [];
  let previous: NewLine | undefined;
  for (const line of body) {
    const prefix = line[0] ?? ' ';
    const text = line.slice(1);
    if (prefix === '\\') {
      if (previous !== undefined) previous.noFinal = true;
      continue;
    }
    previous = undefined;
    if (prefix === '+') {
      previous = { text };
      next.push(previous);
      added.push(previous);
    } else {
      if (prefix === ' ') {
        previous = { text, context: old.length };
        next.push(previous);
      }
      old.push(text);
    }
  }
  return { old, next, added };
}

type UnifiedSection = {
  header?: [string | null, string | null];
  git?: [string, string];
  rename?: [string | undefined, string | undefined];
  create?: boolean;
  delete?: boolean;
  hunks: (Chunk & { line: number })[];
};

function diffPath(raw: string): string {
  return raw.split('\t', 1)[0]!.trim().replace(/^[ab]\//, '');
}

function headerPath(raw: string): string | null {
  const filename = raw.split('\t', 1)[0]!.trim();
  return filename === '/dev/null' ? null : diffPath(filename);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | undefined;
  const opens = (i: number) => lines[i]?.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ');
  const begin = () => {
    const next = { hunks: [] } satisfies UnifiedSection;
    sections.push(next);
    return next as UnifiedSection;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const git = /^diff --git (a\/.+?) (b\/.+)$/.exec(line);
      if (!git) parseFault(i);
      section = begin();
      section.git = [diffPath(git[1]!), diffPath(git[2]!)];
    } else if (opens(i)) {
      if (!section || section.header || section.hunks.length) section = begin();
      section.header = [headerPath(line.slice(4)), headerPath(lines[++i]!.slice(4))];
    } else if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@(?:.*)$/.exec(line);
      if (!match || !section) parseFault(i);
      const body: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (opens(i + 1) || (next && !' -+\\'.includes(next[0]!))) break;
        body.push(next);
        i++;
      }
      while (body.at(-1) === '') body.pop();
      section.hunks.push({ ...chunkFrom(body), line: Number(match[1]) });
    } else if (section && !section.hunks.length) {
      if (line.startsWith('--- ')) parseFault(i + 1);
      if (line.startsWith('rename from ')) (section.rename ??= [undefined, undefined])[0] = line.slice(12).trim();
      if (line.startsWith('rename to ')) (section.rename ??= [undefined, undefined])[1] = line.slice(10).trim();
      if (line.startsWith('new file mode')) section.create = true;
      if (line.startsWith('deleted file mode')) section.delete = true;
    }
  }
  return sections.map(s => tree => {
    const from = s.header ? s.header[0] : s.rename?.[0] ?? s.git?.[0] ?? '';
    const to = s.header ? s.header[1] : s.rename?.[1] ?? s.git?.[1] ?? '';
    const create = s.create || from === null;
    const remove = s.delete || to === null;
    for (const path of [from, to]) {
      if (path !== null && !safe(path)) throw new Fail('unsafe', path);
    }
    if (create) {
      if (to === null) throw new Fail('unsafe', '/dev/null');
      tree.requireVacant(to);
      const added = s.hunks.flatMap(hunk => hunk.added);
      tree.now.set(to, writeLines(added.map(line => line.text), '\n', !added.at(-1)?.noFinal));
      return;
    }
    if (from === null) throw new Fail('unsafe', '/dev/null');
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (remove || to === null) {
      tree.now.set(from, null);
      return;
    }
    const moving = from !== to;
    if (moving) tree.requireVacant(to);
    const { lines: file, br, final } = fileLines(before);
    let ends = final;
    let delta = 0;
    for (const hunk of s.hunks) {
      const { old, next } = hunk;
      const wanted = hunk.line + delta;
      let at = Math.max(0, Math.min(wanted, file.length));
      let tier = 0;
      if (old.length) {
        const found = occurrences(file, old, strict);
        if (!found.positions.length) throw new Fail('no-match', from);
        tier = found.tier;
        const target = wanted - 1;
        at = found.positions.reduce((best, pos) => Math.abs(pos - target) < Math.abs(best - target) ? pos : best);
      }
      if (at + old.length === file.length) ends = !next.at(-1)?.noFinal;
      file.splice(at, old.length, ...replacement(file, at, old, next, tier));
      delta += next.length - old.length;
    }
    tree.now.set(to, writeLines(file, br, ends));
    if (moving) {
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    }
  });
}

type V4Chunk = Chunk & { anchor: string; eof: boolean };

function v4Edits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex(line => !blank(line));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') parseFault(Math.max(first, 0));
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') parseFault(lines.length);

  const header = /^\*\*\* (Add|Delete|Update) File: (.*)$/;
  const edits: Edit[] = [];
  let start = first + 1;
  while (start < last) {
    if (blank(lines[start]!)) {
      start++;
      continue;
    }
    const match = header.exec(lines[start]!);
    if (!match) parseFault(start);
    const [, kind, raw] = match;
    const path = raw!.trim();
    let end = start + 1;
    while (end < last && !header.test(lines[end]!)) end++;
    let stop = end;
    while (stop > start + 1 && blank(lines[stop - 1]!)) stop--;
    let i = start + 1;
    const chunks: V4Chunk[] = [];
    const add: string[] = [];
    let to: string | undefined;
    if (kind === 'Add') {
      for (; i < stop; i++) {
        const line = lines[i]!;
        if (line && !line.startsWith('+')) parseFault(i);
        add.push(line.slice(1));
      }
    } else if (kind === 'Delete') {
      if (i < stop) parseFault(i);
    } else {
      if (lines[i]?.startsWith('*** Move to: ') && i < stop) to = lines[i++]!.slice(13).trim();
      while (i < stop) {
        let anchor = '';
        if (lines[i]!.startsWith('@@')) anchor = lines[i++]!.slice(2).trim();
        else if (chunks.length || (lines[i] && !' -+'.includes(lines[i]![0]!))) parseFault(i);
        const body: string[] = [];
        while (i < stop) {
          const line = lines[i]!;
          if (line !== '' && !' -+'.includes(line[0]!)) break;
          body.push(line);
          i++;
        }
        const eof = i < stop && lines[i] === '*** End of File';
        if (eof) i++;
        if (!body.length && !eof && i < stop && !lines[i]!.startsWith('@@')) parseFault(i);
        chunks.push({ ...chunkFrom(body), anchor, eof });
      }
      if (!chunks.length && to === undefined) parseFault(start);
    }

    edits.push(tree => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (to !== undefined && !safe(to)) throw new Fail('unsafe', to);
      const before = tree.get(path);
      if (kind === 'Add') {
        tree.requireVacant(path);
        tree.now.set(path, writeLines(add));
        return;
      }
      if (before === null) throw new Fail('missing', path);
      if (kind === 'Delete') {
        tree.now.set(path, null);
        return;
      }
      if (to !== undefined) tree.requireVacant(to);
      const { lines: file, br, final } = fileLines(before);
      let cursor = 0;
      for (const { old, next, anchor, eof } of chunks) {
        if (anchor) {
          const match = occurrences(file, [anchor], strict, cursor).positions[0];
          if (match === undefined) throw new Fail('no-match', path);
          cursor = match + 1;
        }
        let at = eof ? file.length : cursor;
        let tier = 0;
        if (old.length) {
          const found = occurrences(file, old, strict, cursor, eof);
          const match = found.positions[0];
          if (match === undefined) throw new Fail('no-match', path);
          at = match;
          tier = found.tier;
        }
        file.splice(at, old.length, ...replacement(file, at, old, next, tier));
        cursor = at + next.length;
      }
      tree.now.set(to ?? path, writeLines(file, br, final));
      if (to !== undefined) {
        tree.now.set(path, null);
        tree.moves.push([path, to]);
      }
    });
    start = end;
  }
  return edits;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      tree.requireVacant(p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'search-replace' ? searchEdits(lines, strict) :
      kind === 'unified' ? unifiedEdits(lines, strict) : v4Edits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const [from, to] of tree.moves) {
    if (rows.get(from) !== `D ${from}` || rows.get(to) !== `A ${to}`) continue;
    rows.delete(from);
    rows.set(to, `R ${from} -> ${to}`);
  }
  return { code: 0, out: [...rows.values(), `ok: ${rows.size} ${rows.size === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
