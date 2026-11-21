// Fast drop-in for csv-reader 1.0.0, make.fun's own reference CSV reader.
//
// Same answer on every input, read in one left-to-right pass. The trick is
// never to build a field a character at a time: an unquoted field is cut out
// with one slice() at its delimiter, and a quoted field jumps from quote to
// quote with indexOf, so the work per field is proportional to the field,
// not to a per-character loop with a function call behind it. Only the rare
// broken bits (a stray CR, a quote that never closes, junk after a closing
// quote) take the slow road, and they take it in the same order the
// reference meets them, so the errors come out in the same order.
//
// The reading itself, in prose: a U+FEFF at the very start is dropped. A
// record ends at LF or CRLF, and a line left with no characters is no
// record. Outside quotes a CR not followed by LF is dropped (stray_cr). A
// field that opens with a quote runs to the next quote that is not doubled
// ("" inside it is one quote, and each CRLF or lone CR inside it reads as
// LF); what follows its closing quote, up to the next comma or line break,
// is appended as it stands (quote_junk, when the field ends); a quote that
// never closes is a literal character, and the text after it is read again
// as unquoted (unterminated_quote). A quote inside an unquoted field is a
// literal character. Fields stay strings, never trimmed or converted.
// columns is the first record when header is true, else null; rows holds
// the records after it (every record when header is false), each padded
// with empty strings (short_row, with fields: its field count) or cut
// (long_row, with extra: the cut fields) to the first record's width. Each
// error is {code, line, row}, in the order met, a record's short_row or
// long_row when it ends: line the 1-based line its record starts on,
// counting every LF, CRLF and lone CR inside quotes, and row its record's
// index in rows, null for the header.

const COMMA = 44; // ,
const QUOTE = 34; // "
const LF = 10; // \n
const CR = 13; // \r
const BOM = 0xfeff;

// How a field ended: 0 at a comma (the record goes on), 1 at a line break
// or 2 at the end of the text (the record ends).
const AT_COMMA = 0;
const AT_BREAK = 1;
const AT_END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = n > 0 && text.charCodeAt(0) === BOM ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). The error helpers read these as they stand.
  let recordLine = 1;
  let recordRow = null;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads one unquoted field starting at pos, with `first` already in hand
  // ('' for a fresh field, the opening '"' for a quote that never closes,
  // the quoted value for junk after a closing quote). Returns [value,
  // ended, added], where added counts the characters kept after `first`.
  function readUnquoted(first) {
    let value = first;
    let added = 0;
    let start = pos;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === COMMA) {
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        return [value, AT_COMMA, added];
      }
      if (c === LF) {
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        line += 1;
        return [value, AT_BREAK, added];
      }
      if (c === CR) {
        if (text.charCodeAt(pos + 1) === LF) {
          value += text.slice(start, pos);
          added += pos - start;
          pos += 2;
          line += 1;
          return [value, AT_BREAK, added];
        }
        pushError('stray_cr');
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        start = pos;
        continue;
      }
      pos += 1;
    }
    value += text.slice(start, pos);
    added += pos - start;
    return [value, AT_END, added];
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let closedAt = -1;
    let q = pos;
    while (true) {
      q = text.indexOf('"', q);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === QUOTE) {
        q += 2;
        continue;
      }
      closedAt = q;
      break;
    }
    if (closedAt === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      pushError('unterminated_quote');
      return readUnquoted('"');
    }
    // The raw span holds "" pairs and possibly CR or LF: collapse the
    // pairs and read each CRLF or lone CR as one LF, counting the lines.
    const raw = text.slice(pos, closedAt);
    let value = raw;
    if (
      raw.indexOf('"') !== -1 ||
      raw.indexOf('\r') !== -1 ||
      raw.indexOf('\n') !== -1
    ) {
      let count = 0;
      value = raw.replace(/""|\r\n|\r|\n/g, (m) => {
        if (m === '""') return '"';
        count += 1;
        return '\n';
      });
      line += count;
    }
    pos = closedAt + 1;
    if (pos >= n) return [value, AT_END, 0];
    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos += 1;
      return [value, AT_COMMA, 0];
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      return [value, AT_BREAK, 0];
    }
    if (c === CR && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      return [value, AT_BREAK, 0];
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk[2] > 0) pushError('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a record that sits on one line with no quote and no stray
    // CR in it is cut out whole — a line with no '"' holds no quoted field
    // (so no field can run past the line break), and with no '\r' but a
    // trailing one before the LF it holds no stray CR either.
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? n : nl;
    let segEnd = end;
    if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === CR) segEnd = end - 1;
    const seg = text.slice(pos, segEnd);
    let fields;
    let lastQuoted = false;
    if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      fields = seg.split(',');
      pos = nl === -1 ? n : nl + 1;
      line += 1;
    } else {
      fields = [];
      let field;
      do {
        if (text.charCodeAt(pos) === QUOTE) {
          lastQuoted = true;
          field = readQuoted();
        } else {
          lastQuoted = false;
          field = readUnquoted('');
        }
        fields.push(field[0]);
      } while (field[1] === AT_COMMA);
    }

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({
        code: 'short_row',
        line: recordLine,
        row: recordRow,
        fields: fields.length,
      });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({
        code: 'long_row',
        line: recordLine,
        row: recordRow,
        extra: fields.splice(width),
      });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
