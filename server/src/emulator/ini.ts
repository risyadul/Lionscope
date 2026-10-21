/**
 * `key=value` lines as the emulator writes them (discovery files, AVD `config.ini`). LF or CRLF; lines without `=`
 * and `#` comments are skipped; the first `=` splits, so values may contain `=`. Later keys win.
 */
export function parseIni(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const equals = line.indexOf('=');
    if (equals <= 0 || line.trimStart().startsWith('#')) continue;
    values.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
  }
  return values;
}
