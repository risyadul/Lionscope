import type { HttpExchangeDetail } from '@lionscope/protocol/wire';

/** Only complete, unredacted captures can be replayed without silently changing their request data. */
export function curlBlocker(detail: HttpExchangeDetail): string | null {
  if (!detail.originalValues)
    return 'Update the app’s Lionscope SDK and capture again to copy original credentials as cURL.';
  const body = detail.requestBody;
  if (body?.truncated) return 'Copy cURL unavailable: the request body was truncated.';
  if (body && (body.omitted !== null || body.text === null))
    return 'Copy cURL unavailable: the request body was not captured as text.';
  if (body?.text?.includes('\0')) return 'Copy cURL unavailable: the request body contains a NUL byte.';
  if (!detail.requestComplete)
    return 'Copy cURL unavailable: request data was shortened, omitted or transformed during capture.';
  return null;
}

/** POSIX shell quoting: app content is always one literal argument, including quotes and shell expansions. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function requestCurl(detail: HttpExchangeDetail): string {
  const blocker = curlBlocker(detail);
  if (blocker) throw new Error(blocker);
  const args = ['curl --disable --globoff --path-as-is'];
  args.push(detail.method === 'HEAD' ? '--head' : `--request ${quote(detail.method)}`);
  args.push(`--url ${quote(detail.url)}`);
  const headers = detail.requestHeaders;
  for (const [name, value] of headers) {
    // cURL supplies framing for the captured UTF-8 body, rather than reusing transport-specific framing.
    if (['content-length', 'transfer-encoding'].includes(name.toLowerCase())) continue;
    // An empty header uses cURL's semicolon syntax; colon syntax would suppress it.
    args.push(`--header ${quote(value === '' ? `${name};` : `${name}: ${value}`)}`);
  }
  if (detail.requestBody !== null) {
    if (!headers.some(([name]) => name.toLowerCase() === 'content-type')) {
      args.push(`--header ${quote(`Content-Type: ${detail.requestBody.contentType ?? ''}`)}`);
    }
    // Unlike --data-binary, --data-raw treats a leading @ as data, never as a local filename.
    args.push(`--data-raw ${quote(detail.requestBody.text ?? '')}`);
  }
  return args.join(' \\\n  ');
}
