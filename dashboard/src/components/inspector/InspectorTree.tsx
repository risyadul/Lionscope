import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { InspectorNode } from '@lionscope/protocol/wire';
import type { InspectorSnapshot } from '@lionscope/protocol/wire';
import type { InspectorController } from '../../hooks/useInspector.ts';
import { useHoverId } from './InspectorContext.tsx';
import {
  ancestorsOf,
  defaultExpanded,
  idName,
  isTreeKey,
  shortClass,
  treeMove,
  treeRows,
  windowTitle,
  type InspectorIndex,
} from '../../lib/inspector.ts';

const INDENT_PX = 12;
const TEXT_PREVIEW = 40;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TEXT_PREVIEW ? `${flat.slice(0, TEXT_PREVIEW)}…` : flat;
}

type RowProps = {
  node: InspectorNode;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isMatch: boolean;
  isSelected: boolean;
  isHover: boolean;
  isDim: boolean;
  isTabStop: boolean;
  onHover: (id: number | null) => void;
  onPick: (id: number) => void;
  onToggle: (id: number, open: boolean) => void;
};

/** One row. Memoised on primitives: a 5000-node snapshot re-renders two rows when the hover moves. */
const TreeRow = memo(function TreeRow({
  node,
  depth,
  hasChildren,
  isExpanded,
  isMatch,
  isSelected,
  isHover,
  isDim,
  isTabStop,
  onHover,
  onPick,
  onToggle,
}: RowProps) {
  return (
    <div
      data-node={node.id}
      className="inspect-row"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-selected={isSelected}
      tabIndex={isTabStop ? 0 : -1}
      data-hover={isHover || undefined}
      data-dim={isDim || undefined}
      data-match={isMatch || undefined}
      style={{ paddingLeft: `${8 + depth * INDENT_PX}px` }}
      onPointerEnter={() => onHover(node.id)}
      onClick={() => onPick(node.id)}
    >
      {hasChildren ? (
        <button
          type="button"
          className="inspect-twist"
          tabIndex={-1}
          aria-hidden="true"
          data-open={isExpanded || undefined}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(node.id, !isExpanded);
          }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
            <path d="M2 1l4 3-4 3z" fill="currentColor" />
          </svg>
        </button>
      ) : (
        <span className="inspect-twist" aria-hidden="true" />
      )}
      <span className="inspect-class" title={node.className}>
        {shortClass(node.className)}
      </span>
      {node.resourceId !== null && (
        <span className="inspect-id mono" title={node.resourceId}>
          #{idName(node.resourceId)}
        </span>
      )}
      {node.text !== null && node.text.trim() !== '' && (
        <span className="inspect-text">“{preview(node.text)}”</span>
      )}
      {node.visibility !== 'visible' && <span className="inspect-vis">{node.visibility}</span>}
    </div>
  );
});

type Props = {
  controller: InspectorController;
  snapshot: InspectorSnapshot;
  index: InspectorIndex;
  query: string;
};

/** The collapsible hierarchy: the selection is opened and scrolled into view, arrows move, search filters. */
export const InspectorTree = memo(function InspectorTree({ controller, snapshot, index, query }: Props) {
  const { selectedId } = controller;
  const hoverId = useHoverId(controller);
  const [expanded, setExpanded] = useState(() => new Set(defaultExpanded(index)));
  const [focusId, setFocusId] = useState<number | null>(selectedId);
  const [forSnapshot, setForSnapshot] = useState(snapshot.id);
  const [forSelection, setForSelection] = useState(selectedId);
  const shouldFocus = useRef(false);
  const treeRef = useRef<HTMLDivElement>(null);

  // A new snapshot starts from its default shape; a new selection opens the path to it (adjusting state while rendering).
  if (forSnapshot !== snapshot.id) {
    setForSnapshot(snapshot.id);
    setExpanded(new Set(defaultExpanded(index)));
    setFocusId(selectedId);
  }
  if (forSelection !== selectedId) {
    setForSelection(selectedId);
    if (selectedId !== null) {
      setExpanded((prev) => new Set([...prev, ...ancestorsOf(index, selectedId)]));
      setFocusId(selectedId);
    }
  }

  const rows = useMemo(() => treeRows(snapshot, index, expanded, query), [snapshot, index, expanded, query]);

  useEffect(() => {
    if (selectedId === null) return;
    treeRef.current?.querySelector(`[data-node="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, snapshot.id]);

  useEffect(() => {
    if (!shouldFocus.current || focusId === null) return;
    shouldFocus.current = false;
    treeRef.current?.querySelector<HTMLElement>(`[data-node="${focusId}"]`)?.focus();
  }, [focusId, rows]);

  const toggle = useCallback(
    (id: number, open: boolean) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  const { select } = controller;
  const pick = useCallback(
    (id: number) => {
      setFocusId(id);
      select(id);
    },
    [select],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (isTreeKey(event.key)) {
      const move = treeMove(rows, focusId, event.key);
      if (move === null) return;
      event.preventDefault();
      if (move.toggle) toggle(move.toggle.id, move.toggle.open);
      shouldFocus.current = true;
      setFocusId(move.focus);
    } else if ((event.key === 'Enter' || event.key === ' ') && focusId !== null) {
      event.preventDefault();
      controller.select(focusId);
    }
  };

  if (rows.length === 0) {
    return (
      <p className="inspect-tree-empty">
        {query.trim() === '' ? 'No views in this snapshot.' : 'No view matches.'}
      </p>
    );
  }

  const tabStop =
    focusId !== null && rows.some((r) => r.kind === 'node' && r.node.id === focusId) ? focusId : null;
  const firstNode = rows.find((r) => r.kind === 'node');
  return (
    <div
      ref={treeRef}
      className="inspect-tree"
      role="tree"
      aria-label="View hierarchy"
      onKeyDown={onKeyDown}
      data-stale={controller.isStale || undefined}
      onPointerLeave={() => controller.hover(null)}
    >
      {rows.map((row) => {
        if (row.kind === 'window') {
          return (
            <div key={row.key} className="inspect-window" role="presentation">
              {windowTitle(row.window)}
              <span className="mono">
                {row.window.bounds[2] - row.window.bounds[0]} × {row.window.bounds[3] - row.window.bounds[1]}
              </span>
            </div>
          );
        }
        const { node } = row;
        return (
          <TreeRow
            key={row.key}
            node={node}
            depth={row.depth}
            hasChildren={row.hasChildren}
            isExpanded={row.isExpanded}
            isMatch={row.isMatch}
            isSelected={node.id === selectedId}
            isHover={hoverId === node.id}
            isDim={!index.isShown.get(node.id)}
            isTabStop={tabStop === null ? row === firstNode : node.id === tabStop}
            onHover={controller.hover}
            onPick={pick}
            onToggle={toggle}
          />
        );
      })}
    </div>
  );
});
