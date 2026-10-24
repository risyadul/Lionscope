import { useId, useMemo, type ReactNode } from 'react';
import {
  editableProperties,
  type InspectorNode,
  type InspectorSnapshot,
  type PixelRect,
  type ViewProperty,
} from '@lionscope/protocol/wire';
import type { ViewEdits } from '../../hooks/useViewEdits.ts';
import { CopyButton } from '../stalls/CopyButton.tsx';
import { screenColors } from '../../lib/colorPicker.ts';
import { EDIT_BLOCKED_HINTS } from '../../lib/viewEdits.ts';
import {
  AlphaRow,
  ColorRow,
  EditableBoxModel,
  EnabledSwitch,
  keepFocusNear,
  LayoutSizeRow,
  TypedRow,
  VisibilityRow,
  type EditorProps,
} from './ViewEditors.tsx';
import {
  ancestorsOf,
  fallbackHint,
  compositionNote,
  fallbackLabel,
  idLabel,
  isComposable,
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
  /** 0.8.0. Live edits of the snapshot's views. */
  edits: ViewEdits;
};

/** Why a node offers no editors, null when it does. */
function readOnlyReason(
  node: InspectorNode,
  snapshot: InspectorSnapshot,
  isEditable: boolean,
): string | null {
  if (isEditable) return null;
  if (snapshot.editBlocked !== undefined && node.view !== undefined)
    return EDIT_BLOCKED_HINTS[snapshot.editBlocked];
  if (isComposable(node)) {
    const source = sourceLabel(node);
    return `A composable can’t be edited live: change it in code${source === null ? '' : ` (${source})`}.`;
  }
  if (snapshot.source !== 'sdk') return 'Editing views live needs the Lionscope SDK in the app.';
  return 'Update the app’s Lionscope SDK to 0.9.0 to edit views live.';
}

/** Where a view's or a composable's source line points, and why one may be missing. */
function SourceRow({ node, why }: { node: InspectorNode; why: string | undefined }) {
  const source = sourceLabel(node);
  const composable = isComposable(node);
  if (source === null) {
    const missing = composable
      ? 'The compiler recorded no call site for it'
      : 'Built in code, a ViewStub, or inflated off the main thread';
    return <Unset why={why ?? missing} />;
  }
  return (
    <span className="attr-source">
      <code className="mono">{source}</code>
      {composable ? (
        <span
          className="attr-hint"
          title="The file and line this composable is called from, not where it is defined."
        >
          call site
        </span>
      ) : (
        <span
          className="attr-hint"
          title="aapt2 records the line where the start tag ends (its “>”), not where “<Tag” begins."
        >
          end of start tag
        </span>
      )}
      <CopyButton text={() => source} label="Copy" ariaLabel={`Copy ${source}`} />
    </span>
  );
}

/** Everything the snapshot knows about one view or composable; fields the source can't provide say so. */
export function NodeAttributes({ node, snapshot, index, onSelect, origin, edits }: Props) {
  const isSdk = snapshot.source === 'sdk';
  const composable = isComposable(node);
  const id = idLabel(node);
  const note = compositionNote(node);
  const destination = node.destination ?? null;
  const why = isSdk
    ? undefined
    : `Not available from uiautomator${fallbackLabel(snapshot.fallbackReason) ? ` (${fallbackLabel(snapshot.fallbackReason)})` : ''}`;
  const hint = isSdk ? undefined : fallbackHint(snapshot.fallbackReason);
  const size = rectSize(node.bounds);
  const visible = node.visibleBounds;
  const path = ancestorsOf(index, node.id);
  const editable = new Set(snapshot.editBlocked === undefined ? editableProperties(node) : []);
  const can = (property: ViewProperty) => editable.has(property);
  const editor: EditorProps = { edits, node, resetKey: snapshot.id };
  const colors = useMemo(() => screenColors(snapshot.nodes), [snapshot]);
  const readOnly = readOnlyReason(node, snapshot, editable.size > 0);
  const isEdited = (node.view?.edited?.length ?? 0) > 0;
  const viewStatus = edits.status(node.id);
  const enabledStatus = edits.status(node.id, 'enabled');
  const enabledErrorId = useId();

  return (
    <div className="attrs">
      <header className="attrs-head">
        <h3 className="attrs-class" title={node.className}>
          {shortClass(node.className)}
          {composable && <span className="attrs-kind">Compose</span>}
          {origin === 'agent' && (
            <span className="attrs-ai" title="An AI agent selected this view, not you">
              AI selected
            </span>
          )}
        </h3>
        {hint !== undefined && <p className="inspect-hint">{hint}</p>}
        {id !== null && (
          <p
            className="attrs-id mono"
            title={composable ? `testTag ${node.resourceId}` : (node.resourceId ?? '')}
          >
            #{id}
          </p>
        )}
        <p className="attrs-full mono">{composable ? '@Composable' : node.className}</p>
        {readOnly !== null && <p className="attr-note attr-readonly">{readOnly}</p>}
        {isEdited && (
          <div className="attrs-edited">
            <button
              type="button"
              className="attr-revert"
              disabled={!edits.canEdit || viewStatus.kind === 'applying'}
              aria-busy={viewStatus.kind === 'applying' || undefined}
              onClick={(event) => {
                // The button goes away once reverted: the view's first field takes the focus.
                keepFocusNear(event, '.attrs');
                edits.revert(node.id);
              }}
            >
              Revert this view
            </button>
            {viewStatus.kind === 'error' && (
              <p className="attr-error" role="alert">
                {viewStatus.message}
              </p>
            )}
          </div>
        )}
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
          <SourceRow node={node} why={why} />
        </Row>
        {note !== null && (
          <Row name="Compose">
            <span className="attr-text">{note}</span>
          </Row>
        )}
        <Row name="Owner">
          {destination !== null || node.fragment !== null || node.activity !== null ? (
            <span className="attr-owner">
              {destination !== null && (
                <span className="attr-owner-destination mono" title="Navigation destination">
                  {destination}
                </span>
              )}
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
        {can('text') ? (
          <TypedRow {...editor} property="text" name="Text" />
        ) : node.view?.password === true ? (
          <Row name="Text">
            <span className="attr-unset">A password field: its text is never shown or edited.</span>
          </Row>
        ) : (
          node.text !== null &&
          node.text !== '' && (
            <Row name="Text">
              <span className="attr-text">{node.text}</span>
            </Row>
          )
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
        {can('visibility') ? <VisibilityRow {...editor} /> : <Row name="Visibility">{node.visibility}</Row>}
        {!composable && (
          <>
            {can('alpha') ? (
              <AlphaRow {...editor} />
            ) : (
              <Row name="Alpha">
                {node.alpha === null ? <Unset why={why} /> : <span className="mono">{node.alpha}</span>}
              </Row>
            )}
            {can('layoutWidth') && can('layoutHeight') ? (
              <>
                <LayoutSizeRow {...editor} property="layoutWidth" />
                <LayoutSizeRow {...editor} property="layoutHeight" />
              </>
            ) : (
              <Row name="Layout">
                {node.layoutWidth !== null && node.layoutHeight !== null ? (
                  <span className="mono">
                    {node.layoutWidth} × {node.layoutHeight}
                  </span>
                ) : (
                  <Unset why={why} />
                )}
              </Row>
            )}
          </>
        )}
        {can('translationX') && (
          <TypedRow {...editor} property="translationX" name="Translation X" unit="px" />
        )}
        {can('translationY') && (
          <TypedRow {...editor} property="translationY" name="Translation Y" unit="px" />
        )}
        {can('elevation') && <TypedRow {...editor} property="elevation" name="Elevation" unit="px" />}
        {can('backgroundColor') && (
          <ColorRow {...editor} property="backgroundColor" name="Background" screen={colors} />
        )}
        {can('textSize') && <TypedRow {...editor} property="textSize" name="Text size" unit="sp" />}
        {can('textColor') && <ColorRow {...editor} property="textColor" name="Text color" screen={colors} />}
        <Row name="Flags">
          <span className="attr-flags">
            {can('enabled') && (
              <EnabledSwitch
                {...editor}
                describedBy={enabledStatus.kind === 'error' ? enabledErrorId : undefined}
              />
            )}
            {FLAGS.map(({ key, label }) => {
              const value = node[key];
              if (key === 'enabled' && can('enabled')) return null;
              return value === null ? null : (
                <span key={key} className="attr-flag" data-on={value || undefined}>
                  {label}
                </span>
              );
            })}
          </span>
          {enabledStatus.kind === 'error' && (
            <p id={enabledErrorId} className="attr-error" role="alert">
              {enabledStatus.message}
            </p>
          )}
        </Row>
      </dl>

      {can('paddingLeft') ? (
        <EditableBoxModel {...editor} canEditMargin={can('marginLeft')} />
      ) : composable ? (
        <p className="attr-note">
          Bounds are the content box of what it lays out (inside its padding modifiers).
        </p>
      ) : isSdk &&
        (node.padding !== null || node.margin !== null) &&
        !(isZeroRect(node.padding) && isZeroRect(node.margin)) ? (
        <BoxModel node={node} />
      ) : (
        isSdk && <p className="attr-note">No padding or margin.</p>
      )}
    </div>
  );
}
