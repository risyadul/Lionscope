/** SQL console grammar shared by the server and dashboard. SQLite validates expressions on device. */
export interface StorageSqlPlan {
  sql: string;
  readOnly: boolean;
  table: string | null;
}

interface Token {
  text: string;
  word: boolean;
  depth: number;
}

export const MAX_STORAGE_SQL_CHARS = 16 * 1024;
export const MAX_STORAGE_QUERY_OFFSET = 1_000_000;

export function planStorageSql(source: string): StorageSqlPlan | string {
  if (!source.trim()) return 'Enter a SQL statement.';
  if (source.length > MAX_STORAGE_SQL_CHARS || source.includes('\0'))
    return 'SQL must contain at most 16,384 characters and no NUL characters.';
  const tokens: Token[] = [];
  let depth = 0;
  let end = source.length;
  let ended = false;
  for (let i = 0; i < source.length;) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (source.startsWith('--', i)) {
      const next = source.indexOf('\n', i + 2);
      i = next < 0 ? source.length : next + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const next = source.indexOf('*/', i + 2);
      if (next < 0) return 'Unterminated SQL comment.';
      i = next + 2;
      continue;
    }
    if (ended) return 'Run one SQL statement at a time.';
    if (c === ';') {
      ended = true;
      end = i;
      i++;
      continue;
    }
    if (c === '?' || c === ':' || c === '@' || c === '$')
      return 'Use literal values; query parameters are not supported.';
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let value = '';
      let closed = false;
      i++;
      while (i < source.length) {
        if (source[i] === close) {
          if (c !== '[' && source[i + 1] === close) {
            value += close;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += source[i++]!;
      }
      if (!closed) return 'Unterminated SQL quote.';
      tokens.push({ text: value, word: false, depth });
      continue;
    }
    if (c === '(') {
      tokens.push({ text: c, word: false, depth });
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth--;
      if (depth < 0) return 'Unbalanced SQL parentheses.';
      tokens.push({ text: c, word: false, depth });
      i++;
      continue;
    }
    const word = /^[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*/.exec(source.slice(i))?.[0];
    tokens.push({ text: word ?? c, word: word !== undefined, depth });
    i += word?.length ?? 1;
  }
  if (depth !== 0) return 'Unbalanced SQL parentheses.';
  const top = tokens.filter((token) => token.depth === 0);
  let root = 0;
  const keyword = (index: number) => (top[index]?.word ? top[index]!.text.toUpperCase() : '');
  if (keyword(0) === 'WITH') {
    root = top.findIndex(
      (token, index) =>
        index > 0 &&
        token.word &&
        ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(token.text.toUpperCase()),
    );
  }
  const op = keyword(root);
  if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(op))
    return 'Supported statements: SELECT, WITH, INSERT, UPDATE and DELETE.';
  if (op === 'SELECT') return { sql: source.slice(0, end).trim(), readOnly: true, table: null };
  if (tokens.some((token) => token.word && ['ROLLBACK', 'RETURNING'].includes(token.text.toUpperCase())))
    return 'ROLLBACK conflict actions and RETURNING are not supported.';
  let target = root + 1;
  if (op !== 'DELETE' && keyword(target) === 'OR') target += 2;
  if (op === 'INSERT') {
    if (keyword(target) !== 'INTO') return 'INSERT must name its target table.';
    target++;
  }
  if (op === 'DELETE') {
    if (keyword(target) !== 'FROM') return 'DELETE must name its target table.';
    target++;
  }
  let table = top[target]?.text;
  if (top[target + 1]?.text === '.') {
    if (table?.toLowerCase() !== 'main') return 'Only the registered main database can be changed.';
    table = top[target + 2]?.text;
  }
  if (!table || ['(', ')', '.', ',', ';'].includes(table)) return 'The statement must name a table.';
  return { sql: source.slice(0, end).trim(), readOnly: false, table };
}
