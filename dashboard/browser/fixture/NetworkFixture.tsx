import type { HttpExchangeDetail } from '@lionscope/protocol/wire';
import { ExchangeDetail } from '../../src/components/network/ExchangeDetail.tsx';
import '../../src/components/network/network.css';

export function NetworkFixture({ state }: { state: string | null }) {
  const status = state === 'gone' || state === 'loading' ? state : 'ready';
  const detail: HttpExchangeDetail = {
    id: 14,
    ts: 1,
    endTs: 2,
    method: 'POST',
    url: 'https://synthetic.example.test/long/request/path?token=synthetic',
    state: 'complete',
    status: 200,
    headersMs: 1,
    durationMs: 1,
    requestSize: 21,
    responseSize: 0,
    responseType: null,
    mockId: null,
    error: null,
    screen: null,
    protocol: 'h2',
    requestHeaders: [['Authorization', 'Bearer synthetic']],
    responseHeaders: [],
    requestBody: {
      size: 21,
      contentType: 'application/json',
      text: '{"token":"synthetic"}',
      truncated: state === 'truncated',
      omitted: null,
    },
    responseBody: null,
    originalValues: state === 'legacy' ? undefined : true,
    requestComplete: state !== 'truncated',
  };
  return (
    <main className="fixture-network">
      <h1>Synthetic Network request</h1>
      <ExchangeDetail
        exchange={detail}
        detail={{
          detail: state === 'loading' || state === 'gone' ? null : detail,
          status,
        }}
        rule={null}
        now={2}
        onClose={() => location.assign('/')}
        onMockThis={() => location.assign('/?workspace=network')}
        mockBlocker="Synthetic read-only fixture"
      />
    </main>
  );
}
