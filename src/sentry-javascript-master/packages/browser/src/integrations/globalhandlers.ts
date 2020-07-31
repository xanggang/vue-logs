import { getCurrentHub } from '@sentry/core';
import { Event, Integration, Severity } from '@sentry/types';
import {
  addExceptionMechanism,
  addInstrumentationHandler,
  getLocationHref,
  isErrorEvent,
  isPrimitive,
  isString,
  logger,
} from '@sentry/utils';

import { eventFromUnknownInput } from '../eventbuilder';
import { shouldIgnoreOnError } from '../helpers';

/** JSDoc */
interface GlobalHandlersIntegrations {
  onerror: boolean;
  onunhandledrejection: boolean;
}

/** Global handlers */
export class GlobalHandlers implements Integration {
  /**
   * @inheritDoc
   */
  public name: string = GlobalHandlers.id;

  /**
   * @inheritDoc
   */
  public static id: string = 'GlobalHandlers';

  /** JSDoc */
  private readonly _options: GlobalHandlersIntegrations;

  /** JSDoc */
  private _onErrorHandlerInstalled: boolean = false;

  /** JSDoc */
  private _onUnhandledRejectionHandlerInstalled: boolean = false;

  /** JSDoc */
  public constructor(options?: GlobalHandlersIntegrations) {
    this._options = {
      onerror: true,
      onunhandledrejection: true,
      ...options,
    };
  }
  /**
   * @inheritDoc
   */
  public setupOnce(): void {
    Error.stackTraceLimit = 50;

    if (this._options.onerror) {
      logger.log('Global Handler attached: onerror');
      // 全局注册onerror事件
      this._installGlobalOnErrorHandler();
    }

    if (this._options.onunhandledrejection) {
      // 全局注册primise事件
      logger.log('Global Handler attached: onunhandledrejection');
      this._installGlobalOnUnhandledRejectionHandler();
    }
  }

  /** JSDoc */
  private _installGlobalOnErrorHandler(): void {
    if (this._onErrorHandlerInstalled) {
      return;
    }

    // 将事件处理函数保存在一个list里， 并且改写onerror事件， 有限触发callback之后在触发其他绑定的onerror事件
    addInstrumentationHandler({
      callback: (data: { msg: any; url: any; line: any; column: any; error: any }) => {
        const error = data.error;
        const currentHub = getCurrentHub();
        const hasIntegration = currentHub.getIntegration(GlobalHandlers);
        const isFailedOwnDelivery = error && error.__sentry_own_request__ === true;

        // 服务地址不存在， 或者超出错误次数， 或者该错误已经发送成功
        if (!hasIntegration || shouldIgnoreOnError() || isFailedOwnDelivery) {
          return;
        }

        const client = currentHub.getClient();
        const event = isPrimitive(error) //非error类型的错误
          ? this._eventFromIncompleteOnError(data.msg, data.url, data.line, data.column)
          : this._enhanceEventWithInitialFrame(
              eventFromUnknownInput(error, undefined, {
                attachStacktrace: client && client.getOptions().attachStacktrace,
                rejection: false,
              }),
              data.url,
              data.line,
              data.column,
            );

        addExceptionMechanism(event, {
          handled: false,
          type: 'onerror',
        });

        currentHub.captureEvent(event, {
          originalException: error,
        });
      },
      type: 'error',
    });

    this._onErrorHandlerInstalled = true;
  }

  /** JSDoc */
  private _installGlobalOnUnhandledRejectionHandler(): void {
    if (this._onUnhandledRejectionHandlerInstalled) {
      return;
    }

    addInstrumentationHandler({
      callback: (e: any) => {
        let error = e;

        // dig the object of the rejection out of known event types
        try {
          // PromiseRejectionEvents store the object of the rejection under 'reason'
          // see https://developer.mozilla.org/en-US/docs/Web/API/PromiseRejectionEvent
          if ('reason' in e) {
            error = e.reason;
          }
          // something, somewhere, (likely a browser extension) effectively casts PromiseRejectionEvents
          // to CustomEvents, moving the `promise` and `reason` attributes of the PRE into
          // the CustomEvent's `detail` attribute, since they're not part of CustomEvent's spec
          // see https://developer.mozilla.org/en-US/docs/Web/API/CustomEvent and
          // https://github.com/getsentry/sentry-javascript/issues/2380
          else if ('detail' in e && 'reason' in e.detail) {
            error = e.detail.reason;
          }
        } catch (_oO) {
          // no-empty
        }

        const currentHub = getCurrentHub();
        const hasIntegration = currentHub.getIntegration(GlobalHandlers);
        const isFailedOwnDelivery = error && error.__sentry_own_request__ === true;

        if (!hasIntegration || shouldIgnoreOnError() || isFailedOwnDelivery) {
          return true;
        }

        const client = currentHub.getClient();
        const event = isPrimitive(error)
          ? this._eventFromIncompleteRejection(error)
          : eventFromUnknownInput(error, undefined, {
              attachStacktrace: client && client.getOptions().attachStacktrace,
              rejection: true,
            });

        event.level = Severity.Error;

        addExceptionMechanism(event, {
          handled: false,
          type: 'onunhandledrejection',
        });

        currentHub.captureEvent(event, {
          originalException: error,
        });

        return;
      },
      type: 'unhandledrejection',
    });

    this._onUnhandledRejectionHandlerInstalled = true;
  }

  /**
   * This function creates a stack from an old, error-less onerror handler.
   */
  private _eventFromIncompleteOnError(msg: any, url: any, line: any, column: any): Event {
    const ERROR_TYPES_RE = /^(?:[Uu]ncaught (?:exception: )?)?(?:((?:Eval|Internal|Range|Reference|Syntax|Type|URI|)Error): )?(.*)$/i;

    // If 'message' is ErrorEvent, get real message from inside
    // 如果是错误事件， 则取msg， 否则直接展示
    let message = isErrorEvent(msg) ? msg.message : msg;
    let name;

    if (isString(message)) {
      const groups = message.match(ERROR_TYPES_RE);
      if (groups) {
        name = groups[1];
        message = groups[2];
      }
    }

    const event = {
      exception: {
        values: [
          {
            type: name || 'Error',
            value: message,
          },
        ],
      },
    };

    return this._enhanceEventWithInitialFrame(event, url, line, column);
  }

  /**
   * This function creates an Event from an TraceKitStackTrace that has part of it missing.
   */
  private _eventFromIncompleteRejection(error: any): Event {
    return {
      exception: {
        values: [
          {
            type: 'UnhandledRejection',
            value: `Non-Error promise rejection captured with value: ${error}`,
          },
        ],
      },
    };
  }

  /** JSDoc */
  private _enhanceEventWithInitialFrame(event: Event, url: any, line: any, column: any): Event {
    event.exception = event.exception || {};
    event.exception.values = event.exception.values || [];
    event.exception.values[0] = event.exception.values[0] || {};
    event.exception.values[0].stacktrace = event.exception.values[0].stacktrace || {};
    event.exception.values[0].stacktrace.frames = event.exception.values[0].stacktrace.frames || [];

    const colno = isNaN(parseInt(column, 10)) ? undefined : column;
    const lineno = isNaN(parseInt(line, 10)) ? undefined : line;
    const filename = isString(url) && url.length > 0 ? url : getLocationHref();

    if (event.exception.values[0].stacktrace.frames.length === 0) {
      event.exception.values[0].stacktrace.frames.push({
        colno,
        filename,
        function: '?',
        in_app: true,
        lineno,
      });
    }

    return event;
  }
}
