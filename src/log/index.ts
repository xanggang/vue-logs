import globalOnErrorHandler from './globalOnErrorHandler';
import globalOnUnhandledRejectionHandler from './globalOnUnhandledRejectionHandler'
import { getFunctionName } from './util/utils'
import UA from 'ua-device'

interface  IErrorParams {
  msg: any;
  url: any;
  line: any;
  column: any;
  error: any;
}

type InstrumentHandlerType =
  | 'console'
  | 'dom'
  | 'fetch'
  | 'history'
  | 'sentry'
  | 'xhr'
  | 'error'
  | 'unhandledrejection';
type InstrumentHandlerCallback = (data: IErrorParams) => void;

type IHandlers = { [key in InstrumentHandlerType]?: InstrumentHandlerCallback[] };

interface InstrumentHandler {
  type: InstrumentHandlerType;
  callback: InstrumentHandlerCallback;
}

export default class LogSdk {
  public handlers: IHandlers = {}

  constructor() {
    this.addInstrumentationHandler({
      type: 'error',
      callback: globalOnErrorHandler
    })

    this.addInstrumentationHandler({
      type: 'unhandledrejection',
      callback: globalOnUnhandledRejectionHandler
    })
  }

  public addInstrumentationHandler(handler: InstrumentHandler) {
    if (!handler || typeof handler.type !== 'string' || typeof handler.callback !== 'function') {
      return;
    }

    this.handlers[handler.type] = this.handlers[handler.type] || [];
    (this.handlers[handler.type] as InstrumentHandlerCallback[]).push(handler.callback);
    this._instrument(handler.type);
  }

  private _instrument(type: InstrumentHandlerType) {
    switch (type) {
      case 'error':
        this.instrumentError();
        break;
      case 'unhandledrejection':
        this.instrumentUnhandledRejection();
        break;
    }
  }

  public instrumentError() {
    const _oldOnErrorHandler = window.onerror;
    const that = this
    window.onerror = function(msg: any, url: any, line: any, column: any, error: any): boolean {
      that.triggerHandlers('error', {msg, url, line, column, error});

      if (_oldOnErrorHandler) {
        return _oldOnErrorHandler.call(this, msg, url, line, column, error);
      }

      return false;
    };
  }

  public instrumentUnhandledRejection(): void {
    const _oldOnUnhandledRejectionHandler = window.onunhandledrejection;
    const that = this
    window.onunhandledrejection = function(e: any): boolean {
      that.triggerHandlers('unhandledrejection', e);

      if (_oldOnUnhandledRejectionHandler) {
        return _oldOnUnhandledRejectionHandler.apply(this, e);
      }

      return true;
    };
  }

  public triggerHandlers(type: InstrumentHandlerType, data: IErrorParams) {
    if (!type || !this.handlers[type]) {
      return;
    }

    for (const handler of this.handlers[type] || []) {
      try {
        handler(data);
      } catch (e) {
        console.error(
          `Error while triggering instrumentation handler.\nType: ${type}\nName: ${getFunctionName(
            handler,
          )}\nError: ${e}`,
        );
      }
    }
  }
}
