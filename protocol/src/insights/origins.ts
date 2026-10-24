/**
 * Where main-thread work came from (0.9.0): what the Looper was running when a stall was sampled, classified from
 * the stack (its outermost frames carry the dispatch) and the SDK's runtime facts (`rx`, `coroutine`). Shared by the
 * Stalls tab's Origins breakdown and the agent tools; works for stalls of every SDK version that sends stacks.
 */
import type { StackFrame, StallSample } from '../wire.ts';
import {
  culpritFrame,
  frameLocation,
  frameMethod,
  isGeneratedFrame,
  simpleClassName,
  stallInWindow,
} from './stalls.ts';

/**
 * `rx`: an RxJava task on the main-thread scheduler; `coroutine`: a coroutine resumed on a main dispatcher; `handler`:
 * a posted Runnable or a Handler message; `frame`: a Choreographer frame (layout and draw, animators, Compose);
 * `input`: an input event or the click / long press it posted; `lifecycle`: the framework's ActivityThread messages
 * (activity, service, receiver callbacks); `idle`: an idle handler; `unknown`: no stack, or it was cut before the
 * dispatch.
 */
export type StallOriginKind =
  'rx' | 'coroutine' | 'handler' | 'frame' | 'input' | 'lifecycle' | 'idle' | 'unknown';

export const ORIGIN_KIND_LABELS: Record<StallOriginKind, string> = {
  rx: 'RxJava',
  coroutine: 'Coroutine',
  handler: 'Handler',
  frame: 'Frame',
  input: 'Input',
  lifecycle: 'Lifecycle',
  idle: 'Idle',
  unknown: 'Unknown',
};

export interface StallOrigin {
  kind: StallOriginKind;
  /** Stalls with the same key came from the same place (the Origins breakdown groups by it). */
  key: string;
  /** What ran: `observeOn`, `Dispatchers.Main`, `Handler.post`, `Layout & draw`, `Click`, `Activity lifecycle`. */
  label: string;
  /**
   * Where it came from, when known: the Rx chain's subscribe site, the coroutine's continuation, the posted
   * Runnable, the entry into app code (`HomeViewModel.load (HomeViewModel.kt:40)`, `HomeViewModel$refresh$1`).
   */
  detail: string | null;
  /** The source line `detail` names, when it names one. */
  frame: StackFrame | null;
  /** Class the Looper ran: the posted Runnable, the Handler, the Choreographer callback, the idle handler. */
  dispatched: string | null;
  /** The work's first app frame below the dispatch (the code the message ran first), skipping D8 lambda stubs. */
  entry: StackFrame | null;
  /** rx: the operator whose task ran (`observeOn`, `subscribeOn`, `timer`). */
  operator: string | null;
  /** rx: the chain's final consumer class (SDK's Rx hooks). */
  consumer: string | null;
  /** rx: the stack of the chain's `subscribe` call (SDK's Rx hooks), innermost first; empty when unknown. */
  subscribedAt: StackFrame[];
  /** coroutine: the dispatcher (`Dispatchers.Main`, `AndroidUiDispatcher`). */
  dispatcher: string | null;
  /** coroutine: `name#id` (kotlinx.coroutines debug mode in the app). */
  coroutine: string | null;
}

/**
 * Frames a stall's stack is classified on: `frames`, then the outermost ones the SDK sent apart. Frames may be
 * missing between the two, so nothing is read as the neighbour of a frame across `boundary` (the first outer one).
 */
interface Stack {
  frames: readonly StackFrame[];
  boundary: number;
}

function stackOf(stall: Pick<StallSample, 'frames' | 'outerFrames'>): Stack {
  const outer = stall.outerFrames;
  if (outer === undefined || outer.length === 0) return { frames: stall.frames, boundary: Infinity };
  return { frames: [...stall.frames, ...outer], boundary: stall.frames.length };
}

/** The frame just inside `i` (towards the innermost), unless it lies across the boundary. */
function innerOf(stack: Stack, i: number): StackFrame | undefined {
  return i === stack.boundary ? undefined : stack.frames[i - 1];
}

function is(frame: StackFrame | undefined, className: string, method?: string): boolean {
  return (
    frame !== undefined && frame.className === className && (method === undefined || frame.method === method)
  );
}

/** The SDK's stand-in for its own frames (its Rx wrapper runs between the scheduler and the task). */
function isSdkFrame(frame: StackFrame): boolean {
  return frame.method === '(sdk)' && frame.className === 'io.github.risyadul.lionscope.Lionscope';
}

/** D8 / R8 lambda stubs: `Foo$$ExternalSyntheticLambda3.run`, `Foo.$r8$lambda$…`; the body is the next frame in. */
export function isSyntheticFrame(frame: StackFrame): boolean {
  return (
    frame.file === 'D8$$SyntheticClass' ||
    frame.method.startsWith('$r8$lambda$') ||
    /\$\$(?:External)?SyntheticLambda\d*$|\$\$Lambda\$/.test(frame.className)
  );
}

/** `Foo$$ExternalSyntheticLambda3` → `lambda in Foo`; other classes by their simple name. */
export function runnableLabel(className: string): string {
  const simple = simpleClassName(className);
  const synthetic =
    /^(.*?)\$\$(?:External)?SyntheticLambda\d*$/.exec(simple) ?? /^(.*?)\$\$Lambda\$/.exec(simple);
  return synthetic?.[1] ? `lambda in ${synthetic[1]}` : simple;
}

const RX_TYPE_PREFIX = /^(?:Observable|Flowable|Single|Maybe|Completable|Parallel)(?=[A-Z])/;
const RX_OPERATORS = /^io\.reactivex\.(?:rxjava3\.)?internal\.operators\./;
/** An operator name as RxJava spells them (the class name is app-supplied text: nothing else becomes a label). */
const RX_OPERATOR_NAME = /^[a-z][A-Za-z0-9]{0,40}$/;

/**
 * The operator of an RxJava 2 or 3 internal class: `…observable.ObservableObserveOn$ObserveOnObserver` → `observeOn`,
 * `…SingleTimer$TimerDisposable` → `timer`; null for a class outside `io.reactivex[.rxjava3].internal.operators`.
 */
export function rxOperator(className: string): string | null {
  if (!RX_OPERATORS.test(className)) return null;
  const outer = simpleClassName(className).split('$')[0] ?? '';
  const name = outer.replace(RX_TYPE_PREFIX, '');
  const operator = name.charAt(0).toLowerCase() + name.slice(1);
  return RX_OPERATOR_NAME.test(operator) ? operator : null;
}

/** RxAndroid's main-thread scheduler (RxJava 2 or 3), whose task wraps the operator's. */
function isRxScheduler(frame: StackFrame): boolean {
  return /^io\.reactivex\.(?:rxjava3\.)?android\.schedulers\./.test(frame.className);
}

interface Dispatch {
  /** Index of the dispatch marker in the stack (outermost of its kind). */
  index: number;
  via: 'callback' | 'message' | 'input' | 'idle';
  /** The Runnable / Handler / idle handler frame, the next frame in; undefined when the stack ends there. */
  target: StackFrame | undefined;
}

/** The Looper's dispatch: the outermost Handler / input / idle marker. */
function findDispatch(stack: Stack): Dispatch | null {
  for (let i = stack.frames.length - 1; i >= 0; i--) {
    const frame = stack.frames[i];
    const inner = innerOf(stack, i);
    if (is(frame, 'android.os.Handler', 'handleCallback'))
      return { index: i, via: 'callback', target: inner };
    if (is(frame, 'android.os.Handler', 'dispatchMessage')) {
      // Across the boundary the frame in between is unknown: a callback or a handleMessage.
      if (i === stack.boundary) return { index: i, via: 'message', target: undefined };
      if (!is(inner, 'android.os.Handler')) return { index: i, via: 'message', target: inner };
    }
    if (is(frame, 'android.view.InputEventReceiver', 'dispatchInputEvent')) {
      return { index: i, via: 'input', target: inner };
    }
    if (is(frame, 'android.os.MessageQueue', 'next') && inner?.method === 'queueIdle') {
      return { index: i, via: 'idle', target: inner };
    }
  }
  return null;
}

/** Outermost frame (index below `from`) matching `test`, or -1. */
function outermost(stack: readonly StackFrame[], from: number, test: (frame: StackFrame) => boolean): number {
  for (let i = Math.min(from, stack.length) - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame !== undefined && test(frame)) return i;
  }
  return -1;
}

/** The first hand-written app frame below index `from` (closest to the dispatch). */
function entryFrame(stack: readonly StackFrame[], from: number): StackFrame | null {
  const i = outermost(stack, from, (f) => f.inApp && !isGeneratedFrame(f) && !isSyntheticFrame(f));
  return i < 0 ? null : (stack[i] ?? null);
}

/** `HomeViewModel.load (HomeViewModel.kt:40)`. */
function frameText(frame: StackFrame): string {
  return `${frameMethod(frame)} (${frameLocation(frame)})`;
}

function frameKey(frame: StackFrame | null): string {
  return frame === null ? '' : `${frame.className}#${frame.method}#${frame.file ?? ''}#${frame.line ?? ''}`;
}

/** What the dispatch tells; the rest of a StallOrigin is filled in by `stallOrigin`. */
type OriginBase = Pick<StallOrigin, 'kind' | 'label'> &
  Partial<Pick<StallOrigin, 'detail' | 'dispatched' | 'operator' | 'dispatcher'>>;

/** Choreographer frame callbacks, by the callback the frame ran. */
function frameOrigin(stack: Stack, from: number): OriginBase {
  const record = outermost(
    stack.frames,
    from,
    (f) => f.className === 'android.view.Choreographer$CallbackRecord',
  );
  const callback = record < 0 ? undefined : innerOf(stack, record);
  const name = callback?.className ?? '';
  if (name === 'android.view.ViewRootImpl$TraversalRunnable')
    return { kind: 'frame', label: 'Layout & draw' };
  if (name.startsWith('android.animation.AnimationHandler')) return { kind: 'frame', label: 'Animators' };
  if (name.startsWith('androidx.compose.')) return { kind: 'frame', label: 'Compose' };
  if (name.startsWith('android.view.ViewRootImpl$') && /Input/.test(name)) {
    return { kind: 'input', label: 'Batched input' };
  }
  if (callback === undefined) return { kind: 'frame', label: 'Frame' };
  return { kind: 'frame', label: 'Frame callback', dispatched: name, detail: runnableLabel(name) };
}

const INPUT_RUNNABLES: Readonly<Record<string, string>> = {
  'android.view.View$PerformClick': 'Click',
  'android.view.View$CheckForLongPress': 'Long press',
  'android.view.View$CheckForTap': 'Tap',
  'android.view.View$PerformLongClick': 'Long press',
};

/** Coroutine dispatchers by the posted Runnable that resumed the coroutine. */
function coroutineDispatcher(className: string): string | null {
  if (className.startsWith('androidx.compose.ui.platform.AndroidUiDispatcher')) return 'AndroidUiDispatcher';
  if (className.startsWith('kotlinx.coroutines.android.HandlerContext')) return 'Dispatchers.Main (delay)';
  if (className.startsWith('kotlinx.coroutines.')) return 'Dispatchers.Main';
  return null;
}

/** A posted Runnable / handled message, refined by what it is. */
function dispatchOrigin(stack: Stack, dispatch: Dispatch, rxTask: string | null): OriginBase {
  const target = dispatch.target;
  const name = target?.className ?? '';
  if (dispatch.via === 'input') return { kind: 'input', label: 'Input event' };
  if (dispatch.via === 'idle') {
    return { kind: 'idle', label: 'Idle handler', dispatched: name, detail: runnableLabel(name) };
  }
  if (dispatch.via === 'message') {
    if (name === 'android.app.ActivityThread$H') return { kind: 'lifecycle', label: 'Activity lifecycle' };
    if (target === undefined) return { kind: 'handler', label: 'Handler' };
    return { kind: 'handler', label: 'Handler message', dispatched: name, detail: runnableLabel(name) };
  }
  if (name === 'android.view.Choreographer$FrameDisplayEventReceiver')
    return frameOrigin(stack, dispatch.index);
  const input = INPUT_RUNNABLES[name];
  if (input !== undefined) return { kind: 'input', label: input, dispatched: name };
  if (rxTask !== null || name.startsWith('io.reactivex.'))
    return rxFromStack(stack.frames, dispatch.index, rxTask);
  const dispatcher = coroutineDispatcher(name);
  if (dispatcher !== null) return { kind: 'coroutine', label: dispatcher, dispatcher, dispatched: name };
  if (name === 'androidx.lifecycle.LiveData$1')
    return { kind: 'handler', label: 'LiveData.postValue', dispatched: name };
  if (name.startsWith('android.app.LoadedApk$ReceiverDispatcher')) {
    return { kind: 'lifecycle', label: 'Broadcast receiver', dispatched: name };
  }
  if (target === undefined) return { kind: 'handler', label: 'Handler' };
  return { kind: 'handler', label: 'Handler.post', dispatched: name, detail: runnableLabel(name) };
}

/** The Rx task: the SDK's (exact), else the first Rx operator frame inside the scheduler's runnable. */
function rxFromStack(stack: readonly StackFrame[], from: number, rxTask: string | null): OriginBase {
  let task = rxTask;
  if (task === null) {
    const i = outermost(stack, from, (f) => !isSdkFrame(f) && rxOperator(f.className) !== null);
    task = i < 0 ? null : (stack[i]?.className ?? null);
  }
  const operator = task === null ? null : rxOperator(task);
  return { kind: 'rx', label: operator ?? 'Rx task', dispatched: task, operator };
}

/** Without the Looper frames (a cut stack from an SDK before 0.9.0): what the inner frames still tell. */
function cutStackOrigin(stack: readonly StackFrame[], rxTask: string | null): OriginBase {
  // A scheduler's or operator's task, not any Rx frame: `subject.onNext` from a click is the click's work.
  const isRxTask = (f: StackFrame) =>
    isRxScheduler(f) ||
    ((f.method === 'run' || /ObserveOn\$/.test(f.className)) && rxOperator(f.className) !== null);
  if (rxTask !== null || stack.some(isRxTask)) return rxFromStack(stack, stack.length, rxTask);
  const task = outermost(stack, stack.length, (f) => is(f, 'kotlinx.coroutines.DispatchedTask', 'run'));
  if (task >= 0)
    return { kind: 'coroutine', label: 'Coroutine', dispatched: 'kotlinx.coroutines.DispatchedTask' };
  return { kind: 'unknown', label: stack.length === 0 ? 'No stack' : 'Stack cut before the dispatch' };
}

/** The outermost resumed continuation (`invokeSuspend`) below `from`: the coroutine that was resumed. */
function continuationFrame(stack: readonly StackFrame[], from: number): StackFrame | null {
  const i = outermost(stack, from, (f) => f.method === 'invokeSuspend');
  return i < 0 ? null : (stack[i] ?? null);
}

/** Where a stall's main-thread work came from. */
export function stallOrigin(
  stall: Pick<StallSample, 'frames' | 'outerFrames' | 'rx' | 'coroutine'>,
): StallOrigin {
  const stack = stackOf(stall);
  const rxTask = stall.rx?.task ?? null;
  const dispatch = findDispatch(stack);
  const from = dispatch?.index ?? stack.frames.length;
  const base =
    dispatch === null ? cutStackOrigin(stack.frames, rxTask) : dispatchOrigin(stack, dispatch, rxTask);
  const entry = dispatch === null && base.kind === 'unknown' ? null : entryFrame(stack.frames, from);
  const origin: StallOrigin = {
    kind: base.kind,
    key: '',
    label: base.label,
    detail: base.detail ?? null,
    frame: null,
    dispatched: base.dispatched ?? null,
    entry,
    operator: base.operator ?? null,
    consumer: stall.rx?.consumer ?? null,
    subscribedAt: stall.rx?.subscribedAt ?? [],
    dispatcher: base.dispatcher ?? null,
    coroutine: stall.coroutine ?? null,
  };
  return withWhere(origin, stack.frames, from);
}

/** Fills `detail`, `frame` and `key`: the place this kind of work is best traced back to. */
function withWhere(origin: StallOrigin, stack: readonly StackFrame[], from: number): StallOrigin {
  switch (origin.kind) {
    case 'rx': {
      // A site is an app line, or nothing (an observeOn subscribed from a scheduler's thread).
      const culprit = culpritFrame(origin.subscribedAt);
      const site = culprit?.inApp === true ? culprit : null;
      const consumer = origin.consumer === null ? null : runnableLabel(origin.consumer);
      const frame = site ?? origin.entry;
      const detail =
        site !== null ? frameText(site) : (consumer ?? (frame === null ? null : frameText(frame)));
      // By consumer first: one chain keeps one key whether its site was captured or not (the capture rate).
      const key = `rx|${origin.label}|${origin.consumer ?? frameKey(site ?? origin.entry)}`;
      return { ...origin, detail, frame, key };
    }
    case 'coroutine': {
      const continuation = continuationFrame(stack, from);
      const name = origin.coroutine?.replace(/#\d+$/, '') ?? '';
      const detail = continuation === null ? null : runnableLabel(continuation.className);
      return {
        ...origin,
        detail,
        frame: continuation ?? origin.entry,
        key: `coroutine|${origin.label}|${continuation?.className ?? frameKey(origin.entry)}|${name}`,
      };
    }
    case 'handler':
    case 'idle':
      return {
        ...origin,
        detail: origin.detail ?? (origin.entry === null ? null : frameText(origin.entry)),
        frame: origin.entry,
        key: `${origin.kind}|${origin.label}|${origin.dispatched ?? frameKey(origin.entry)}`,
      };
    case 'lifecycle':
    case 'input':
    case 'frame':
      return {
        ...origin,
        detail: origin.detail ?? (origin.entry === null ? null : frameText(origin.entry)),
        frame: origin.entry,
        key: `${origin.kind}|${origin.label}|${origin.dispatched ?? ''}|${frameKey(origin.entry)}`,
      };
    case 'unknown':
      return { ...origin, key: `unknown|${origin.label}` };
  }
}

/** `observeOn · HomeViewModel.load (HomeViewModel.kt:40)`: the origin on one line. */
export function originText(origin: StallOrigin): string {
  const head = `${ORIGIN_KIND_LABELS[origin.kind]} ${origin.label}`;
  // Quoted as JSON: an app-chosen name can't pose as the rest of the line.
  const name = origin.coroutine === null ? '' : ` ${JSON.stringify(origin.coroutine)}`;
  return origin.detail === null ? `${head}${name}` : `${head}${name} · ${origin.detail}`;
}

export interface OriginGroup {
  key: string;
  /** The newest stall's origin (they share the key, so the same kind, label and place). */
  origin: StallOrigin;
  count: number;
  totalMs: number;
  maxMs: number;
  /** Screens it blocked, most stalls first. */
  screens: string[];
  lastTs: number;
}

/**
 * Stalls overlapping the window grouped by origin, worst total blocked time first. Debugger-attached stalls are left
 * out, as in the offenders ranking.
 */
export function aggregateOrigins(
  stalls: readonly StallSample[],
  fromTs: number,
  toTs: number,
): OriginGroup[] {
  const groups = new Map<string, OriginGroup & { screenCounts: Map<string, number> }>();
  for (const stall of stalls) {
    if (stall.debugger || !stallInWindow(stall, fromTs, toTs)) continue;
    const origin = stallOrigin(stall);
    const group = groups.get(origin.key) ?? {
      key: origin.key,
      origin,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      screens: [],
      lastTs: stall.ts,
      screenCounts: new Map<string, number>(),
    };
    group.count += 1;
    group.totalMs += stall.durationMs;
    group.maxMs = Math.max(group.maxMs, stall.durationMs);
    if (stall.ts >= group.lastTs) {
      group.lastTs = stall.ts;
      group.origin = origin;
    }
    if (stall.screen !== null) {
      group.screenCounts.set(stall.screen, (group.screenCounts.get(stall.screen) ?? 0) + 1);
    }
    groups.set(origin.key, group);
  }
  return [...groups.values()]
    .map(({ screenCounts, ...group }) => ({
      ...group,
      screens: [...screenCounts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name]) => name),
    }))
    .sort((a, b) => b.totalMs - a.totalMs || b.count - a.count || a.key.localeCompare(b.key));
}
