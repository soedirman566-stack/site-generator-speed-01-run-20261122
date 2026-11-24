// A fast drop-in reimplementation of makefun-site 1.0.0's build for
// site-generator-speed-01-run-20261122. Written from the dialect's published
// rules (front matter, template language, Markdown subset, slug rule and the
// build report); run(input) returns the same output tree as the reference
// build, path for path and byte for byte.

// ---------------------------------------------------------------- text rules

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Whether the char code is one the HTML escape table rewrites. */
function isEscCode(c) {
  return c === 38 || c === 60 || c === 62 || c === 34 || c === 39;
}

/** `s` with & < > " ' escaped; the input itself when nothing needs escaping. */
function escStr(s) {
  // The first special character, found with native searches.
  let first = -1;
  for (const ch of ['&', '<', '>', '"', "'"]) {
    const j = s.indexOf(ch);
    if (j !== -1 && (first === -1 || j < first)) first = j;
  }
  if (first === -1) return s;
  const parts = [s.slice(0, first)];
  let run = first;
  for (let i = first; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isEscCode(c)) {
      if (run < i) parts.push(s.slice(run, i));
      parts.push(ESC_MAP[s[i]]);
      run = i + 1;
    }
  }
  if (run < s.length) parts.push(s.slice(run));
  return parts.join('');
}

/** Push s[a..b) into `out`, escaped, as as few chunks as the text allows. */
function escRangeInto(out, s, a, b) {
  let run = a;
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (isEscCode(c)) {
      if (run < i) out.push(s.slice(run, i));
      out.push(ESC_MAP[s[i]]);
      run = i + 1;
    }
  }
  if (run < b) out.push(s.slice(run, b));
}

const SLUG_MAX = 64;
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run of
 * characters other than a-z and 0-9 one "-", none at either end, cut to 64
 * characters (a "-" left at the cut dropped), "untitled" when empty.
 */
function slugify(text) {
  let hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  hit = slugifyRaw(text);
  slugCache.set(text, hit);
  return hit;
}

function slugifyRaw(text) {
  // ASCII is unchanged by NFKD and holds no combining marks: a fast path.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) { out += '-'; gap = false; }
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) { out += '-'; gap = false; }
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against the `taken` set, and added to it. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  let hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const [y, m, d] = date.split('-');
  hit = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  dateCache.set(date, hit);
  return hit;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A front-matter string value: quoted with \" and \\ escapes, or bare. */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's parsed value, or the reason it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body } or { error }. Lines are
 * scanned by offset so the body is never split and rejoined.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  // Walk the lines after the opener, collecting them until the closing ---.
  const fmLines = [];
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let closeEnd = -1; // offset just past the closing line's "\n" (or text end)
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    if (line === '---') {
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

/** Whether the line is only spaces and tabs. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The fence language when `line` opens a fence, else null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const sep = line.charCodeAt(n);
  if (sep !== 32 && sep !== 9) return null;
  let i = n;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let end = line.length;
  while (end > i && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  const text = line.slice(i, end);
  return text === '' ? null : { depth: n, text };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isBreak(line) {
  if (!(line.startsWith('---') || line.startsWith('***'))) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text when `line` opens one, else null. */
function bulletText(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item { num, text } when `line` opens one, else null. */
function orderedText(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinuation(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  const c = line.charCodeAt(i);
  // \S in the reference: anything but a JavaScript whitespace character.
  return !(c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 ||
    c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff);
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isBreak(line);
}

// The characters a backslash escapes, as a table over char codes.
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;

function isEscapable(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 && ESCAPABLE[c] === 1;
}

/** The first index in s[from..hi) holding `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j <= hi - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in s[from..hi) (one not beside another *), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < hi && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// The characters that open an inline construct: \ ` * [
// Its lastIndex is set immediately before every exec and the result read at
// once, so the recursion in inlineRange cannot disturb it.
const INLINE_SPECIAL = /[\\`*[]/g;

/**
 * s[lo..hi) rendered inline into `out` (an array of chunks). `env.link(target)`
 * resolves a link's href. Mirrors the reference inline rules exactly; plain
 * text accumulates into runs so escaping is done a run at a time.
 */
function inlineRange(s, lo, hi, env, out) {
  let i = lo;
  let run = lo;
  while (i < hi) {
    const code = s.charCodeAt(i);
    if (code !== 92 && code !== 96 && code !== 42 && code !== 91) {
      // Plain text: jump to the next character that can open a construct.
      INLINE_SPECIAL.lastIndex = i + 1;
      const m = INLINE_SPECIAL.exec(s);
      i = m === null || m.index >= hi ? hi : m.index;
      continue;
    }
    if (code === 92) { // backslash
      if (i + 1 < hi && isEscapable(s[i + 1])) {
        escRangeInto(out, s, run, i);
        const e = s[i + 1];
        out.push(e === '>' ? '&gt;' : e);
        i += 2;
        run = i;
      } else i++;
      continue;
    }
    if (code === 96) { // backtick
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        escRangeInto(out, s, run, i);
        out.push('<code>');
        escRangeInto(out, s, i + 1, j);
        out.push('</code>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (code === 42) { // *
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          escRangeInto(out, s, run, i);
          out.push('<strong>');
          inlineRange(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1, hi);
        if (j > i + 1) {
          escRangeInto(out, s, run, i);
          out.push('<em>');
          inlineRange(s, i + 1, j, env, out);
          out.push('</em>');
          i = j + 1;
          run = i;
        } else i++;
      }
      continue;
    }
    if (code === 91) { // [
      const k = findUnescaped(s, ']', i + 1, hi);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 || m >= hi ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        escRangeInto(out, s, run, i);
        out.push('<a href="');
        out.push(escStr(env.link(target)));
        out.push('">');
        inlineRange(s, i + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
        run = i;
      } else i++;
      continue;
    }
    i++;
  }
  escRangeInto(out, s, run, hi);
}

/** A whole string rendered inline. */
function inlineText(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/**
 * `src` rendered: { html, toc, excerpt } — each block's HTML followed by "\n",
 * the level 2 and 3 headings, and the first paragraph's inline HTML.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      const body = [];
      while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      out.push('<pre><code');
      if (lang !== '') out.push(` class="language-${escStr(lang)}"`);
      out.push('>');
      for (const l of body) {
        out.push(escStr(l));
        out.push('\n');
      }
      out.push('</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineText(heading.text, env);
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isBreak(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) { // >
      const kept = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i++];
        const stripped = raw.charCodeAt(1) === 32 ? raw.slice(2) : raw.slice(1);
        const t = trimLine(stripped);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push(`<blockquote>\n<p>${inlineText(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = bulletText(line);
    const ordered = bullet === null ? orderedText(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        const text = isOrdered ? orderedText(cur)?.text : bulletText(cur);
        if (text !== undefined && text !== null) {
          items.push([trimLine(text)]);
          i++;
        } else if (isContinuation(cur)) {
          items[items.length - 1].push(trimLine(cur));
          i++;
        } else break;
      }
      if (isOrdered && ordered.num !== 1) out.push(`<ol start="${ordered.num}">\n`);
      else out.push(isOrdered ? '<ol>\n' : '<ul>\n');
      for (const parts of items) {
        out.push('<li>');
        out.push(inlineText(parts.join('\n'), env));
        out.push('</li>\n');
      }
      out.push(isOrdered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineText(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function tplPath(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens; a {% %} tag alone on its line takes the whole line with it. */
function tplTokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPath(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into a tree of nodes; a TemplateError when it does not parse. */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tplTokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: tplPath(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: tplPath(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path`: first name from the nearest scope holding it, then own properties. */
function tplLookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number's own digits, true/false, an array joined by ", ", else "". */
function tplText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tplText).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function tplTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at `path` from segment `start` on: own properties of objects only. */
function tplGet(v, path, start) {
  for (let k = start; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** The value one segment into `v`: its own property, when `v` is an object. */
function tplGet1(v, key) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined;
}

/**
 * A parsed template compiled to a specialised render function
 * (scope, ctx, depth, out, P) that pushes its output chunks into `out`.
 * Paths whose first name a surrounding for binds compile to direct variable
 * reads; the rest resolve through the scope chain at run time. P is the
 * template's table of shared path arrays. ctx carries the helpers
 * (E escape, T text, R truthy, L lookup, G/G1 property walks) and the
 * registry of compiled templates under `tpl`.
 */
function compileTemplate(nodes) {
  const paths = [];
  let counter = 0;

  // The JS expression for a path's value. env is the stack of for frames,
  // innermost last: { scopeVar, names: Map<name, jsVar> }.
  function pathExpr(path, env, scopeVar) {
    for (let f = env.length - 1; f >= 0; f--) {
      const js = env[f].names.get(path[0]);
      if (js !== undefined) {
        if (path.length === 1) return js;
        if (path.length === 2) return `G1(${js},${JSON.stringify(path[1])})`;
        return `G(${js},P[${paths.push(path) - 1}],1)`;
      }
    }
    return `L(${scopeVar},P[${paths.push(path) - 1}])`;
  }

  function gen(list, env, scopeVar) {
    let code = '';
    for (const n of list) {
      switch (n.kind) {
        case 'text':
          code += `out.push(${JSON.stringify(n.text)});`;
          break;
        case 'var':
          code += `out.push(E(T(${pathExpr(n.path, env, scopeVar)})));`;
          break;
        case 'raw':
          code += `out.push(T(${pathExpr(n.path, env, scopeVar)}));`;
          break;
        case 'if': {
          const cond = `R(${pathExpr(n.path, env, scopeVar)})`;
          const thenCode = gen(n.then, env, scopeVar);
          const elseCode = n.else === null ? '' : gen(n.else, env, scopeVar);
          if (!n.not) code += `if (${cond}) {${thenCode}} else {${elseCode}}`;
          else code += `if (${cond}) {${elseCode}} else {${thenCode}}`;
          break;
        }
        case 'for': {
          const id = counter++;
          const xs = `x$${id}`;
          const len = `n$${id}`;
          const sc = `s$${id}`;
          const el = `e$${id}`;
          const lp = `l$${id}`;
          const names = new Map();
          if (n.name !== 'loop') names.set(n.name, el);
          names.set('loop', lp);
          const frame = { scopeVar: sc, names };
          const body = gen(n.body, [...env, frame], sc);
          code += `{const ${xs}=${pathExpr(n.path, env, scopeVar)};` +
            `if (Array.isArray(${xs})) {const ${len}=${xs}.length;` +
            `const ${sc}={vars:null,parent:${scopeVar}};` +
            `for (let k$${id}=0;k$${id}<${len};k$${id}++) {` +
            `const ${el}=${xs}[k$${id}];` +
            `const ${lp}={index:k$${id}+1,first:k$${id}===0,last:k$${id}===${len}-1,length:${len}};` +
            `${sc}.vars={[${JSON.stringify(n.name)}]:${el},loop:${lp}};` +
            `${body}}}}`;
          break;
        }
        case 'include': {
          const id = counter++;
          const key = JSON.stringify(n.name);
          code += `if (depth < ${INCLUDE_DEPTH}) {const f$${id}=tpl[${key}];` +
            `if (f$${id} !== undefined) f$${id}(${scopeVar},ctx,depth+1,out,f$${id}.P);}`;
          break;
        }
      }
    }
    return code;
  }

  const body = gen(nodes, [], 'scope');
  const fn = new Function('scope', 'ctx', 'depth', 'out', 'P',
    'const E=ctx.E,T=ctx.T,R=ctx.R,L=ctx.L,G=ctx.G,G1=ctx.G1,tpl=ctx.tpl;' + body);
  fn.P = paths;
  return fn;
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a char code is JavaScript whitespace (the \s set). */
function isJsSpace(c) {
  return (c >= 9 && c <= 13) || c === 32 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

const WS_TABLE = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_TABLE[c] = 1;
// JavaScript whitespace beyond the common four (tab, LF, CR, space).
const RARE_WS = /[\u000b\u000c\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  if (!RARE_WS.test(text)) {
    // Fast path: the only whitespace present is tab, LF, CR or space.
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 9 || c === 13) inWord = false;
      else if (!inWord) {
        inWord = true;
        count++;
      }
    }
    return count;
  }
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c < 128 ? WS_TABLE[c] === 1 : isJsSpace(c);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** `rel` from directory `dir`, or null when it climbs out of the root. */
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

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
function build(input) {
  const report = [];
  const templates = new Map();
  const compiled = Object.create(null);
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templates.set(name, nodes);
      compiled[name] = compileTemplate(nodes);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources in code-unit order of path; .md files are sources, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the refusal checks, in their order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
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
  sources = kept;

  // Permalinks: each page's slug, made unique in its directory in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, with links resolved against the built pages and static files.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  const linkCache = new Map(); // (dir, target) -> href, or null when broken
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (target.startsWith('/') || target.startsWith('#')) return target;
        if (target.includes(':') && SCHEME.test(target)) return target;
        const key = `${dir}\n${target}`;
        let href = linkCache.get(key);
        if (href === undefined) {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
          else href = null;
          linkCache.set(key, href);
        }
        if (href === null) {
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        return href;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
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
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // The values templates read.
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil((s.wc ??= wordsOf(s.body)) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page, the index pages, the tag pages, then the statics.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { E: escStr, T: tplText, R: tplTruthy, L: tplLookup, G: tplGet, G1: tplGet1, tpl: compiled };
  const render = (name, vars) => {
    const fn = compiled[name];
    if (fn === undefined) return null;
    const out = [];
    fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out, fn.P);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every reported line, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
