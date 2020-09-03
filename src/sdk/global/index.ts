import traceKit, { StackTrace } from 'tracekit'
import request from '../util/request'
import getBrowserInfo from '../util/getBrowserInfo'
import { VueConstructor } from 'vue'

class GlobalError {
  constructor(vue: VueConstructor) {
    traceKit.report.subscribe(stackTrace => {
      console.log(stackTrace);
      this.addEventListener(stackTrace)
    });
    vue.config.errorHandler = function (e) {
      traceKit.report(e)
    }
  }

  public send(stackTrace: StackTrace) {
    request(Object.assign(stackTrace, {browser: getBrowserInfo()}))
  }

  public addEventListener(stackTrace: StackTrace) {
    const _oldOnErrorHandler = window.onerror;
    window.onerror = (msg: any, url: any, line: any, column: any, error: any): void => {
      this.send(stackTrace)
      if (_oldOnErrorHandler) {
        return _oldOnErrorHandler.call(this, msg, url, line, column, error);
      }
    };
  }

  public addListenerVue(vue: VueConstructor) {
    const _oldOnErrorHandler = vue.config.errorHandler

  }
}

export default GlobalError
