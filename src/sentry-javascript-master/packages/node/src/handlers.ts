import { Span } from '@sentry/apm';
import { captureException, getCurrentHub, startTransaction, withScope } from '@sentry/core';
import { Event } from '@sentry/types';
import { forget, isPlainObject, isString, logger, normalize } from '@sentry/utils';
import * as cookie from 'cookie';
import * as domain from 'domain';
import * as http from 'http';
import * as os from 'os';
import * as url from 'url';

import { NodeClient } from './client';
import { flush } from './sdk';

const DEFAULT_SHUTDOWN_TIMEOUT = 2000;

/**
 * Express compatible tracing handler.
 * @see Exposed as `Handlers.tracingHandler`
 */
export function tracingHandler(): (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: (error?: any) => void,
) => void {
  return function sentryTracingMiddleware(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: (error?: any) => void,
  ): void {
    // TODO: At this point req.route.path we use in `extractTransaction` is not available
    // but `req.path` or `req.url` should do the job as well. We could unify this here.
    const reqMethod = (req.method || '').toUpperCase();
    const reqUrl = req.url;

    let traceId;
    let parentSpanId;
    let sampled;

    // If there is a trace header set, we extract the data from it and set the span on the scope
    // to be the origin an created transaction set the parent_span_id / trace_id
    if (req.headers && isString(req.headers['sentry-trace'])) {
      const span = Span.fromTraceparent(req.headers['sentry-trace'] as string);
      if (span) {
        traceId = span.traceId;
        parentSpanId = span.parentSpanId;
        sampled = span.sampled;
      }
    }

    const transaction = startTransaction({
      name: `${reqMethod} ${reqUrl}`,
      op: 'http.server',
      parentSpanId,
      sampled,
      traceId,
    });

    // We put the transaction on the scope so users can attach children to it
    getCurrentHub().configureScope(scope => {
      scope.setSpan(transaction);
    });

    // We also set __sentry_transaction on the response so people can grab the transaction there to add
    // spans to it later.
    (res as any).__sentry_transaction = transaction;

    res.once('finish', () => {
      transaction.setHttpStatus(res.statusCode);
      transaction.finish();
    });

    next();
  };
}

type TransactionTypes = 'path' | 'methodPath' | 'handler';

/** JSDoc */
function extractTransaction(req: { [key: string]: any }, type: boolean | TransactionTypes): string | undefined {
  try {
    // Express.js shape
    const request = req as {
      url: string;
      originalUrl: string;
      method: string;
      route: {
        path: string;
        stack: [
          {
            name: string;
          },
        ];
      };
    };

    let routePath;
    try {
      routePath = url.parse(request.originalUrl || request.url).pathname;
    } catch (_oO) {
      routePath = request.route.path;
    }

    switch (type) {
      case 'path': {
        return routePath;
      }
      case 'handler': {
        return request.route.stack[0].name;
      }
      case 'methodPath':
      default: {
        const method = request.method.toUpperCase();
        return `${method}|${routePath}`;
      }
    }
  } catch (_oO) {
    return undefined;
  }
}

/** Default request keys that'll be used to extract data from the request */
const DEFAULT_REQUEST_KEYS = ['cookies', 'data', 'headers', 'method', 'query_string', 'url'];

/** JSDoc */
function extractRequestData(req: { [key: string]: any }, keys: boolean | string[]): { [key: string]: string } {
  const request: { [key: string]: any } = {};
  const attributes = Array.isArray(keys) ? keys : DEFAULT_REQUEST_KEYS;

  // headers:
  //   node, express: req.headers
  //   koa: req.header
  const headers = (req.headers || req.header || {}) as {
    host?: string;
    cookie?: string;
  };
  // method:
  //   node, express, koa: req.method
  const method = req.method;
  // host:
  //   express: req.hostname in > 4 and req.host in < 4
  //   koa: req.host
  //   node: req.headers.host
  const host = req.hostname || req.host || headers.host || '<no host>';
  // protocol:
  //   node: <n/a>
  //   express, koa: req.protocol
  const protocol =
    req.protocol === 'https' || req.secure || ((req.socket || {}) as { encrypted?: boolean }).encrypted
      ? 'https'
      : 'http';
  // url (including path and query string):
  //   node, express: req.originalUrl
  //   koa: req.url
  const originalUrl = (req.originalUrl || req.url) as string;
  // absolute url
  const absoluteUrl = `${protocol}://${host}${originalUrl}`;

  attributes.forEach(key => {
    switch (key) {
      case 'headers':
        request.headers = headers;
        break;
      case 'method':
        request.method = method;
        break;
      case 'url':
        request.url = absoluteUrl;
        break;
      case 'cookies':
        // cookies:
        //   node, express, koa: req.headers.cookie
        request.cookies = cookie.parse(headers.cookie || '');
        break;
      case 'query_string':
        // query string:
        //   node: req.url (raw)
        //   express, koa: req.query
        request.query_string = url.parse(originalUrl || '', false).query;
        break;
      case 'data':
        if (method === 'GET' || method === 'HEAD') {
          break;
        }
        // body data:
        //   node, express, koa: req.body
        if (req.body !== undefined) {
          request.data = isString(req.body) ? req.body : JSON.stringify(normalize(req.body));
        }
        break;
      default:
        if ({}.hasOwnProperty.call(req, key)) {
          request[key] = (req as { [key: string]: any })[key];
        }
    }
  });

  return request;
}

/** Default user keys that'll be used to extract data from the request */
const DEFAULT_USER_KEYS = ['id', 'username', 'email'];

/** JSDoc */
function extractUserData(
  user: {
    [key: string]: any;
  },
  keys: boolean | string[],
): { [key: string]: any } {
  const extractedUser: { [key: string]: any } = {};
  const attributes = Array.isArray(keys) ? keys : DEFAULT_USER_KEYS;

  attributes.forEach(key => {
    if (user && key in user) {
      extractedUser[key] = user[key];
    }
  });

  return extractedUser;
}

/**
 * Options deciding what parts of the request to use when enhancing an event
 */
interface ParseRequestOptions {
  ip?: boolean;
  request?: boolean | string[];
  serverName?: boolean;
  transaction?: boolean | TransactionTypes;
  user?: boolean | string[];
  version?: boolean;
}

/**
 * Enriches passed event with request data.
 *
 * @param event Will be mutated and enriched with req data
 * @param req Request object
 * @param options object containing flags to enable functionality
 * @hidden
 */
export function parseRequest(
  event: Event,
  req: {
    [key: string]: any;
    user?: {
      [key: string]: any;
    };
    ip?: string;
    connection?: {
      remoteAddress?: string;
    };
  },
  options?: ParseRequestOptions,
): Event {
  // tslint:disable-next-line:no-parameter-reassignment
  options = {
    ip: false,
    request: true,
    serverName: true,
    transaction: true,
    user: true,
    version: true,
    ...options,
  };

  if (options.version) {
    event.contexts = {
      ...event.contexts,
      runtime: {
        name: 'node',
        version: global.process.version,
      },
    };
  }

  if (options.request) {
    event.request = {
      ...event.request,
      ...extractRequestData(req, options.request),
    };
  }

  if (options.serverName && !event.server_name) {
    event.server_name = global.process.env.SENTRY_NAME || os.hostname();
  }

  if (options.user) {
    const extractedUser = req.user && isPlainObject(req.user) ? extractUserData(req.user, options.user) : {};

    if (Object.keys(extractedUser)) {
      event.user = {
        ...event.user,
        ...extractedUser,
      };
    }
  }

  // client ip:
  //   node: req.connection.remoteAddress
  //   express, koa: req.ip
  if (options.ip) {
    const ip = req.ip || (req.connection && req.connection.remoteAddress);
    if (ip) {
      event.user = {
        ...event.user,
        ip_address: ip,
      };
    }
  }

  if (options.transaction && !event.transaction) {
    const transaction = extractTransaction(req, options.transaction);
    if (transaction) {
      event.transaction = transaction;
    }
  }

  return event;
}

/**
 * Express compatible request handler.
 * @see Exposed as `Handlers.requestHandler`
 */
export function requestHandler(
  options?: ParseRequestOptions & {
    flushTimeout?: number;
  },
): (req: http.IncomingMessage, res: http.ServerResponse, next: (error?: any) => void) => void {
  return function sentryRequestMiddleware(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: (error?: any) => void,
  ): void {
    if (options && options.flushTimeout && options.flushTimeout > 0) {
      // tslint:disable-next-line: no-unbound-method
      const _end = res.end;
      res.end = function(chunk?: any | (() => void), encoding?: string | (() => void), cb?: () => void): void {
        flush(options.flushTimeout)
          .then(() => {
            _end.call(this, chunk, encoding, cb);
          })
          .then(null, e => {
            logger.error(e);
          });
      };
    }
    const local = domain.create();
    local.add(req);
    local.add(res);
    local.on('error', next);
    local.run(() => {
      getCurrentHub().configureScope(scope =>
        scope.addEventProcessor((event: Event) => parseRequest(event, req, options)),
      );
      next();
    });
  };
}

/** JSDoc */
interface MiddlewareError extends Error {
  status?: number | string;
  statusCode?: number | string;
  status_code?: number | string;
  output?: {
    statusCode?: number | string;
  };
}

/** JSDoc */
function getStatusCodeFromResponse(error: MiddlewareError): number {
  const statusCode = error.status || error.statusCode || error.status_code || (error.output && error.output.statusCode);
  return statusCode ? parseInt(statusCode as string, 10) : 500;
}

/** Returns true if response code is internal server error */
function defaultShouldHandleError(error: MiddlewareError): boolean {
  const status = getStatusCodeFromResponse(error);
  return status >= 500;
}

/**
 * Express compatible error handler.
 * @see Exposed as `Handlers.errorHandler`
 */
export function errorHandler(options?: {
  /**
   * Callback method deciding whether error should be captured and sent to Sentry
   * @param error Captured middleware error
   */
  shouldHandleError?(error: MiddlewareError): boolean;
}): (
  error: MiddlewareError,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: (error: MiddlewareError) => void,
) => void {
  return function sentryErrorMiddleware(
    error: MiddlewareError,
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    next: (error: MiddlewareError) => void,
  ): void {
    const shouldHandleError = (options && options.shouldHandleError) || defaultShouldHandleError;

    if (shouldHandleError(error)) {
      withScope(_scope => {
        // For some reason we need to set the transaction on the scope again
        const transaction = (res as any).__sentry_transaction as Span;
        if (transaction && _scope.getSpan() === undefined) {
          _scope.setSpan(transaction);
        }
        const eventId = captureException(error);
        (res as any).sentry = eventId;
        next(error);
      });

      return;
    }

    next(error);
  };
}

/**
 * @hidden
 */
export function logAndExitProcess(error: Error): void {
  console.error(error && error.stack ? error.stack : error);

  const client = getCurrentHub().getClient<NodeClient>();

  if (client === undefined) {
    logger.warn('No NodeClient was defined, we are exiting the process now.');
    global.process.exit(1);
    return;
  }

  const options = client.getOptions();
  const timeout =
    (options && options.shutdownTimeout && options.shutdownTimeout > 0 && options.shutdownTimeout) ||
    DEFAULT_SHUTDOWN_TIMEOUT;
  forget(
    client.close(timeout).then((result: boolean) => {
      if (!result) {
        logger.warn('We reached the timeout for emptying the request buffer, still exiting now!');
      }
      global.process.exit(1);
    }),
  );
}
