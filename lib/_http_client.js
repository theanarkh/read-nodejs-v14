// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  ArrayIsArray,
  Boolean,
  Error,
  NumberIsFinite,
  ObjectAssign,
  ObjectKeys,
  ObjectSetPrototypeOf,
} = primordials;

const net = require('net');
const url = require('url');
const assert = require('internal/assert');
const {
  _checkIsHttpToken: checkIsHttpToken,
  debug,
  freeParser,
  parsers,
  HTTPParser,
  isLenient,
  prepareError,
} = require('_http_common');
const { OutgoingMessage } = require('_http_outgoing');
const Agent = require('_http_agent');
const { Buffer } = require('buffer');
const { defaultTriggerAsyncIdScope } = require('internal/async_hooks');
const { URL, urlToOptions, searchParamsSymbol } = require('internal/url');
const { kOutHeaders, kNeedDrain } = require('internal/http');
const { connResetException, codes } = require('internal/errors');
const {
  ERR_HTTP_HEADERS_SENT,
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_HTTP_TOKEN,
  ERR_INVALID_PROTOCOL,
  ERR_UNESCAPED_CHARACTERS
} = codes;
const { validateInteger } = require('internal/validators');
const { getTimerDuration } = require('internal/timers');
const {
  DTRACE_HTTP_CLIENT_REQUEST,
  DTRACE_HTTP_CLIENT_RESPONSE
} = require('internal/dtrace');

const INVALID_PATH_REGEX = /[^\u0021-\u00ff]/;

function validateHost(host, name) {
  if (host !== null && host !== undefined && typeof host !== 'string') {
    throw new ERR_INVALID_ARG_TYPE(`options.${name}`,
                                   ['string', 'undefined', 'null'],
                                   host);
  }
  return host;
}

class HTTPClientAsyncResource {
  constructor(type, req) {
    this.type = type;
    this.req = req;
  }
}

let urlWarningEmitted = false;
function ClientRequest(input, options, cb) {
  OutgoingMessage.call(this);

  if (typeof input === 'string') {
    const urlStr = input;
    try {
      input = urlToOptions(new URL(urlStr));
    } catch (err) {
      input = url.parse(urlStr);
      if (!input.hostname) {
        throw err;
      }
      if (!urlWarningEmitted && !process.noDeprecation) {
        urlWarningEmitted = true;
        process.emitWarning(
          `The provided URL ${urlStr} is not a valid URL, and is supported ` +
          'in the http module solely for compatibility.',
          'DeprecationWarning', 'DEP0109');
      }
    }
  } else if (input && input[searchParamsSymbol] &&
             input[searchParamsSymbol][searchParamsSymbol]) {
    // url.URL instance
    input = urlToOptions(input);
  } else {
    cb = options;
    options = input;
    input = null;
  }

  if (typeof options === 'function') {
    cb = options;
    options = input || {};
  } else {
    options = ObjectAssign(input || {}, options);
  }
  // 是否使用agent
  let agent = options.agent;
  // 默认使用的agent
  const defaultAgent = options._defaultAgent || Agent.globalAgent;
  // false则新建一个agent
  if (agent === false) {
    agent = new defaultAgent.constructor();
  } else if (agent === null || agent === undefined) {
    // null或undefined则默认使用默认agent，如果用户传了createConnection则不使用agent，每次建立连接
    if (typeof options.createConnection !== 'function') {
      agent = defaultAgent;
    }
    // Explicitly pass through this statement as agent will not be used
    // when createConnection is provided.
  } else if (typeof agent.addRequest !== 'function') {// 使用传进来的agent，需要实现addRequest方法
    throw new ERR_INVALID_ARG_TYPE('options.agent',
                                   ['Agent-like Object', 'undefined', 'false'],
                                   agent);
  }
  this.agent = agent;

  const protocol = options.protocol || defaultAgent.protocol;
  let expectedProtocol = defaultAgent.protocol;
  if (this.agent && this.agent.protocol)
    expectedProtocol = this.agent.protocol;

  let path;
  if (options.path) {
    path = String(options.path);
    if (INVALID_PATH_REGEX.test(path))
      throw new ERR_UNESCAPED_CHARACTERS('Request path');
  }

  if (protocol !== expectedProtocol) {
    throw new ERR_INVALID_PROTOCOL(protocol, expectedProtocol);
  }

  const defaultPort = options.defaultPort ||
                    (this.agent && this.agent.defaultPort);

  const port = options.port = options.port || defaultPort || 80;
  const host = options.host = validateHost(options.hostname, 'hostname') ||
                            validateHost(options.host, 'host') || 'localhost';

  const setHost = (options.setHost === undefined || Boolean(options.setHost));

  this.socketPath = options.socketPath;
  // 建立连接的超时时间
  if (options.timeout !== undefined)
    this.timeout = getTimerDuration(options.timeout, 'timeout');

  let method = options.method;
  const methodIsString = (typeof method === 'string');
  if (method !== null && method !== undefined && !methodIsString) {
    throw new ERR_INVALID_ARG_TYPE('method', 'string', method);
  }

  if (methodIsString && method) {
    if (!checkIsHttpToken(method)) {
      throw new ERR_INVALID_HTTP_TOKEN('Method', method);
    }
    method = this.method = method.toUpperCase();
  } else {
    method = this.method = 'GET';
  }

  const maxHeaderSize = options.maxHeaderSize;
  if (maxHeaderSize !== undefined)
    validateInteger(maxHeaderSize, 'maxHeaderSize', 0);
  this.maxHeaderSize = maxHeaderSize;

  const insecureHTTPParser = options.insecureHTTPParser;
  if (insecureHTTPParser !== undefined &&
      typeof insecureHTTPParser !== 'boolean') {
    throw new ERR_INVALID_ARG_TYPE(
      'insecureHTTPParser', 'boolean', insecureHTTPParser);
  }
  this.insecureHTTPParser = insecureHTTPParser;

  this.path = options.path || '/';
  if (cb) {
    this.once('response', cb);
  }

  if (method === 'GET' ||
      method === 'HEAD' ||
      method === 'DELETE' ||
      method === 'OPTIONS' ||
      method === 'TRACE' ||
      method === 'CONNECT') {
    this.useChunkedEncodingByDefault = false;
  } else {
    this.useChunkedEncodingByDefault = true;
  }

  this._ended = false;
  this.res = null;
  this.aborted = false;
  this.timeoutCb = null;
  this.upgradeOrConnect = false;
  this.parser = null;
  this.maxHeadersCount = null;
  this.reusedSocket = false;

  let called = false;

  if (this.agent) {
    // If there is an agent we should default to Connection:keep-alive,
    // but only if the Agent will actually reuse the connection!
    // If it's not a keepAlive agent, and the maxSockets==Infinity, then
    // there's never a case where this socket will actually be reused
    if (!this.agent.keepAlive && !NumberIsFinite(this.agent.maxSockets)) {
      this._last = true;
      this.shouldKeepAlive = false;
    } else {
      this._last = false;
      this.shouldKeepAlive = true;
    }
  }

  const headersArray = ArrayIsArray(options.headers);
  // 不是数组
  if (!headersArray) {
    // 设置http头
    if (options.headers) {
      const keys = ObjectKeys(options.headers);
      // Retain for(;;) loop for performance reasons
      // Refs: https://github.com/nodejs/node/pull/30958
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        this.setHeader(key, options.headers[key]);
      }
    }
    // 设置host和端口
    if (host && !this.getHeader('host') && setHost) {
      let hostHeader = host;

      // For the Host header, ensure that IPv6 addresses are enclosed
      // in square brackets, as defined by URI formatting
      // https://tools.ietf.org/html/rfc3986#section-3.2.2
      const posColon = hostHeader.indexOf(':');
      if (posColon !== -1 &&
          hostHeader.includes(':', posColon + 1) &&
          hostHeader.charCodeAt(0) !== 91/* '[' */) {
        hostHeader = `[${hostHeader}]`;
      }

      if (port && +port !== defaultPort) {
        hostHeader += ':' + port;
      }
      this.setHeader('Host', hostHeader);
    }
    // 设置Authorization头
    if (options.auth && !this.getHeader('Authorization')) {
      this.setHeader('Authorization', 'Basic ' +
                     Buffer.from(options.auth).toString('base64'));
    }

    if (this.getHeader('expect')) {
      if (this._header) {
        throw new ERR_HTTP_HEADERS_SENT('render');
      }

      this._storeHeader(this.method + ' ' + this.path + ' HTTP/1.1\r\n',
                        this[kOutHeaders]);
    }
  } else {
    this._storeHeader(this.method + ' ' + this.path + ' HTTP/1.1\r\n',
                      options.headers);
  }

  const oncreate = (err, socket) => {
    if (called)
      return;
    called = true;
    if (err) {
      process.nextTick(() => this.emit('error', err));
      return;
    }
    this.onSocket(socket);
    // 连接成功后发送数据
    this._deferToConnect(null, null, () => this._flush());
  };

  // initiate connection
  if (this.agent) {
    this.agent.addRequest(this, options);
  } else {
    // No agent, default to Connection:close.
    this._last = true;
    this.shouldKeepAlive = false;
    if (typeof options.createConnection === 'function') {
      const newSocket = options.createConnection(options, oncreate);
      if (newSocket && !called) {
        called = true;
        this.onSocket(newSocket);
      } else {
        return;
      }
    } else {
      debug('CLIENT use net.createConnection', options);
      this.onSocket(net.createConnection(options));
    }
  }

  this._deferToConnect(null, null, () => this._flush());
}
ObjectSetPrototypeOf(ClientRequest.prototype, OutgoingMessage.prototype);
ObjectSetPrototypeOf(ClientRequest, OutgoingMessage);

ClientRequest.prototype._finish = function _finish() {
  DTRACE_HTTP_CLIENT_REQUEST(this, this.socket);
  OutgoingMessage.prototype._finish.call(this);
};
// 拼接http请求行和头到this._header
ClientRequest.prototype._implicitHeader = function _implicitHeader() {
  if (this._header) {
    throw new ERR_HTTP_HEADERS_SENT('render');
  }
  this._storeHeader(this.method + ' ' + this.path + ' HTTP/1.1\r\n',
                    this[kOutHeaders]);
};
// 终止请求
ClientRequest.prototype.abort = function abort() {
  if (!this.aborted) {
    process.nextTick(emitAbortNT, this);
  }
  this.aborted = true;

  // If we're aborting, we don't care about any more response data.
  // 如果已经在处理响应报文，则丢弃
  if (this.res) {
    this.res._dump();
  }

  // In the event that we don't have a socket, we will pop out of
  // the request queue through handling in onSocket.
  // 销毁socket
  if (this.socket) {
    // in-progress
    this.socket.destroy();
  }
};


function emitAbortNT(req) {
  req.emit('abort');
}

function ondrain() {
  // socket对应的请求对象 
  const msg = this._httpMessage;
  if (msg && !msg.finished && msg[kNeedDrain]) {
    msg[kNeedDrain] = false;
    msg.emit('drain');
  }
}

function socketCloseListener() {
  const socket = this;
  const req = socket._httpMessage;
  debug('HTTP socket close');

  // Pull through final chunk, if anything is buffered.
  // the ondata function will handle it properly, and this
  // is a no-op if no final chunk remains.
  socket.read();

  // NOTE: It's important to get parser here, because it could be freed by
  // the `socketOnData`.
  const parser = socket.parser;
  const res = req.res;
  if (res) {
    // Socket closed before we emitted 'end' below.
    if (!res.complete) {
      res.aborted = true;
      res.emit('aborted');
    }
    req.emit('close');
    if (!res.aborted && res.readable) {
      res.on('end', function() {
        this.emit('close');
      });
      res.push(null);
    } else {
      res.emit('close');
    }
  } else {
    if (!req.socket._hadError) {
      // This socket error fired before we started to
      // receive a response. The error needs to
      // fire on the request.
      req.socket._hadError = true;
      req.emit('error', connResetException('socket hang up'));
    }
    req.emit('close');
  }

  // Too bad.  That output wasn't getting written.
  // This is pretty terrible that it doesn't raise an error.
  // Fixed better in v0.10
  if (req.outputData)
    req.outputData.length = 0;

  if (parser) {
    parser.finish();
    freeParser(parser, req, socket);
  }
}

function socketErrorListener(err) {
  const socket = this;
  const req = socket._httpMessage;
  debug('SOCKET ERROR:', err.message, err.stack);

  if (req) {
    // For Safety. Some additional errors might fire later on
    // and we need to make sure we don't double-fire the error event.
    req.socket._hadError = true;
    req.emit('error', err);
  }

  const parser = socket.parser;
  if (parser) {
    parser.finish();
    freeParser(parser, req, socket);
  }

  // Ensure that no further data will come out of the socket
  socket.removeListener('data', socketOnData);
  socket.removeListener('end', socketOnEnd);
  socket.destroy();
}

function freeSocketErrorListener(err) {
  const socket = this;
  debug('SOCKET ERROR on FREE socket:', err.message, err.stack);
  socket.destroy();
  socket.emit('agentRemove');
}

function socketOnEnd() {
  const socket = this;
  const req = this._httpMessage;
  const parser = this.parser;

  if (!req.res && !req.socket._hadError) {
    // If we don't have a response then we know that the socket
    // ended prematurely and we need to emit an error on the request.
    req.socket._hadError = true;
    req.emit('error', connResetException('socket hang up'));
  }
  if (parser) {
    parser.finish();
    freeParser(parser, req, socket);
  }
  socket.destroy();
}
// 处理请求或响应报文的函数
function socketOnData(d) {
  const socket = this;
  const req = this._httpMessage;
  const parser = this.parser;

  assert(parser && parser.socket === socket);
  // 交给http解析器处理
  const ret = parser.execute(d);
  // 解析错误则触发error事件，销毁socket，释放http解析器
  if (ret instanceof Error) {
    prepareError(ret, parser, d);
    debug('parse error', ret);
    freeParser(parser, req, socket);
    socket.destroy();
    req.socket._hadError = true;
    req.emit('error', ret);
  } else if (parser.incoming && parser.incoming.upgrade) { // 请求是协议升级或connect方法
    // 升级协议，说明处理完响应头了
    // Upgrade (if status code 101) or CONNECT
    const bytesParsed = ret;
    const res = parser.incoming;
    req.res = res;

    socket.removeListener('data', socketOnData);
    socket.removeListener('end', socketOnEnd);
    socket.removeListener('drain', ondrain);
    // 响应了，移除超时事件
    if (req.timeoutCb)
      socket.removeListener('timeout', req.timeoutCb);

    parser.finish();
    freeParser(parser, req, socket);

    const bodyHead = d.slice(bytesParsed, d.length);

    const eventName = req.method === 'CONNECT' ? 'connect' : 'upgrade';
    if (req.listenerCount(eventName) > 0) {
      req.upgradeOrConnect = true;

      // detach the socket
      socket.emit('agentRemove');
      socket.removeListener('close', socketCloseListener);
      socket.removeListener('error', socketErrorListener);

      socket._httpMessage = null;
      socket.readableFlowing = null;

      req.emit(eventName, res, socket, bodyHead);
      req.emit('close');
    } else {
      // Requested Upgrade or used CONNECT method, but have no handler.
      socket.destroy();
    }
  } else if (parser.incoming && parser.incoming.complete &&
             // When the status code is informational (100, 102-199),
             // the server will send a final response after this client
             // sends a request body, so we must not free the parser.
             // 101 (Switching Protocols) and all other status codes
             // should be processed normally.
             !statusIsInformational(parser.incoming.statusCode)) {
    // 解析响应报文结束
    socket.removeListener('data', socketOnData);
    socket.removeListener('end', socketOnEnd);
    socket.removeListener('drain', ondrain);
    freeParser(parser, req, socket);
  }
}

function statusIsInformational(status) {
  // 100 (Continue)    RFC7231 Section 6.2.1
  // 102 (Processing)  RFC2518
  // 103 (Early Hints) RFC8297
  // 104-199 (Unassigned)
  return (status < 200 && status >= 100 && status !== 101);
}

// client
// 解析完http头的回调，返回值的意义见llhttp.c的llhttp__on_headers_complete(state, p, endp)
function parserOnIncomingClient(res, shouldKeepAlive) {
  const socket = this.socket;
  // 请求对象
  const req = socket._httpMessage;

  debug('AGENT incoming response!');

  if (req.res) {
    // We already have a response object, this means the server
    // sent a double response.
    socket.destroy();
    return 0;  // No special treatment.
  }
  req.res = res;

  // Skip body and treat as Upgrade.
  if (res.upgrade)
    return 2;

  // Responses to CONNECT request is handled as Upgrade.
  const method = req.method;
  if (method === 'CONNECT') {
    res.upgrade = true;
    return 2;  // Skip body and treat as Upgrade.
  }

  if (statusIsInformational(res.statusCode)) {
    // Restart the parser, as this is a 1xx informational message.
    req.res = null; // Clear res so that we don't hit double-responses.
    // Maintain compatibility by sending 100-specific events
    if (res.statusCode === 100) {
      req.emit('continue');
    }
    // Send information events to all 1xx responses except 101 Upgrade.
    req.emit('information', {
      statusCode: res.statusCode,
      statusMessage: res.statusMessage,
      httpVersion: res.httpVersion,
      httpVersionMajor: res.httpVersionMajor,
      httpVersionMinor: res.httpVersionMinor,
      headers: res.headers,
      rawHeaders: res.rawHeaders
    });

    return 1;  // Skip body but don't treat as Upgrade.
  }

  if (req.shouldKeepAlive && !shouldKeepAlive && !req.upgradeOrConnect) {
    // Server MUST respond with Connection:keep-alive for us to enable it.
    // If we've been upgraded (via WebSockets) we also shouldn't try to
    // keep the connection open.
    req.shouldKeepAlive = false;
  }

  DTRACE_HTTP_CLIENT_RESPONSE(socket, req);
  req.res = res;
  res.req = req;

  // Add our listener first, so that we guarantee socket cleanup
  // 等待响应结束
  res.on('end', responseOnEnd);
  req.on('prefinish', requestOnPrefinish);

  // If the user did not listen for the 'response' event, then they
  // can't possibly read the data, so we ._dump() it into the void
  // so that the socket doesn't hang there in a paused state.
  // 请求终止了或触发response事件，返回false说明没有监听response事件，则丢弃数据
  if (req.aborted || !req.emit('response', res))
    res._dump();

  if (method === 'HEAD')
    return 1;  // Skip body but don't treat as Upgrade.

  return 0;  // No special treatment.
}

// client
function responseKeepAlive(req) {
  const socket = req.socket;

  debug('AGENT socket keep-alive');
  if (req.timeoutCb) {
    socket.setTimeout(0, req.timeoutCb);
    req.timeoutCb = null;
  }
  socket.removeListener('close', socketCloseListener);
  socket.removeListener('error', socketErrorListener);
  socket.removeListener('data', socketOnData);
  socket.removeListener('end', socketOnEnd);
  socket.once('error', freeSocketErrorListener);
  // There are cases where _handle === null. Avoid those. Passing null to
  // nextTick() will call getDefaultTriggerAsyncId() to retrieve the id.
  const asyncId = socket._handle ? socket._handle.getAsyncId() : undefined;
  // Mark this socket as available, AFTER user-added end
  // handlers have a chance to run.
  defaultTriggerAsyncIdScope(asyncId, process.nextTick, emitFreeNT, req);
}
// 响应结束的回调
function responseOnEnd() {
  const req = this.req;
  // 移除定时器，因为已经响应完成了
  if (req.socket && req.timeoutCb) {
    req.socket.removeListener('timeout', emitRequestTimeout);
  }

  req._ended = true;
  // 不是长连接，则关闭socket
  if (!req.shouldKeepAlive) {
    const socket = req.socket;
    if (socket.writable) {
      debug('AGENT socket.destroySoon()');
      if (typeof socket.destroySoon === 'function')
        socket.destroySoon();
      else
        socket.end();
    }
    assert(!socket.writable);
  } else if (req.finished && !this.aborted) {
    // We can assume `req.finished` means all data has been written since:
    // - `'responseOnEnd'` means we have been assigned a socket.
    // - when we have a socket we write directly to it without buffering.
    // - `req.finished` means `end()` has been called and no further data.
    //   can be written
    responseKeepAlive(req);
  }
}

function requestOnPrefinish() {
  const req = this;

  if (req.shouldKeepAlive && req._ended)
    responseKeepAlive(req);
}

function emitFreeNT(req) {
  req.emit('close');
  if (req.res) {
    req.res.emit('close');
  }

  if (req.socket) {
    req.socket.emit('free');
  }
}
// 初始化http解析器和注册data事件等，等待响应
function tickOnSocket(req, socket) {
  // 分配一个http解析器
  const parser = parsers.alloc();
  req.socket = socket;
  // 初始化，处理响应报文
  parser.initialize(HTTPParser.RESPONSE,
                    new HTTPClientAsyncResource('HTTPINCOMINGMESSAGE', req),
                    req.maxHeaderSize || 0,
                    req.insecureHTTPParser === undefined ?
                      isLenient() : req.insecureHTTPParser);
  parser.socket = socket;
  parser.outgoing = req;
  req.parser = parser;

  socket.parser = parser;
  // socket正处理的请求
  socket._httpMessage = req;

  // Propagate headers limit from request object to parser
  if (typeof req.maxHeadersCount === 'number') {
    parser.maxHeaderPairs = req.maxHeadersCount << 1;
  }
  // 解析完http头部的回调
  parser.onIncoming = parserOnIncomingClient;
  socket.removeListener('error', freeSocketErrorListener);
  socket.on('error', socketErrorListener);
  socket.on('data', socketOnData);
  socket.on('end', socketOnEnd);
  socket.on('close', socketCloseListener);
  socket.on('drain', ondrain);

  if (
    req.timeout !== undefined ||
    (req.agent && req.agent.options && req.agent.options.timeout)
  ) {
    // 处理超时时间
    listenSocketTimeout(req);
  }
  req.emit('socket', socket);
}

function emitRequestTimeout() {
  const req = this._httpMessage;
  if (req) {
    req.emit('timeout');
  }
}
// 设置socket超时时间，即响应的时间
function listenSocketTimeout(req) {
  // 设置过了则返回
  if (req.timeoutCb) {
    return;
  }
  // Set timeoutCb so it will get cleaned up on request end.
  // 超时回调
  req.timeoutCb = emitRequestTimeout;
  // Delegate socket timeout event.
  // 设置socket的超时时间，即socket上一定时间后没有响应则触发超时
  if (req.socket) {
    req.socket.once('timeout', emitRequestTimeout);
  } else {
    req.on('socket', (socket) => {
      socket.once('timeout', emitRequestTimeout);
    });
  }
}
// socket可用时的回调
ClientRequest.prototype.onSocket = function onSocket(socket) {
  process.nextTick(onSocketNT, this, socket);
};

function onSocketNT(req, socket) {
  // 申请socket过程中，请求已经终止
  if (req.aborted) {
    // If we were aborted while waiting for a socket, skip the whole thing.
    // 不使用agent，直接销毁socekt
    if (!req.agent) {
      socket.destroy();
    } else {
      // 使用agent触发free事件，由agent处理socekt
      req.emit('close');
      socket.emit('free');
    }
  } else {
    // 处理socket
    tickOnSocket(req, socket);
  }
}
// 延迟执行某函数，其实在net已经有相关的处理了
ClientRequest.prototype._deferToConnect = _deferToConnect;
function _deferToConnect(method, arguments_, cb) {
  // This function is for calls that need to happen once the socket is
  // assigned to this request and writable. It's an important promisy
  // thing for all the socket calls that happen either now
  // (when a socket is assigned) or in the future (when a socket gets
  // assigned out of the pool and is eventually writable).

  const callSocketMethod = () => {
    if (method)
      this.socket[method].apply(this.socket, arguments_);

    if (typeof cb === 'function')
      cb();
  };

  const onSocket = () => {
    // 可写了（连接成功）则执行某函数，否则等待socket连接成功后执行
    if (this.socket.writable) {
      callSocketMethod();
    } else {
      this.socket.once('connect', callSocketMethod);
    }
  };
  // 还没有可用socket则等待，否则进一步判断socket状态
  if (!this.socket) {
    this.once('socket', onSocket);
  } else {
    onSocket();
  }
}
// 设置请求对应响应的超时时间
ClientRequest.prototype.setTimeout = function setTimeout(msecs, callback) {
  if (this._ended) {
    return this;
  }
  // 监听socket的超时事件
  listenSocketTimeout(this);
  msecs = getTimerDuration(msecs, 'msecs');
  if (callback) this.once('timeout', callback);
  // 设置socket的超时时间
  if (this.socket) {
    setSocketTimeout(this.socket, msecs);
  } else {
    this.once('socket', (sock) => setSocketTimeout(sock, msecs));
  }

  return this;
};
// 设置socket的超时时间
function setSocketTimeout(sock, msecs) {
  if (sock.connecting) {
    sock.once('connect', function() {
      sock.setTimeout(msecs);
    });
  } else {
    sock.setTimeout(msecs);
  }
}

ClientRequest.prototype.setNoDelay = function setNoDelay(noDelay) {
  this._deferToConnect('setNoDelay', [noDelay]);
};

ClientRequest.prototype.setSocketKeepAlive =
    function setSocketKeepAlive(enable, initialDelay) {
      this._deferToConnect('setKeepAlive', [enable, initialDelay]);
    };

ClientRequest.prototype.clearTimeout = function clearTimeout(cb) {
  this.setTimeout(0, cb);
};

module.exports = {
  ClientRequest
};
