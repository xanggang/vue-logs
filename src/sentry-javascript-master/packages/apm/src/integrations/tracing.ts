// tslint:disable: max-file-line-count
import { Hub } from '@sentry/hub';
import { Event, EventProcessor, Integration, Severity, Span, SpanContext, TransactionContext } from '@sentry/types';
import {
  addInstrumentationHandler,
  getGlobalObject,
  isInstanceOf,
  isMatchingPattern,
  logger,
  safeJoin,
  supportsNativeFetch,
  timestampWithMs,
} from '@sentry/utils';

import { Span as SpanClass } from '../span';
import { SpanStatus } from '../spanstatus';
import { Transaction } from '../transaction';

import { Location } from './types';

/**
 * Options for Tracing integration
 */
export interface TracingOptions {
  /**
   * List of strings / regex where the integration should create Spans out of. Additionally this will be used
   * to define which outgoing requests the `sentry-trace` header will be attached to.
   *
   * Default: ['localhost', /^\//]
   */
  tracingOrigins: Array<string | RegExp>;
  /**
   * Flag to disable patching all together for fetch requests.
   *
   * Default: true
   */
  traceFetch: boolean;
  /**
   * Flag to disable patching all together for xhr requests.
   *
   * Default: true
   */
  traceXHR: boolean;
  /**
   * This function will be called before creating a span for a request with the given url.
   * Return false if you don't want a span for the given url.
   *
   * By default it uses the `tracingOrigins` options as a url match.
   */
  shouldCreateSpanForRequest(url: string): boolean;
  /**
   * The time to wait in ms until the transaction will be finished. The transaction will use the end timestamp of
   * the last finished span as the endtime for the transaction.
   * Time is in ms.
   *
   * Default: 500
   */
  idleTimeout: number;

  /**
   * Flag to enable/disable creation of `navigation` transaction on history changes. Useful for react applications with
   * a router.
   *
   * Default: true
   */
  startTransactionOnLocationChange: boolean;

  /**
   * Flag to enable/disable creation of `pageload` transaction on first pageload.
   *
   * Default: true
   */
  startTransactionOnPageLoad: boolean;

  /**
   * The maximum duration of a transaction before it will be marked as "deadline_exceeded".
   * If you never want to mark a transaction set it to 0.
   * Time is in seconds.
   *
   * Default: 600
   */
  maxTransactionDuration: number;

  /**
   * Flag Transactions where tabs moved to background with "cancelled". Browser background tab timing is
   * not suited towards doing precise measurements of operations. Background transaction can mess up your
   * statistics in non deterministic ways that's why we by default recommend leaving this opition enabled.
   *
   * Default: true
   */
  markBackgroundTransactions: boolean;

  /**
   * This is only if you want to debug in prod.
   * writeAsBreadcrumbs: Instead of having console.log statements we log messages to breadcrumbs
   * so you can investigate whats happening in production with your users to figure why things might not appear the
   * way you expect them to.
   *
   * spanDebugTimingInfo: Add timing info to spans at the point where we create them to figure out browser timing
   * issues.
   *
   * You shouldn't care about this.
   *
   * Default: {
   *   writeAsBreadcrumbs: false;
   *   spanDebugTimingInfo: false;
   * }
   */
  debug: {
    writeAsBreadcrumbs: boolean;
    spanDebugTimingInfo: boolean;
  };

  /**
   * beforeNavigate is called before a pageload/navigation transaction is created and allows for users
   * to set a custom navigation transaction name based on the current `window.location`. Defaults to returning
   * `window.location.pathname`.
   *
   * @param location the current location before navigation span is created
   */
  beforeNavigate(location: Location): string;
}

/** JSDoc */
interface Activity {
  name: string;
  span?: Span;
}

const global = getGlobalObject<Window>();
const defaultTracingOrigins = ['localhost', /^\//];

/**
 * Tracing Integration
 */
export class Tracing implements Integration {
  /**
   * @inheritDoc
   */
  public name: string = Tracing.id;

  /**
   * @inheritDoc
   */
  public static id: string = 'Tracing';

  /** JSDoc */
  public static options: TracingOptions;

  /**
   * Returns current hub.
   */
  private static _getCurrentHub?: () => Hub;

  private static _activeTransaction?: Transaction;

  private static _currentIndex: number = 1;

  public static _activities: { [key: number]: Activity } = {};

  private readonly _emitOptionsWarning: boolean = false;

  private static _performanceCursor: number = 0;

  private static _heartbeatTimer: number = 0;

  private static _prevHeartbeatString: string | undefined;

  private static _heartbeatCounter: number = 0;

  /** Holds the latest LargestContentfulPaint value (it changes during page load). */
  private static _lcp?: { [key: string]: any };

  /** Force any pending LargestContentfulPaint records to be dispatched. */
  private static _forceLCP = () => {
    /* No-op, replaced later if LCP API is available. */
  };

  /**
   * Constructor for Tracing
   *
   * @param _options TracingOptions
   */
  public constructor(_options?: Partial<TracingOptions>) {
    if (global.performance) {
      if (global.performance.mark) {
        global.performance.mark('sentry-tracing-init');
      }
      Tracing._trackLCP();
    }
    const defaults = {
      beforeNavigate(location: Location): string {
        return location.pathname;
      },
      debug: {
        spanDebugTimingInfo: false,
        writeAsBreadcrumbs: false,
      },
      idleTimeout: 500,
      markBackgroundTransactions: true,
      maxTransactionDuration: 600,
      shouldCreateSpanForRequest(url: string): boolean {
        const origins = (_options && _options.tracingOrigins) || defaultTracingOrigins;
        return (
          origins.some((origin: string | RegExp) => isMatchingPattern(url, origin)) &&
          !isMatchingPattern(url, 'sentry_key')
        );
      },
      startTransactionOnLocationChange: true,
      startTransactionOnPageLoad: true,
      traceFetch: true,
      traceXHR: true,
      tracingOrigins: defaultTracingOrigins,
    };
    // NOTE: Logger doesn't work in contructors, as it's initialized after integrations instances
    if (!_options || !Array.isArray(_options.tracingOrigins) || _options.tracingOrigins.length === 0) {
      this._emitOptionsWarning = true;
    }
    Tracing.options = {
      ...defaults,
      ..._options,
    };
  }

  /**
   * @inheritDoc
   */
  public setupOnce(addGlobalEventProcessor: (callback: EventProcessor) => void, getCurrentHub: () => Hub): void {
    Tracing._getCurrentHub = getCurrentHub;

    if (this._emitOptionsWarning) {
      logger.warn(
        '[Tracing] You need to define `tracingOrigins` in the options. Set an array of urls or patterns to trace.',
      );
      logger.warn(`[Tracing] We added a reasonable default for you: ${defaultTracingOrigins}`);
    }

    // Starting pageload transaction
    if (global.location && Tracing.options && Tracing.options.startTransactionOnPageLoad) {
      Tracing.startIdleTransaction({
        name: Tracing.options.beforeNavigate(window.location),
        op: 'pageload',
      });
    }

    this._setupXHRTracing();

    this._setupFetchTracing();

    this._setupHistory();

    this._setupErrorHandling();

    this._setupBackgroundTabDetection();

    Tracing._pingHeartbeat();

    // This EventProcessor makes sure that the transaction is not longer than maxTransactionDuration
    addGlobalEventProcessor((event: Event) => {
      const self = getCurrentHub().getIntegration(Tracing);
      if (!self) {
        return event;
      }

      const isOutdatedTransaction =
        event.timestamp &&
        event.start_timestamp &&
        (event.timestamp - event.start_timestamp > Tracing.options.maxTransactionDuration ||
          event.timestamp - event.start_timestamp < 0);

      if (Tracing.options.maxTransactionDuration !== 0 && event.type === 'transaction' && isOutdatedTransaction) {
        Tracing._log(`[Tracing] Transaction: ${SpanStatus.Cancelled} since it maxed out maxTransactionDuration`);
        if (event.contexts && event.contexts.trace) {
          event.contexts.trace = {
            ...event.contexts.trace,
            status: SpanStatus.DeadlineExceeded,
          };
          event.tags = {
            ...event.tags,
            maxTransactionDurationExceeded: 'true',
          };
        }
      }

      return event;
    });
  }

  /**
   * Returns a new Transaction either continued from sentry-trace meta or a new one
   */
  private static _getNewTransaction(hub: Hub, transactionContext: TransactionContext): Transaction {
    let traceId;
    let parentSpanId;
    let sampled;

    const header = Tracing._getMeta('sentry-trace');
    if (header) {
      const span = SpanClass.fromTraceparent(header);
      if (span) {
        traceId = span.traceId;
        parentSpanId = span.parentSpanId;
        sampled = span.sampled;
        Tracing._log(
          `[Tracing] found 'sentry-meta' '<meta />' continuing trace with: trace_id: ${traceId} span_id: ${parentSpanId}`,
        );
      }
    }

    return hub.startTransaction({
      parentSpanId,
      sampled,
      traceId,
      trimEnd: true,
      ...transactionContext,
    }) as Transaction;
  }

  /**
   * Returns the value of a meta tag
   */
  private static _getMeta(metaName: string): string | null {
    const el = document.querySelector(`meta[name=${metaName}]`);
    return el ? el.getAttribute('content') : null;
  }

  /**
   * Pings the heartbeat
   */
  private static _pingHeartbeat(): void {
    Tracing._heartbeatTimer = (setTimeout(() => {
      Tracing._beat();
    }, 5000) as any) as number;
  }

  /**
   * Checks when entries of Tracing._activities are not changing for 3 beats. If this occurs we finish the transaction
   *
   */
  private static _beat(): void {
    clearTimeout(Tracing._heartbeatTimer);
    const keys = Object.keys(Tracing._activities);
    if (keys.length) {
      const heartbeatString = keys.reduce((prev: string, current: string) => prev + current);
      if (heartbeatString === Tracing._prevHeartbeatString) {
        Tracing._heartbeatCounter++;
      } else {
        Tracing._heartbeatCounter = 0;
      }
      if (Tracing._heartbeatCounter >= 3) {
        if (Tracing._activeTransaction) {
          Tracing._log(
            `[Tracing] Transaction: ${SpanStatus.Cancelled} -> Heartbeat safeguard kicked in since content hasn't changed for 3 beats`,
          );
          Tracing._activeTransaction.setStatus(SpanStatus.DeadlineExceeded);
          Tracing._activeTransaction.setTag('heartbeat', 'failed');
          Tracing.finishIdleTransaction(timestampWithMs());
        }
      }
      Tracing._prevHeartbeatString = heartbeatString;
    }
    Tracing._pingHeartbeat();
  }

  /**
   * Discards active transactions if tab moves to background
   */
  private _setupBackgroundTabDetection(): void {
    if (Tracing.options && Tracing.options.markBackgroundTransactions && global.document) {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && Tracing._activeTransaction) {
          Tracing._log(`[Tracing] Transaction: ${SpanStatus.Cancelled} -> since tab moved to the background`);
          Tracing._activeTransaction.setStatus(SpanStatus.Cancelled);
          Tracing._activeTransaction.setTag('visibilitychange', 'document.hidden');
          Tracing.finishIdleTransaction(timestampWithMs());
        }
      });
    }
  }

  /**
   * Unsets the current active transaction + activities
   */
  private static _resetActiveTransaction(): void {
    // We want to clean up after ourselves
    // If there is still the active transaction on the scope we remove it
    const _getCurrentHub = Tracing._getCurrentHub;
    if (_getCurrentHub) {
      const hub = _getCurrentHub();
      const scope = hub.getScope();
      if (scope) {
        if (scope.getSpan() === Tracing._activeTransaction) {
          scope.setSpan(undefined);
        }
      }
    }
    // ------------------------------------------------------------------
    Tracing._activeTransaction = undefined;
    Tracing._activities = {};
  }

  /**
   * Registers to History API to detect navigation changes
   */
  private _setupHistory(): void {
    if (Tracing.options.startTransactionOnLocationChange) {
      addInstrumentationHandler({
        callback: historyCallback,
        type: 'history',
      });
    }
  }

  /**
   * Attaches to fetch to add sentry-trace header + creating spans
   */
  private _setupFetchTracing(): void {
    if (Tracing.options.traceFetch && supportsNativeFetch()) {
      addInstrumentationHandler({
        callback: fetchCallback,
        type: 'fetch',
      });
    }
  }

  /**
   * Attaches to XHR to add sentry-trace header + creating spans
   */
  private _setupXHRTracing(): void {
    if (Tracing.options.traceXHR) {
      addInstrumentationHandler({
        callback: xhrCallback,
        type: 'xhr',
      });
    }
  }

  /**
   * Configures global error listeners
   */
  private _setupErrorHandling(): void {
    // tslint:disable-next-line: completed-docs
    function errorCallback(): void {
      if (Tracing._activeTransaction) {
        /**
         * If an error or unhandled promise occurs, we mark the active transaction as failed
         */
        Tracing._log(`[Tracing] Transaction: ${SpanStatus.InternalError} -> Global error occured`);
        Tracing._activeTransaction.setStatus(SpanStatus.InternalError);
      }
    }
    addInstrumentationHandler({
      callback: errorCallback,
      type: 'error',
    });
    addInstrumentationHandler({
      callback: errorCallback,
      type: 'unhandledrejection',
    });
  }

  /**
   * Uses logger.log to log things in the SDK or as breadcrumbs if defined in options
   */
  private static _log(...args: any[]): void {
    if (Tracing.options && Tracing.options.debug && Tracing.options.debug.writeAsBreadcrumbs) {
      const _getCurrentHub = Tracing._getCurrentHub;
      if (_getCurrentHub) {
        _getCurrentHub().addBreadcrumb({
          category: 'tracing',
          level: Severity.Debug,
          message: safeJoin(args, ' '),
          type: 'debug',
        });
      }
    }
    logger.log(...args);
  }

  /**
   * Starts a Transaction waiting for activity idle to finish
   */
  public static startIdleTransaction(transactionContext: TransactionContext): Transaction | undefined {
    Tracing._log('[Tracing] startIdleTransaction');

    const _getCurrentHub = Tracing._getCurrentHub;
    if (!_getCurrentHub) {
      return undefined;
    }

    const hub = _getCurrentHub();
    if (!hub) {
      return undefined;
    }

    Tracing._activeTransaction = Tracing._getNewTransaction(hub, transactionContext);

    // We set the transaction here on the scope so error events pick up the trace context and attach it to the error
    hub.configureScope(scope => scope.setSpan(Tracing._activeTransaction));

    // The reason we do this here is because of cached responses
    // If we start and transaction without an activity it would never finish since there is no activity
    const id = Tracing.pushActivity('idleTransactionStarted');
    setTimeout(() => {
      Tracing.popActivity(id);
    }, (Tracing.options && Tracing.options.idleTimeout) || 100);

    return Tracing._activeTransaction;
  }

  /**
   * Finishes the current active transaction
   */
  public static finishIdleTransaction(endTimestamp: number): void {
    const active = Tracing._activeTransaction;
    if (active) {
      Tracing._log('[Tracing] finishing IdleTransaction', new Date(endTimestamp * 1000).toISOString());
      Tracing._addPerformanceEntries(active);

      if (active.spanRecorder) {
        active.spanRecorder.spans = active.spanRecorder.spans.filter((span: Span) => {
          // If we are dealing with the transaction itself, we just return it
          if (span.spanId === active.spanId) {
            return span;
          }

          // We cancel all pending spans with status "cancelled" to indicate the idle transaction was finished early
          if (!span.endTimestamp) {
            span.endTimestamp = endTimestamp;
            span.setStatus(SpanStatus.Cancelled);
            Tracing._log('[Tracing] cancelling span since transaction ended early', JSON.stringify(span, undefined, 2));
          }

          // We remove all spans that happend after the end of the transaction
          // This is here to prevent super long transactions and timing issues
          const keepSpan = span.startTimestamp < endTimestamp;
          if (!keepSpan) {
            Tracing._log(
              '[Tracing] discarding Span since it happened after Transaction was finished',
              JSON.stringify(span, undefined, 2),
            );
          }
          return keepSpan;
        });
      }

      Tracing._log('[Tracing] flushing IdleTransaction');
      active.finish();
      Tracing._resetActiveTransaction();
    } else {
      Tracing._log('[Tracing] No active IdleTransaction');
    }
  }

  /**
   * This uses `performance.getEntries()` to add additional spans to the active transaction.
   * Also, we update our timings since we consider the timings in this API to be more correct than our manual
   * measurements.
   *
   * @param transactionSpan The transaction span
   */
  private static _addPerformanceEntries(transactionSpan: SpanClass): void {
    if (!global.performance || !global.performance.getEntries) {
      // Gatekeeper if performance API not available
      return;
    }

    Tracing._log('[Tracing] Adding & adjusting spans using Performance API');

    // FIXME: depending on the 'op' directly is brittle.
    if (transactionSpan.op === 'pageload') {
      // Force any pending records to be dispatched.
      Tracing._forceLCP();
      if (Tracing._lcp) {
        // Set the last observed LCP score.
        transactionSpan.setData('_sentry_web_vitals', { LCP: Tracing._lcp });
      }
    }

    const timeOrigin = Tracing._msToSec(performance.timeOrigin);

    // tslint:disable-next-line: completed-docs
    function addPerformanceNavigationTiming(parent: Span, entry: { [key: string]: number }, event: string): void {
      _startChild(parent, {
        description: event,
        endTimestamp: timeOrigin + Tracing._msToSec(entry[`${event}End`]),
        op: 'browser',
        startTimestamp: timeOrigin + Tracing._msToSec(entry[`${event}Start`]),
      });
    }

    // tslint:disable-next-line: completed-docs
    function addRequest(parent: Span, entry: { [key: string]: number }): void {
      _startChild(parent, {
        description: 'request',
        endTimestamp: timeOrigin + Tracing._msToSec(entry.responseEnd),
        op: 'browser',
        startTimestamp: timeOrigin + Tracing._msToSec(entry.requestStart),
      });

      _startChild(parent, {
        description: 'response',
        endTimestamp: timeOrigin + Tracing._msToSec(entry.responseEnd),
        op: 'browser',
        startTimestamp: timeOrigin + Tracing._msToSec(entry.responseStart),
      });
    }

    let entryScriptSrc: string | undefined;

    if (global.document) {
      // tslint:disable-next-line: prefer-for-of
      for (let i = 0; i < document.scripts.length; i++) {
        // We go through all scripts on the page and look for 'data-entry'
        // We remember the name and measure the time between this script finished loading and
        // our mark 'sentry-tracing-init'
        if (document.scripts[i].dataset.entry === 'true') {
          entryScriptSrc = document.scripts[i].src;
          break;
        }
      }
    }

    let entryScriptStartEndTime: number | undefined;
    let tracingInitMarkStartTime: number | undefined;

    // tslint:disable: no-unsafe-any
    performance
      .getEntries()
      .slice(Tracing._performanceCursor)
      .forEach((entry: any) => {
        const startTime = Tracing._msToSec(entry.startTime as number);
        const duration = Tracing._msToSec(entry.duration as number);

        if (transactionSpan.op === 'navigation' && timeOrigin + startTime < transactionSpan.startTimestamp) {
          return;
        }

        switch (entry.entryType) {
          case 'navigation':
            addPerformanceNavigationTiming(transactionSpan, entry, 'unloadEvent');
            addPerformanceNavigationTiming(transactionSpan, entry, 'domContentLoadedEvent');
            addPerformanceNavigationTiming(transactionSpan, entry, 'loadEvent');
            addPerformanceNavigationTiming(transactionSpan, entry, 'connect');
            addPerformanceNavigationTiming(transactionSpan, entry, 'domainLookup');
            addRequest(transactionSpan, entry);
            break;
          case 'mark':
          case 'paint':
          case 'measure':
            const mark = _startChild(transactionSpan, {
              description: entry.name,
              endTimestamp: timeOrigin + startTime + duration,
              op: entry.entryType,
              startTimestamp: timeOrigin + startTime,
            });
            if (tracingInitMarkStartTime === undefined && entry.name === 'sentry-tracing-init') {
              tracingInitMarkStartTime = mark.startTimestamp;
            }
            break;
          case 'resource':
            const resourceName = entry.name.replace(window.location.origin, '');
            // we already instrument based on fetch and xhr, so we don't need to
            // duplicate spans here.
            if (entry.initiatorType !== 'xmlhttprequest' && entry.initiatorType !== 'fetch') {
              const resource = _startChild(transactionSpan, {
                description: `${entry.initiatorType} ${resourceName}`,
                endTimestamp: timeOrigin + startTime + duration,
                op: `resource`,
                startTimestamp: timeOrigin + startTime,
              });
              // We remember the entry script end time to calculate the difference to the first init mark
              if (entryScriptStartEndTime === undefined && (entryScriptSrc || '').indexOf(resourceName) > -1) {
                entryScriptStartEndTime = resource.endTimestamp;
              }
            }
            break;
          default:
          // Ignore other entry types.
        }
      });

    if (entryScriptStartEndTime !== undefined && tracingInitMarkStartTime !== undefined) {
      _startChild(transactionSpan, {
        description: 'evaluation',
        endTimestamp: tracingInitMarkStartTime,
        op: `script`,
        startTimestamp: entryScriptStartEndTime,
      });
    }

    Tracing._performanceCursor = Math.max(performance.getEntries().length - 1, 0);
    // tslint:enable: no-unsafe-any
  }

  /**
   * Starts tracking the Largest Contentful Paint on the current page.
   */
  private static _trackLCP(): void {
    // Based on reference implementation from https://web.dev/lcp/#measure-lcp-in-javascript.

    // Use a try/catch instead of feature detecting `largest-contentful-paint`
    // support, since some browsers throw when using the new `type` option.
    // https://bugs.webkit.org/show_bug.cgi?id=209216
    try {
      // Keep track of whether (and when) the page was first hidden, see:
      // https://github.com/w3c/page-visibility/issues/29
      // NOTE: ideally this check would be performed in the document <head>
      // to avoid cases where the visibility state changes before this code runs.
      let firstHiddenTime = document.visibilityState === 'hidden' ? 0 : Infinity;
      document.addEventListener(
        'visibilitychange',
        event => {
          firstHiddenTime = Math.min(firstHiddenTime, event.timeStamp);
        },
        { once: true },
      );

      const updateLCP = (entry: PerformanceEntry) => {
        // Only include an LCP entry if the page wasn't hidden prior to
        // the entry being dispatched. This typically happens when a page is
        // loaded in a background tab.
        if (entry.startTime < firstHiddenTime) {
          // NOTE: the `startTime` value is a getter that returns the entry's
          // `renderTime` value, if available, or its `loadTime` value otherwise.
          // The `renderTime` value may not be available if the element is an image
          // that's loaded cross-origin without the `Timing-Allow-Origin` header.
          Tracing._lcp = {
            // @ts-ignore
            ...(entry.id && { elementId: entry.id }),
            // @ts-ignore
            ...(entry.size && { elementSize: entry.size }),
            value: entry.startTime,
          };
        }
      };

      // Create a PerformanceObserver that calls `updateLCP` for each entry.
      const po = new PerformanceObserver(entryList => {
        entryList.getEntries().forEach(updateLCP);
      });

      // Observe entries of type `largest-contentful-paint`, including buffered entries,
      // i.e. entries that occurred before calling `observe()` below.
      po.observe({
        buffered: true,
        // @ts-ignore
        type: 'largest-contentful-paint',
      });

      Tracing._forceLCP = () => {
        po.takeRecords().forEach(updateLCP);
      };
    } catch (e) {
      // Do nothing if the browser doesn't support this API.
    }
  }

  /**
   * Sets the status of the current active transaction (if there is one)
   */
  public static setTransactionStatus(status: SpanStatus): void {
    const active = Tracing._activeTransaction;
    if (active) {
      Tracing._log('[Tracing] setTransactionStatus', status);
      active.setStatus(status);
    }
  }

  /**
   * Returns the current active idle transaction if there is one
   */
  public static getTransaction(): Transaction | undefined {
    return Tracing._activeTransaction;
  }

  /**
   * Converts from milliseconds to seconds
   * @param time time in ms
   */
  private static _msToSec(time: number): number {
    return time / 1000;
  }

  /**
   * Adds debug data to the span
   */
  private static _addSpanDebugInfo(span: Span): void {
    // tslint:disable: no-unsafe-any
    const debugData: any = {};
    if (global.performance) {
      debugData.performance = true;
      debugData['performance.timeOrigin'] = global.performance.timeOrigin;
      debugData['performance.now'] = global.performance.now();
      // tslint:disable-next-line: deprecation
      if (global.performance.timing) {
        // tslint:disable-next-line: deprecation
        debugData['performance.timing.navigationStart'] = performance.timing.navigationStart;
      }
    } else {
      debugData.performance = false;
    }
    debugData['Date.now()'] = Date.now();
    span.setData('sentry_debug', debugData);
    // tslint:enable: no-unsafe-any
  }

  /**
   * Starts tracking for a specifc activity
   *
   * @param name Name of the activity, can be any string (Only used internally to identify the activity)
   * @param spanContext If provided a Span with the SpanContext will be created.
   * @param options _autoPopAfter_ | Time in ms, if provided the activity will be popped automatically after this timeout. This can be helpful in cases where you cannot gurantee your application knows the state and calls `popActivity` for sure.
   */
  public static pushActivity(
    name: string,
    spanContext?: SpanContext,
    options?: {
      autoPopAfter?: number;
    },
  ): number {
    const activeTransaction = Tracing._activeTransaction;

    if (!activeTransaction) {
      Tracing._log(`[Tracing] Not pushing activity ${name} since there is no active transaction`);
      return 0;
    }

    const _getCurrentHub = Tracing._getCurrentHub;
    if (spanContext && _getCurrentHub) {
      const hub = _getCurrentHub();
      if (hub) {
        const span = activeTransaction.startChild(spanContext);
        Tracing._activities[Tracing._currentIndex] = {
          name,
          span,
        };
      }
    } else {
      Tracing._activities[Tracing._currentIndex] = {
        name,
      };
    }

    Tracing._log(`[Tracing] pushActivity: ${name}#${Tracing._currentIndex}`);
    Tracing._log('[Tracing] activies count', Object.keys(Tracing._activities).length);
    if (options && typeof options.autoPopAfter === 'number') {
      Tracing._log(`[Tracing] auto pop of: ${name}#${Tracing._currentIndex} in ${options.autoPopAfter}ms`);
      const index = Tracing._currentIndex;
      setTimeout(() => {
        Tracing.popActivity(index, {
          autoPop: true,
          status: SpanStatus.DeadlineExceeded,
        });
      }, options.autoPopAfter);
    }
    return Tracing._currentIndex++;
  }

  /**
   * Removes activity and finishes the span in case there is one
   * @param id the id of the activity being removed
   * @param spanData span data that can be updated
   *
   */
  public static popActivity(id: number, spanData?: { [key: string]: any }): void {
    // The !id is on purpose to also fail with 0
    // Since 0 is returned by push activity in case there is no active transaction
    if (!id) {
      return;
    }

    const activity = Tracing._activities[id];

    if (activity) {
      Tracing._log(`[Tracing] popActivity ${activity.name}#${id}`);
      const span = activity.span;
      if (span) {
        if (spanData) {
          Object.keys(spanData).forEach((key: string) => {
            span.setData(key, spanData[key]);
            if (key === 'status_code') {
              span.setHttpStatus(spanData[key] as number);
            }
            if (key === 'status') {
              span.setStatus(spanData[key] as SpanStatus);
            }
          });
        }
        if (Tracing.options && Tracing.options.debug && Tracing.options.debug.spanDebugTimingInfo) {
          Tracing._addSpanDebugInfo(span);
        }
        span.finish();
      }
      // tslint:disable-next-line: no-dynamic-delete
      delete Tracing._activities[id];
    }

    const count = Object.keys(Tracing._activities).length;

    Tracing._log('[Tracing] activies count', count);

    if (count === 0 && Tracing._activeTransaction) {
      const timeout = Tracing.options && Tracing.options.idleTimeout;
      Tracing._log(`[Tracing] Flushing Transaction in ${timeout}ms`);
      // We need to add the timeout here to have the real endtimestamp of the transaction
      // Remeber timestampWithMs is in seconds, timeout is in ms
      const end = timestampWithMs() + timeout / 1000;
      setTimeout(() => {
        Tracing.finishIdleTransaction(end);
      }, timeout);
    }
  }

  /**
   * Get span based on activity id
   */
  public static getActivitySpan(id: number): Span | undefined {
    if (!id) {
      return undefined;
    }
    const activity = Tracing._activities[id];
    if (activity) {
      return activity.span;
    }
    return undefined;
  }
}

/**
 * Creates breadcrumbs from XHR API calls
 */
function xhrCallback(handlerData: { [key: string]: any }): void {
  if (!Tracing.options.traceXHR) {
    return;
  }

  // tslint:disable-next-line: no-unsafe-any
  if (!handlerData || !handlerData.xhr || !handlerData.xhr.__sentry_xhr__) {
    return;
  }

  // tslint:disable: no-unsafe-any
  const xhr = handlerData.xhr.__sentry_xhr__;

  if (!Tracing.options.shouldCreateSpanForRequest(xhr.url)) {
    return;
  }

  // We only capture complete, non-sentry requests
  if (handlerData.xhr.__sentry_own_request__) {
    return;
  }

  if (handlerData.endTimestamp && handlerData.xhr.__sentry_xhr_activity_id__) {
    Tracing.popActivity(handlerData.xhr.__sentry_xhr_activity_id__, handlerData.xhr.__sentry_xhr__);
    return;
  }

  handlerData.xhr.__sentry_xhr_activity_id__ = Tracing.pushActivity('xhr', {
    data: {
      ...xhr.data,
      type: 'xhr',
    },
    description: `${xhr.method} ${xhr.url}`,
    op: 'http',
  });

  // Adding the trace header to the span
  const activity = Tracing._activities[handlerData.xhr.__sentry_xhr_activity_id__];
  if (activity) {
    const span = activity.span;
    if (span && handlerData.xhr.setRequestHeader) {
      try {
        handlerData.xhr.setRequestHeader('sentry-trace', span.toTraceparent());
      } catch (_) {
        // Error: InvalidStateError: Failed to execute 'setRequestHeader' on 'XMLHttpRequest': The object's state must be OPENED.
      }
    }
  }
  // tslint:enable: no-unsafe-any
}

/**
 * Creates breadcrumbs from fetch API calls
 */
function fetchCallback(handlerData: { [key: string]: any }): void {
  // tslint:disable: no-unsafe-any
  if (!Tracing.options.traceFetch) {
    return;
  }

  if (!Tracing.options.shouldCreateSpanForRequest(handlerData.fetchData.url)) {
    return;
  }

  if (handlerData.endTimestamp && handlerData.fetchData.__activity) {
    Tracing.popActivity(handlerData.fetchData.__activity, handlerData.fetchData);
  } else {
    handlerData.fetchData.__activity = Tracing.pushActivity('fetch', {
      data: {
        ...handlerData.fetchData,
        type: 'fetch',
      },
      description: `${handlerData.fetchData.method} ${handlerData.fetchData.url}`,
      op: 'http',
    });

    const activity = Tracing._activities[handlerData.fetchData.__activity];
    if (activity) {
      const span = activity.span;
      if (span) {
        const request = (handlerData.args[0] = handlerData.args[0] as string | Request);
        const options = (handlerData.args[1] = (handlerData.args[1] as { [key: string]: any }) || {});
        let headers = options.headers;
        if (isInstanceOf(request, Request)) {
          headers = (request as Request).headers;
        }
        if (headers) {
          if (typeof headers.append === 'function') {
            headers.append('sentry-trace', span.toTraceparent());
          } else if (Array.isArray(headers)) {
            headers = [...headers, ['sentry-trace', span.toTraceparent()]];
          } else {
            headers = { ...headers, 'sentry-trace': span.toTraceparent() };
          }
        } else {
          headers = { 'sentry-trace': span.toTraceparent() };
        }
        options.headers = headers;
      }
    }
  }
  // tslint:enable: no-unsafe-any
}

/**
 * Creates transaction from navigation changes
 */
function historyCallback(_: { [key: string]: any }): void {
  if (Tracing.options.startTransactionOnLocationChange && global && global.location) {
    Tracing.finishIdleTransaction(timestampWithMs());
    Tracing.startIdleTransaction({
      name: Tracing.options.beforeNavigate(window.location),
      op: 'navigation',
    });
  }
}

/**
 * Helper function to start child on transactions. This function will make sure that the transaction will
 * use the start timestamp of the created child span if it is earlier than the transactions actual
 * start timestamp.
 */
export function _startChild(parent: Span, { startTimestamp, ...ctx }: SpanContext): Span {
  if (startTimestamp && parent.startTimestamp > startTimestamp) {
    parent.startTimestamp = startTimestamp;
  }

  return parent.startChild({
    startTimestamp,
    ...ctx,
  });
}
