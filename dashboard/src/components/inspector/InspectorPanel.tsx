import { memo, useState, type ReactNode } from 'react';
import { formatInteger } from '../../lib/format.ts';
import { fallbackHint, fallbackLabel } from '../../lib/inspector.ts';
import { liveEditsLabel } from '../../lib/viewEdits.ts';
import { MAX_INSPECTOR_NODES } from '@lionscope/protocol/wire';
import { useInspectorContext } from './InspectorContext.tsx';
import { InspectorTree } from './InspectorTree.tsx';
import { NodeAttributes } from './NodeAttributes.tsx';
import './inspector.css';

function Empty({
  title,
  children,
  isBusy = false,
}: {
  title: string;
  children?: ReactNode;
  isBusy?: boolean;
}) {
  return (
    <div className="inspect-empty" role="status">
      {isBusy && <span className="banner-spinner" aria-hidden="true" />}
      <p className="inspect-empty-title">{title}</p>
      {children}
    </div>
  );
}

/** The Inspector tab: where the snapshot came from, a searchable hierarchy and the selected view's attributes. */
export const InspectorPanel = memo(function InspectorPanel() {
  const controller = useInspectorContext();
  const [query, setQuery] = useState('');
  if (controller === null) return null;
  const { snapshot, index, selectedId } = controller;

  if (snapshot === null || index === null) {
    if (controller.isCapturing) return <Empty title="Capturing the screen…" isBusy />;
    return (
      <Empty title={controller.failure ?? 'Nothing inspected yet'}>
        <p>
          Press <strong>Inspect</strong> in the device toolbar to freeze the screen, hover to find a view and
          click to see its attributes and where it came from: the XML layout of a view, the Kotlin line that
          calls a composable. Apps with the Lionscope SDK (0.5.2 or newer) give the sources without a session;
          older SDKs need Start.
        </p>
        <div className="inspect-empty-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!controller.canInspect}
            onClick={controller.toggle}
          >
            Inspect the screen
          </button>
        </div>
        {!controller.canInspect && <p className="inspect-empty-hint">Pick a connected device first.</p>}
      </Empty>
    );
  }

  const selected = selectedId === null ? undefined : index.byId.get(selectedId);
  const reason = fallbackLabel(snapshot.fallbackReason);
  const hint = snapshot.source === 'sdk' ? undefined : fallbackHint(snapshot.fallbackReason);
  const { edits } = controller;
  const revertAll = edits.status(null);
  const failure =
    controller.failure ?? (revertAll.kind === 'error' ? revertAll.message : null) ?? edits.notice;
  return (
    <div className="inspector" data-stale={controller.isStale || undefined}>
      <div className="inspect-head">
        <div className="inspect-badges">
          <span className="inspect-badge" data-source={snapshot.source} title={hint}>
            {snapshot.source === 'sdk' ? 'SDK' : reason === null ? 'uiautomator' : `uiautomator — ${reason}`}
          </span>
          {snapshot.captureMs !== null && (
            <span className="inspect-stat mono">{snapshot.captureMs.toFixed(1)} ms</span>
          )}
          <span className="inspect-stat mono">{formatInteger(snapshot.nodes.length)} nodes</span>
          {snapshot.truncated &&
            (snapshot.source === 'sdk' ? (
              <span
                className="inspect-badge"
                data-source="warn"
                title="The rest of the views were dropped, deepest first."
              >
                capped at {formatInteger(MAX_INSPECTOR_NODES)}
              </span>
            ) : (
              <span className="inspect-badge" data-source="warn">
                truncated at {formatInteger(MAX_INSPECTOR_NODES)} nodes
              </span>
            ))}
          {edits.liveEdits > 0 && (
            <span className="inspect-live">
              <span
                className="inspect-badge"
                data-source="edit"
                title="Changed from the Inspector. They last until reverted, the app sets the property again or the view is recreated."
              >
                {liveEditsLabel(edits.liveEdits)}
              </span>
              <button
                type="button"
                className="btn inspect-revert-all"
                disabled={!edits.canEdit}
                aria-busy={revertAll.kind === 'applying' || undefined}
                onClick={() => edits.revert(null)}
              >
                {revertAll.kind === 'applying' ? 'Reverting…' : 'Revert all'}
              </button>
            </span>
          )}
          <button
            type="button"
            className="btn inspect-refresh"
            onClick={controller.refresh}
            disabled={controller.isCapturing || !controller.canInspect}
          >
            {controller.isCapturing ? (controller.isStale ? 'Refreshing…' : 'Capturing…') : 'Refresh'}
          </button>
        </div>
        {hint !== undefined && <p className="inspect-hint">{hint}</p>}
        {failure !== null && (
          <p className="inspect-failure" role="alert">
            {failure}
          </p>
        )}
        <input
          type="search"
          className="inspect-search"
          placeholder="Search class, id or text"
          aria-label="Search the hierarchy"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') {
              event.preventDefault();
              setQuery('');
            }
          }}
        />
      </div>
      <div className="inspect-body">
        <InspectorTree controller={controller} snapshot={snapshot} index={index} query={query} />
        <section className="inspect-attrs" aria-label="Attributes">
          {selected === undefined ? (
            <p className="inspect-attrs-empty">
              {controller.isActive ? 'Click a view on the screen' : 'Pick a view in the tree'} to see its
              attributes.
            </p>
          ) : (
            <NodeAttributes
              // Drafts belong to one view: the same view keeps them across snapshots (its key), another drops them.
              key={selected.view === undefined ? `n${selected.id}` : `v${selected.view.key}`}
              node={selected}
              snapshot={snapshot}
              index={index}
              onSelect={controller.select}
              origin={controller.selectionOrigin}
              edits={edits}
            />
          )}
        </section>
      </div>
    </div>
  );
});
