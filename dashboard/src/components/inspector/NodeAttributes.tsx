import type { ReactNode } from 'react';
import type { InspectorNode, InspectorSnapshot, PixelRect } from '@lionscope/protocol/wire';
import { CopyButton } from '../stalls/CopyButton.tsx';
import {
  ancestorsOf,
  fallbackHint,
  fallbackLabel,
  idName,
  isZeroRect,
  nodeLabel,
  rectSize,
  shortClass,
  sourceLabel,
  type InspectorIndex,
} from '../../lib/inspector.ts';

function rect(r: PixelRect): string {
  return `[${r[0]}, ${r[1]}][${r[2]}, ${r[3]}]`;
}

const FLAGS: readonly { key: 'enabled' | 'clickable' | 'focused' | 'selected' | 'checked'; label: string }[] =
  [
    { key: 'enabled', label: 'enabled' },
    { key: 'clickable', label: 'clickable' },
    { key: 'focused', label: 'focused' },
    { key: 'selected', label: 'selected' },
    { key: 'checked', label: 'checked' },
  ];

function Row({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="attr-row">
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Unset({ why }: { why?: string }) {
  return (
    <span className="attr-unset" title={why}>
      —
    </span>
  );
}

/** Padding inside margin inside the view: the four sides of each, as numbers. */
function BoxModel({ node }: { node: InspectorNode }) {
  const margin = node.margin ?? [0, 0, 0, 0];
  const padding = node.padding ?? [0, 0, 0, 0];
  const { width, height } = rectSize(node.bounds);
  return (
    <figure className="attr-box" aria-label="Margin and padding in pixels">
      <div className="attr-box-margin">
        <span className="attr-box-name">margin</span>
        <b data-side="t" className="mono">
          {margin[1]}
        </b>
        <b data-side="r" className="mono">
          {margin[2]}
        </b>
        <b data-side="b" className="mono">
          {margin[3]}
        </b>
        <b data-side="l" className="mono">
          {margin[0]}
        </b>
        <div className="attr-box-padding">
          <span className="attr-box-name">padding</span>
          <b data-side="t" className="mono">
            {padding[1]}
          </b>
          <b data-side="r" className="mono">
            {padding[2]}
          </b>
          <b data-side="b" className="mono">
            {padding[3]}
          </b>
          <b data-side="l" className="mono">
            {padding[0]}
          </b>
          <div className="attr-box-content mono">
            {width} × {height}
          </div>
        </div>
      </div>
    </figure>
  );
}

type Props = {
  node: InspectorNode;
  snapshot: InspectorSnapshot;
  index: InspectorIndex;
  onSelect: (id: number) => void;
  /** Who selected it: an AI agent's pick is marked. */
  origin: 'user' | 'agent' | null;
};

/** Everything the snapshot knows about one view; fields the source can't provide say so. */
export function NodeAttributes({ node, snapshot, index, onSelect, origin }: Props) {
  const isSdk = snapshot.source === 'sdk';
  const source = sourceLabel(node);
  const why = isSdk
    ? undefined
    : `Not available from uiautomator${fallbackLabel(snapshot.fallbackReason) ? ` (${fallbackLabel(snapshot.fallbackReason)})` : ''}`;
  const hint = isSdk ? undefined : fallbackHint(snapshot.fallbackReason);
  const size = rectSize(node.bounds);
  const visible = node.visibleBounds;
  const path = ancestorsOf(index, node.id);

  return (
    <div className="attrs">
      <header className="attrs-head">
        <h3 className="attrs-class" title={node.className}>
          {shortClass(node.className)}
          {origin === 'agent' && (
            <span className="attrs-ai" title="An AI agent selected this view, not you">
              AI selected
            </span>
          )}
        </h3>
        {hint !== undefined && <p className="inspect-hint">{hint}</p>}
        {node.resourceId !== null && (
          <p className="attrs-id mono" title={node.resourceId}>
            #{idName(node.resourceId)}
          </p>
        )}
        <p className="attrs-full mono">{node.className}</p>
      </header>

      {path.length > 0 && (
        <nav className="attrs-path" aria-label="Ancestors">
          {path.map((id) => {
            const ancestor = index.byId.get(id);
            return ancestor === undefined ? null : (
              <button key={id} type="button" className="attrs-crumb" onClick={() => onSelect(id)}>
                {nodeLabel(ancestor)}
              </button>
            );
          })}
        </nav>
      )}

      <dl className="attr-grid">
        <Row name="Source">
          {source !== null ? (
            <span className="attr-source">
              <code className="mono">{source}</code>
              <span
                className="attr-hint"
                title="aapt2 records the line where the start tag ends (its “>”), not where “<Tag” begins."
              >
                end of start tag
              </span>
              <CopyButton text={() => source} label="Copy" ariaLabel={`Copy ${source}`} />
            </span>
          ) : (
            <Unset why={isSdk ? 'Built in code, a ViewStub, or inflated off the main thread' : why} />
          )}
        </Row>
        <Row name="Owner">
          {node.fragment !== null || node.activity !== null ? (
            <span className="attr-owner">
              {node.fragment !== null && <span title={node.fragment}>{shortClass(node.fragment)}</span>}
              {node.activity !== null && (
                <span className="attr-owner-activity" title={node.activity}>
                  in {shortClass(node.activity)}
                </span>
              )}
            </span>
          ) : (
            <Unset why={why} />
          )}
        </Row>
        {node.text !== null && node.text !== '' && (
          <Row name="Text">
            <span className="attr-text">{node.text}</span>
          </Row>
        )}
        {node.contentDescription !== null && node.contentDescription !== '' && (
          <Row name="Description">
            <span className="attr-text">{node.contentDescription}</span>
          </Row>
        )}
        <Row name="Bounds">
          <span className="mono">{rect(node.bounds)}</span>
        </Row>
        <Row name="Size">
          <span className="mono">
            {size.width} × {size.height} px
          </span>
        </Row>
        {visible === null ? (
          <Row name="On screen">
            <span className="attr-unset">not visible</span>
          </Row>
        ) : (
          rect(visible) !== rect(node.bounds) && (
            <Row name="Visible">
              <span className="mono">{rect(visible)}</span>
            </Row>
          )
        )}
        <Row name="Visibility">{node.visibility}</Row>
        <Row name="Alpha">
          {node.alpha === null ? <Unset why={why} /> : <span className="mono">{node.alpha}</span>}
        </Row>
        <Row name="Layout">
          {node.layoutWidth !== null && node.layoutHeight !== null ? (
            <span className="mono">
              {node.layoutWidth} × {node.layoutHeight}
            </span>
          ) : (
            <Unset why={why} />
          )}
        </Row>
        <Row name="Flags">
          <span className="attr-flags">
            {FLAGS.map(({ key, label }) => {
              const value = node[key];
              return value === null ? null : (
                <span key={key} className="attr-flag" data-on={value || undefined}>
                  {label}
                </span>
              );
            })}
          </span>
        </Row>
      </dl>

      {isSdk &&
      (node.padding !== null || node.margin !== null) &&
      !(isZeroRect(node.padding) && isZeroRect(node.margin)) ? (
        <BoxModel node={node} />
      ) : (
        isSdk && <p className="attr-note">No padding or margin.</p>
      )}
    </div>
  );
}
