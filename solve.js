// A faster drop-in for makefun-site 1.0.0.
//
// Same inputs, same output tree, byte for byte; less CPU time. How it gets
// there:
//   - Templates are compiled once to plain functions (new Function) that
//     append to an output array, instead of being walked node by node.
//   - Markdown is lexed and rendered in one fused pass over the body's
//     lines, and inline markup is rendered with batched escaping: runs of
//     plain text are escaped by one regex replace instead of one call per
//     character.
//   - Slugs are cached and take a regex fast path for plain ASCII text.
//   - Front matter is parsed from the same line array the Markdown pass
//     then reads, so a source's text is split into lines exactly once.
//   - Word counting for reading time runs over the lines, never a
//     re-joined body string.
//
// The behaviour follows makefun-site's README: its front matter, template
// dialect, Markdown subset, slug rule and report, with the reference code
// as the arbiter wherever the two could differ.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const RESERVED_DIRS = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;

/** Code-unit order (never the locale's). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `text` with & < > " and ' escaped. Runs with nothing to escape are returned as they are. */
const ESC_TEST = /[&<>"']/;
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// ---------------------------------------------------------------- slugs

const MARK_RE = /\p{M}/gu;
const PLAIN_SLUG_RE = /^[a-z0-9 -]*$/;
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every
 * run of characters other than a-z and 0-9 one "-", none at either end, at
 * most 64 characters (a "-" left at the cut dropped), "untitled" when
 * nothing is left.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (PLAIN_SLUG_RE.test(text)) {
    out = text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  } else {
    out = text
      .normalize('NFKD')
      .replace(MARK_RE, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function keyValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringValue(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    const m = FM_DATE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    if (tags.some((t) => t === '' || !FM_TAG.test(t))) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

/**
 * A source's front matter from its lines: { data, close } with `close` the
 * index of the closing --- line, or { error } with the first refusal.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (m === null) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = keyValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  if (m === null || m[2] === '') return null;
  return { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  const c0 = line.charCodeAt(0);
  if (line === '' || ((c0 === 32 || c0 === 9) && BLANK.test(line))) return true;
  if (c0 === 96 && FENCE_OPEN.test(line)) return true;
  if (c0 === 35 && headingOf(line) !== null) return true;
  if ((c0 === 45 || c0 === 42) && HR.test(line)) return true;
  return false;
}

/** A line as it is rendered: spaces and tabs at either end dropped. Unchanged lines are returned as they are. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline, appended to `out`. Plain runs are pushed as plain
 * slices: every character that needs escaping (& < > " ') breaks the run
 * and is pushed as its entity, so no run is ever escaped by a regex.
 */
function inlineTo(s, env, out) {
  let i = 0;
  let run = 0;
  const n = s.length;
  const flush = (end) => {
    if (end > run) out.push(s.slice(run, end));
  };
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      flush(i);
      out.push(escapeHtml(s[i + 1]));
      i += 2;
      run = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>');
          inlineTo(s.slice(i + 2, j), env, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        out.push('<em>');
        inlineTo(s.slice(i + 1, j), env, out);
        out.push('</em>');
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineTo(s.slice(i + 1, k), env, out);
        out.push('</a>');
        i = m + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      flush(i);
      out.push(ESCAPES[c]);
      i++;
      run = i;
      continue;
    }
    i++;
  }
  flush(n);
}

/**
 * The words of the body's lines: runs of characters other than whitespace.
 * Counted by hand over the lines, one pass, with the same whitespace set
 * the /\S+/ grammar uses (so the count is identical, without a regex
 * call per line).
 */
/** One line's words: runs of characters other than whitespace, with the same whitespace set the /\S+/ grammar uses. */
function lineWords(line) {
  let w = 0;
  let inWord = false;
  for (let j = 0; j < line.length; j++) {
    const c = line.charCodeAt(j);
    const ws =
      c === 32 ||
      c === 9 ||
      c === 10 ||
      c === 11 ||
      c === 12 ||
      c === 13 ||
      c === 160 ||
      c === 5760 ||
      (c >= 8192 && c <= 8202) ||
      c === 8232 ||
      c === 8233 ||
      c === 8239 ||
      c === 8287 ||
      c === 12288 ||
      c === 65279;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      w++;
    }
  }
  return w;
}

/**
 * The body's lines from `start` rendered: its HTML (each block on its own
 * lines, a "\n" after the last), its table of contents (every level 2 and 3
 * heading), its excerpt (the first paragraph's inline HTML, or "") and its
 * word count.
 */
function renderBody(lines, start, env) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let words = 0;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    words += lineWords(line);
    const c0 = line.charCodeAt(0);
    if (line === '' || ((c0 === 32 || c0 === 9) && BLANK.test(line))) {
      i++;
      continue;
    }
    const fence = c0 === 96 ? FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      i++;
      out.push('<pre><code', fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`, '>');
      while (i < n && !(lines[i].charCodeAt(0) === 96 && FENCE_CLOSE.test(lines[i]))) {
        words += lineWords(lines[i]);
        out.push(escapeHtml(lines[i]), '\n');
        i++;
      }
      if (i < n) words += lineWords(lines[i]);
      i++;
      out.push('</code></pre>', '\n');
      continue;
    }
    const heading = c0 === 35 ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      out.push(`<h${heading.depth} id="${id}">`);
      const h0 = out.length;
      inlineTo(heading.text, env, out);
      if (heading.depth === 2 || heading.depth === 3) {
        toc.push({ level: heading.depth, id, html: out.slice(h0).join('') });
      }
      out.push(`</h${heading.depth}>`, '\n');
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {
      out.push('<hr>', '\n');
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [lines[i].replace(/^> ?/, '')];
      i++;
      while (i < n && lines[i].charCodeAt(0) === 62) {
        words += lineWords(lines[i]);
        body.push(lines[i].replace(/^> ?/, ''));
        i++;
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) {
        out.push('<blockquote>\n</blockquote>', '\n');
      } else {
        out.push('<blockquote>\n<p>');
        inlineTo(kept.join('\n'), env, out);
        out.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    const bullet = c0 === 45 || c0 === 42 ? BULLET.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [[trimLine(isOrdered ? ordered[2] : bullet[1])]];
      i++;
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          words += lineWords(lines[i]);
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (
          lines[i].charCodeAt(0) === 32 &&
          lines[i].charCodeAt(1) === 32 &&
          CONTINUED.test(lines[i])
        ) {
          words += lineWords(lines[i]);
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${ordered[1]}">` : `<${tag}>`;
      out.push(open, '\n');
      for (const parts of items) {
        out.push('<li>');
        inlineTo(parts.join('\n'), env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>`, '\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      words += lineWords(lines[i]);
      body.push(trimLine(lines[i++]));
    }
    out.push('<p>');
    const p0 = out.length;
    inlineTo(body.join('\n'), env, out);
    if (excerpt === null) excerpt = out.slice(p0).join('');
    out.push('</p>', '\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

/**
 * `src` parsed into a tree of nodes. Node kinds, by `k`:
 * 0 text {s}, 1 escaped value {p}, 2 raw value {p}, 3 if {not, p, a, b},
 * 4 for {name, p, a}, 5 include {name}. `a` is the then/body array, `b` an
 * if's else array or null.
 */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ kind: 'root', node: null, body: root }];
  const top = () => stack[stack.length - 1];
  let i = 0;
  let textStart = 0;
  const pushText = (end) => {
    if (end > textStart) top().body.push({ k: 0, s: src.slice(textStart, end) });
  };
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) break;
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      i = open + 1;
      continue;
    }
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      pushText(open);
      top().body.push({ k: raw ? 2 : 1, p: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      textStart = i;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    pushText(standalone ? lineStart : open);
    const tag = src.slice(open + 2, close).trim();
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { k: 4, name: m[1], p: pathOf(name, m[2]), a: [] };
      top().body.push(node);
      stack.push({ kind: 'for', node, body: node.a });
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { k: 3, not: m[1] !== undefined, p: pathOf(name, m[2]), a: [], b: null };
      top().body.push(node);
      stack.push({ kind: 'if', node, body: node.a });
    } else if (tag === 'else') {
      const t = top();
      if (t.kind !== 'if' || t.node.b !== null) {
        throw new TemplateError(`template "${name}": an else outside an if`);
      }
      t.node.b = [];
      t.body = t.node.b;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top().kind !== want) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      top().body.push({ k: 5, name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
    textStart = i;
  }
  pushText(src.length);
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  return root;
}

/** The value at `path` in the scope stack (innermost last). */
function lookup(scopes, path) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const vars = scopes[i];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += textOf(v[k]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A template's nodes compiled to a render function
 * (templates, scopes, out, depth, lookup, textOf, truthy, escapeHtml).
 * Loop scopes are pushed and popped, and each for reuses one `loop`
 * object, its fields rewritten per element (rendering is synchronous, so
 * nothing ever reads a stale one).
 */
function compileTemplate(name, src) {
  const nodes = parseTemplate(name, src);
  const lines = [];
  let uid = 0;
  const emit = (list) => {
    for (const n of list) {
      if (n.k === 0) {
        lines.push(`O.push(${JSON.stringify(n.s)});`);
      } else if (n.k === 1) {
        lines.push(`O.push(E(X(L(S,${JSON.stringify(n.p)}))));`);
      } else if (n.k === 2) {
        lines.push(`O.push(X(L(S,${JSON.stringify(n.p)})));`);
      } else if (n.k === 3) {
        lines.push(`if(Y(L(S,${JSON.stringify(n.p)}))!==${n.not}){`);
        emit(n.a);
        lines.push('}');
        if (n.b !== null) {
          lines.push('else{');
          emit(n.b);
          lines.push('}');
        }
      } else if (n.k === 4) {
        const a = `a${uid++}`;
        const nn = `n${uid++}`;
        const lp = `l${uid++}`;
        const it = `i${uid++}`;
        lines.push(
          `{const ${a}=L(S,${JSON.stringify(n.p)});if(Array.isArray(${a})){const ${nn}=${a}.length;const ${lp}={index:0,first:false,last:false,length:${nn}};for(let ${it}=0;${it}<${nn};${it}++){${lp}.index=${it}+1;${lp}.first=${it}===0;${lp}.last=${it}===${nn}-1;S.push({${JSON.stringify(n.name)}:${a}[${it}],loop:${lp}});`,
        );
        emit(n.a);
        lines.push('S.pop();}}}');
      } else {
        const t = `t${uid++}`;
        lines.push(
          `{const ${t}=T.get(${JSON.stringify(n.name)});if(${t}!==undefined&&D<8)${t}(T,S,O,D+1,L,X,Y,E);}`,
        );
      }
    }
  };
  emit(nodes);
  return new Function('T', 'S', 'O', 'D', 'L', 'X', 'Y', 'E', lines.join('\n'));
}

// ---------------------------------------------------------------- the build

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths; line ends made "\n".
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, lines: f.content.replace(/\r\n?/g, '\n').split('\n') });
    } else {
      statics.push(f);
    }
  }

  // 2. Front matter and the refusal checks, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.close + 1;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each page's slug, unique in its directory.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED_DIRS : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) {
          return target;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderBody(s.lines, s.bodyStart, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, named as first met in the posts' order.
  const bySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTagNames(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // 7. Layouts: every page, the index pages and the tag pages.
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(cards.get(s) ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn(templates, [{ site, tags: allTags, recent, ...vars }], out, 0, lookup, textOf, truthy, escapeHtml);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map((p) => cards.get(p)),
      },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(cmp);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
