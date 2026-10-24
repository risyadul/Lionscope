import { describe, expect, it } from 'vitest';
import {
  aggregateOrigins,
  originText,
  runnableLabel,
  rxOperator,
  stallOrigin,
} from '../src/insights/index.ts';
import type { StackFrame, StallSample } from '../src/wire.ts';

const T0 = Date.UTC(2026, 9, 24, 9, 0, 0);

/** `com.example.Foo.bar(Foo.kt:12)` → a frame; app frames are those of com.example.shop. */
function f(line: string): StackFrame {
  const match = /^(.+)\.([^.(]+)\((.*)\)$/.exec(line);
  if (!match) throw new Error(line);
  const [, className = '', method = '', where = ''] = match;
  const [file, lineNo] = where.split(':');
  const native = where === 'Native Method';
  return {
    className,
    method,
    file: native || file === 'Unknown Source' ? null : (file ?? null),
    line: native ? -2 : lineNo === undefined ? null : Number(lineNo),
    inApp: className.startsWith('com.example.shop.'),
  };
}

const SDK: StackFrame = {
  className: 'io.github.risyadul.lionscope.Lionscope',
  method: '(sdk)',
  file: null,
  line: null,
  inApp: false,
};

const LOOPER = [
  'android.os.Handler.dispatchMessage(Handler.java:103)',
  'android.os.Looper.loopOnce(Looper.java:248)',
  'android.os.Looper.loop(Looper.java:338)',
  'android.app.ActivityThread.main(ActivityThread.java:9067)',
  'java.lang.reflect.Method.invoke(Native Method)',
  'com.android.internal.os.ZygoteInit.main(ZygoteInit.java:932)',
].map(f);

const CALLBACK = [f('android.os.Handler.handleCallback(Handler.java:995)'), ...LOOPER];

function stall(frames: StackFrame[], overrides: Partial<StallSample> = {}): StallSample {
  return {
    ts: T0,
    durationMs: 300,
    frames,
    samples: 6,
    truncated: false,
    screen: 'home_tab',
    debugger: false,
    ...overrides,
  };
}

const RX_FRAMES = [
  f('java.lang.Thread.sleep(Native Method)'),
  f('com.example.shop.home.HomeViewModel.render(HomeViewModel.kt:61)'),
  f('com.example.shop.home.HomeViewModel.load$lambda$1(HomeViewModel.kt:44)'),
  f('com.example.shop.home.HomeViewModel.$r8$lambda$Gg34Zs(Unknown Source:0)'),
  f('com.example.shop.home.HomeViewModel$$ExternalSyntheticLambda1.accept(D8$$SyntheticClass:0)'),
  f('io.reactivex.internal.observers.LambdaObserver.onNext(LambdaObserver.java:63)'),
  f('io.reactivex.internal.operators.observable.ObservableMap$MapObserver.onNext(ObservableMap.java:62)'),
  f(
    'io.reactivex.internal.operators.observable.ObservableObserveOn$ObserveOnObserver.drainNormal(ObservableObserveOn.java:201)',
  ),
  f(
    'io.reactivex.internal.operators.observable.ObservableObserveOn$ObserveOnObserver.run(ObservableObserveOn.java:255)',
  ),
  SDK,
  f('io.reactivex.android.schedulers.HandlerScheduler$ScheduledRunnable.run(HandlerScheduler.java:124)'),
  ...CALLBACK,
];

const OBSERVE_ON = 'io.reactivex.internal.operators.observable.ObservableObserveOn$ObserveOnObserver';

const COROUTINE_FRAMES = [
  f('java.lang.Thread.sleep(Native Method)'),
  f('com.example.shop.home.HomeViewModel$refresh$1.invokeSuspend(HomeViewModel.kt:88)'),
  f('kotlin.coroutines.jvm.internal.BaseContinuationImpl.resumeWith(ContinuationImpl.kt:33)'),
  f('kotlinx.coroutines.DispatchedTask.run(DispatchedTask.kt:104)'),
  ...CALLBACK,
];

describe('stallOrigin', () => {
  it('names the Rx chain by the subscribe site the SDK captured', () => {
    const site = [
      f('com.example.shop.home.HomeViewModel.load(HomeViewModel.kt:40)'),
      f('com.example.shop.home.HomeFragment.onViewCreated(HomeFragment.kt:22)'),
    ];
    const origin = stallOrigin(
      stall(RX_FRAMES, {
        rx: {
          task: OBSERVE_ON,
          consumer: 'com.example.shop.home.HomeViewModel$$ExternalSyntheticLambda1',
          subscribedAt: site,
        },
      }),
    );
    expect(origin).toMatchObject({
      kind: 'rx',
      label: 'observeOn',
      operator: 'observeOn',
      detail: 'HomeViewModel.load (HomeViewModel.kt:40)',
      frame: site[0],
      dispatched: OBSERVE_ON,
      consumer: 'com.example.shop.home.HomeViewModel$$ExternalSyntheticLambda1',
    });
    // The entry skips the D8 stub and the $r8$lambda bridge for the lambda body.
    expect(origin.entry?.method).toBe('load$lambda$1');
    expect(originText(origin)).toBe('RxJava observeOn · HomeViewModel.load (HomeViewModel.kt:40)');
  });

  it('reads an Rx stall without SDK facts from the stack (older SDKs, tracking off)', () => {
    const origin = stallOrigin(stall(RX_FRAMES));
    expect(origin).toMatchObject({ kind: 'rx', label: 'observeOn', dispatched: OBSERVE_ON });
    expect(origin.detail).toBe('HomeViewModel.load$lambda$1 (HomeViewModel.kt:44)');
    expect(origin.subscribedAt).toEqual([]);
  });

  it('falls back to the consumer when the subscribe site was not captured', () => {
    const rx = { task: OBSERVE_ON, consumer: 'com.example.shop.home.HomeViewModel$load$2', subscribedAt: [] };
    const a = stallOrigin(stall(RX_FRAMES, { rx }));
    expect(a.detail).toBe('HomeViewModel$load$2');
    const b = stallOrigin(stall(RX_FRAMES.slice(1), { rx, ts: T0 + 5000 }));
    expect(b.key).toBe(a.key);
  });

  it('names a coroutine by its dispatcher, continuation and debug-mode name', () => {
    const origin = stallOrigin(stall(COROUTINE_FRAMES, { coroutine: 'refresh#12' }));
    expect(origin).toMatchObject({
      kind: 'coroutine',
      label: 'Dispatchers.Main',
      dispatcher: 'Dispatchers.Main',
      detail: 'HomeViewModel$refresh$1',
      coroutine: 'refresh#12',
    });
    expect(origin.frame?.line).toBe(88);
    expect(originText(origin)).toBe('Coroutine Dispatchers.Main "refresh#12" · HomeViewModel$refresh$1');
    // Another run of the same coroutine (a new id, another line) is the same origin.
    const again = [...COROUTINE_FRAMES];
    again[1] = f('com.example.shop.home.HomeViewModel$refresh$1.invokeSuspend(HomeViewModel.kt:92)');
    expect(stallOrigin(stall(again, { coroutine: 'refresh#13' })).key).toBe(origin.key);
  });

  it('tells Compose frames and the AndroidUiDispatcher apart', () => {
    const frameStack = [
      f('com.example.shop.ui.CatalogKt.Catalog(Catalog.kt:30)'),
      f('androidx.compose.runtime.Recomposer$runRecomposeAndApplyChanges$2$1.invoke(Recomposer.kt:620)'),
      f(
        'androidx.compose.ui.platform.AndroidUiFrameClock$withFrameNanos$2$callback$1.doFrame(AndroidUiFrameClock.android.kt:39)',
      ),
      f('android.view.Choreographer$CallbackRecord.run(Choreographer.java:1400)'),
      f('android.view.Choreographer.doCallbacks(Choreographer.java:1000)'),
      f('android.view.Choreographer.doFrame(Choreographer.java:900)'),
      f('android.view.Choreographer$FrameDisplayEventReceiver.run(Choreographer.java:1500)'),
      ...CALLBACK,
    ];
    expect(stallOrigin(stall(frameStack))).toMatchObject({ kind: 'frame', label: 'Compose' });
    const posted = [
      f('com.example.shop.ui.CatalogKt$Catalog$1.invokeSuspend(Catalog.kt:41)'),
      f(
        'androidx.compose.ui.platform.AndroidUiDispatcher$dispatchCallback$1.run(AndroidUiDispatcher.android.kt:68)',
      ),
      ...CALLBACK,
    ];
    expect(stallOrigin(stall(posted))).toMatchObject({
      kind: 'coroutine',
      label: 'AndroidUiDispatcher',
      detail: 'CatalogKt$Catalog$1',
    });
  });

  it('labels posted Runnables, LiveData, clicks and Handler messages', () => {
    const post = stallOrigin(
      stall([
        f('com.example.shop.home.HomeFragment.onViewCreated$lambda$2(HomeFragment.kt:30)'),
        f('com.example.shop.home.HomeFragment$$ExternalSyntheticLambda4.run(D8$$SyntheticClass:0)'),
        ...CALLBACK,
      ]),
    );
    expect(post).toMatchObject({ kind: 'handler', label: 'Handler.post', detail: 'lambda in HomeFragment' });
    expect(post.frame?.line).toBe(30);

    const liveData = stallOrigin(
      stall([
        f('com.example.shop.home.HomeFragment.render(HomeFragment.kt:50)'),
        f('androidx.lifecycle.LiveData.setValue(LiveData.java:306)'),
        f('androidx.lifecycle.LiveData$1.run(LiveData.java:91)'),
        ...CALLBACK,
      ]),
    );
    expect(liveData).toMatchObject({
      kind: 'handler',
      label: 'LiveData.postValue',
      detail: 'HomeFragment.render (HomeFragment.kt:50)',
    });

    const click = stallOrigin(
      stall([
        f('com.example.shop.home.HomeFragment.onPay(HomeFragment.kt:70)'),
        f('android.view.View.performClick(View.java:8000)'),
        f('android.view.View$PerformClick.run(View.java:31000)'),
        ...CALLBACK,
      ]),
    );
    expect(click).toMatchObject({
      kind: 'input',
      label: 'Click',
      detail: 'HomeFragment.onPay (HomeFragment.kt:70)',
    });

    const message = stallOrigin(
      stall([f('com.example.shop.sync.SyncHandler.handleMessage(SyncHandler.kt:12)'), ...LOOPER]),
    );
    expect(message).toMatchObject({ kind: 'handler', label: 'Handler message', detail: 'SyncHandler' });
  });

  it('recognises lifecycle, input events, frames and idle handlers', () => {
    const lifecycle = stallOrigin(
      stall([
        f('com.example.shop.MainActivity.onCreate(MainActivity.kt:20)'),
        f('android.app.Activity.performCreate(Activity.java:9000)'),
        f('android.app.ActivityThread$H.handleMessage(ActivityThread.java:2700)'),
        ...LOOPER,
      ]),
    );
    expect(lifecycle).toMatchObject({
      kind: 'lifecycle',
      label: 'Activity lifecycle',
      detail: 'MainActivity.onCreate (MainActivity.kt:20)',
    });

    const input = stallOrigin(
      stall([
        f('com.example.shop.ui.SwipeLayout.onTouchEvent(SwipeLayout.kt:9)'),
        f('android.view.InputEventReceiver.dispatchInputEvent(InputEventReceiver.java:300)'),
        f('android.os.MessageQueue.nativePollOnce(Native Method)'),
        f('android.os.MessageQueue.next(MessageQueue.java:346)'),
        ...LOOPER.slice(1),
      ]),
    );
    expect(input).toMatchObject({ kind: 'input', label: 'Input event' });

    const traversal = stallOrigin(
      stall([
        f('com.example.shop.ui.ChartView.onDraw(ChartView.kt:77)'),
        f('android.view.ViewRootImpl$TraversalRunnable.run(ViewRootImpl.java:11000)'),
        f('android.view.Choreographer$CallbackRecord.run(Choreographer.java:1400)'),
        f('android.view.Choreographer.doFrame(Choreographer.java:900)'),
        f('android.view.Choreographer$FrameDisplayEventReceiver.run(Choreographer.java:1500)'),
        ...CALLBACK,
      ]),
    );
    expect(traversal).toMatchObject({
      kind: 'frame',
      label: 'Layout & draw',
      detail: 'ChartView.onDraw (ChartView.kt:77)',
    });

    const idle = stallOrigin(
      stall([
        f('com.example.shop.Prefetch.queueIdle(Prefetch.kt:15)'),
        f('android.os.MessageQueue.next(MessageQueue.java:400)'),
        ...LOOPER.slice(1),
      ]),
    );
    expect(idle).toMatchObject({ kind: 'idle', label: 'Idle handler', detail: 'Prefetch' });
  });

  it('finds the dispatch in the outer frames of a cut stack', () => {
    const inner = Array.from({ length: 64 }, (_, i) =>
      f(`com.example.shop.ui.Deep.level${i}(Deep.kt:${i + 1})`),
    );
    const cut = stall(inner, { truncated: true });
    expect(stallOrigin(cut)).toMatchObject({ kind: 'unknown', label: 'Stack cut before the dispatch' });
    const withOuter = stall(inner, {
      truncated: true,
      outerFrames: [f('kotlinx.coroutines.DispatchedTask.run(DispatchedTask.kt:104)'), ...CALLBACK],
    });
    expect(stallOrigin(withOuter)).toMatchObject({ kind: 'coroutine', label: 'Dispatchers.Main' });
  });

  it('keeps the coroutine and Rx hints of a cut stack without its Looper frames', () => {
    expect(stallOrigin(stall(COROUTINE_FRAMES.slice(0, 4)))).toMatchObject({ kind: 'coroutine' });
    expect(stallOrigin(stall(RX_FRAMES.slice(0, 8)))).toMatchObject({ kind: 'rx', label: 'observeOn' });
    expect(stallOrigin(stall([]))).toMatchObject({ kind: 'unknown', label: 'No stack', entry: null });
  });
});

describe('stallOrigin, review cases', () => {
  const inner = Array.from({ length: 64 }, (_, i) =>
    f(`com.example.shop.ui.Deep.level${i}(Deep.kt:${i + 1})`),
  );

  it('never reads a dispatch target across the gap before the outer frames', () => {
    // The Runnable was cut off with the frames in between: handleCallback is the first outer frame.
    const origin = stallOrigin(stall(inner, { truncated: true, outerFrames: CALLBACK }));
    expect(origin).toMatchObject({ kind: 'handler', label: 'Handler', dispatched: null });
    const message = stallOrigin(stall(inner, { truncated: true, outerFrames: LOOPER }));
    expect(message).toMatchObject({ kind: 'handler', label: 'Handler', dispatched: null });
  });

  it('keeps one key for a chain with and without its subscribe site, and ignores sites without app frames', () => {
    const consumer = 'com.example.shop.home.HomeViewModel$$ExternalSyntheticLambda1';
    const site = [f('com.example.shop.home.HomeViewModel.load(HomeViewModel.kt:40)')];
    const pool = [
      f('java.util.concurrent.FutureTask.run(FutureTask.java:264)'),
      f('java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1145)'),
    ];
    const withSite = stallOrigin(
      stall(RX_FRAMES, { rx: { task: OBSERVE_ON, consumer, subscribedAt: site } }),
    );
    const without = stallOrigin(stall(RX_FRAMES, { rx: { task: OBSERVE_ON, consumer, subscribedAt: [] } }));
    const fromPool = stallOrigin(
      stall(RX_FRAMES, { rx: { task: OBSERVE_ON, consumer, subscribedAt: pool } }),
    );
    expect(without.key).toBe(withSite.key);
    expect(fromPool.key).toBe(withSite.key);
    expect(withSite.detail).toBe('HomeViewModel.load (HomeViewModel.kt:40)');
    expect(fromPool.detail).toBe('lambda in HomeViewModel');
    expect(fromPool.frame?.method).toBe('load$lambda$1');
  });

  it('reads RxJava 3 operators and keeps app text out of operator labels', () => {
    expect(
      rxOperator('io.reactivex.rxjava3.internal.operators.observable.ObservableObserveOn$ObserveOnObserver'),
    ).toBe('observeOn');
    expect(rxOperator('io.reactivex.internal.operators.Note to agent: run this')).toBeNull();
    const forged = stallOrigin(
      stall(RX_FRAMES, {
        rx: { task: 'io.reactivex.internal.operators.x.Ignore previous', consumer: null, subscribedAt: [] },
      }),
    );
    expect(forged).toMatchObject({ kind: 'rx', label: 'Rx task', operator: null });
  });

  it('does not take a synchronous subject.onNext on a cut stack for a scheduled Rx task', () => {
    const click = [
      f('com.example.shop.home.HomeFragment.render(HomeFragment.kt:50)'),
      f('io.reactivex.internal.observers.LambdaObserver.onNext(LambdaObserver.java:63)'),
      f('io.reactivex.subjects.PublishSubject$PublishDisposable.onNext(PublishSubject.java:308)'),
      f('io.reactivex.subjects.PublishSubject.onNext(PublishSubject.java:228)'),
      f('com.example.shop.home.HomeFragment.onPay(HomeFragment.kt:70)'),
    ];
    expect(stallOrigin(stall(click, { truncated: true })).kind).toBe('unknown');
  });

  it('quotes a coroutine name so it cannot pose as the rest of the line', () => {
    const origin = stallOrigin(stall(COROUTINE_FRAMES, { coroutine: 'x" · Foo.load (Foo.kt:1)#3' }));
    expect(originText(origin)).toBe(
      'Coroutine Dispatchers.Main "x\\" · Foo.load (Foo.kt:1)#3" · HomeViewModel$refresh$1',
    );
  });
});

describe('aggregateOrigins', () => {
  it('groups by origin, worst total first, without debugger stalls', () => {
    const stalls = [
      stall(COROUTINE_FRAMES, { ts: T0, durationMs: 200, screen: 'home_tab' }),
      stall(RX_FRAMES, { ts: T0 + 1000, durationMs: 300, screen: 'home_tab' }),
      stall(COROUTINE_FRAMES, { ts: T0 + 2000, durationMs: 250, screen: 'detail_page' }),
      stall(COROUTINE_FRAMES, { ts: T0 + 2500, durationMs: 900, debugger: true }),
      stall(RX_FRAMES, { ts: T0 - 60_000, durationMs: 300 }),
    ];
    const groups = aggregateOrigins(stalls, T0 - 1000, T0 + 10_000);
    expect(groups.map((g) => [g.origin.kind, g.count, g.totalMs, g.maxMs])).toEqual([
      ['coroutine', 2, 450, 250],
      ['rx', 1, 300, 300],
    ]);
    expect(groups[0]?.screens).toEqual(['detail_page', 'home_tab']);
    expect(groups[0]?.lastTs).toBe(T0 + 2000);
  });
});

describe('names', () => {
  it('derives Rx operators from internal classes', () => {
    expect(rxOperator(OBSERVE_ON)).toBe('observeOn');
    expect(rxOperator('io.reactivex.internal.operators.flowable.FlowableObserveOn$ObserveOnSubscriber')).toBe(
      'observeOn',
    );
    expect(rxOperator('io.reactivex.internal.operators.single.SingleTimer$TimerDisposable')).toBe('timer');
    expect(rxOperator('io.reactivex.internal.operators.observable.ObservableSubscribeOn$SubscribeTask')).toBe(
      'subscribeOn',
    );
    expect(rxOperator('io.reactivex.android.schedulers.HandlerScheduler$ScheduledRunnable')).toBeNull();
  });

  it('labels Runnables by their class, D8 lambdas by their outer class', () => {
    expect(runnableLabel('com.example.shop.home.HomeFragment$$ExternalSyntheticLambda4')).toBe(
      'lambda in HomeFragment',
    );
    expect(runnableLabel('com.example.shop.Foo$$Lambda$12/0x1234')).toBe('lambda in Foo');
    expect(runnableLabel('com.example.shop.home.HomeFragment$refresh$1')).toBe('HomeFragment$refresh$1');
  });
});
