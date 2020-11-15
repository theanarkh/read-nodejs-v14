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
  ObjectKeys,
  ObjectSetPrototypeOf,
  ObjectValues,
  Symbol,
} = primordials;

const net = require('net');
const EventEmitter = require('events');
const debug = require('internal/util/debuglog').debuglog('http');
const { async_id_symbol } = require('internal/async_hooks').symbols;
const {
  codes: {
    ERR_INVALID_ARG_TYPE,
  },
} = require('internal/errors');
const kOnKeylog = Symbol('onkeylog');
// New Agent code.

// The largest departure from the previous implementation is that
// an Agent instance holds connections for a variable number of host:ports.
// Surprisingly, this is still API compatible as far as third parties are
// concerned. The only code that really notices the difference is the
// request object.

// Another departure is that all code related to HTTP parsing is in
// ClientRequest.onSocket(). The Agent is now *strictly*
// concerned with managing a connection pool.

const kReusedHandle = Symbol('kReusedHandle');
class ReusedHandle {
  constructor(type, handle) {
    this.type = type;
    this.handle = handle;
    // We need keep the resource object alive from this object, because
    // domains rely on GC of the resource object for lifetime tracking.
    // TODO(addaleax): This should really apply to all uses of
    // AsyncWrap::AsyncReset() when the resource is not the AsyncWrap object
    // itself. However, HTTPClientAsyncResource and HTTPServerAsyncResource
    // hold on to other objects, inhibiting GC.
    handle[kReusedHandle] = this;
  }
}

function Agent(options) {
  if (!(this instanceof Agent))
    return new Agent(options);

  EventEmitter.call(this);

  this.defaultPort = 80;
  this.protocol = 'http:';

  this.options = { ...options };

  // Don't confuse net and make it think that we're connecting to a pipe
  // path字段表示是本机的进程间通信时使用的路径，置null
  this.options.path = null;
  // socket个数达到阈值，等待socket的请求
  this.requests = {};
  // 正在使用的socket
  this.sockets = {};
  // 空闲socket
  this.freeSockets = {};
  // 空闲socket的存活时间
  this.keepAliveMsecs = this.options.keepAliveMsecs || 1000;
  /*
    用完的socket是否放到空闲队列，
      开启keepalive才会放到空闲队列，
      不开启keepalive
        还有等待socket的请求则复用socket
        没有等待socket的请求则直接销毁socket
  */
  this.keepAlive = this.options.keepAlive || false;
  // 最大的socket个数，包括正在使用的和空闲的socket
  this.maxSockets = this.options.maxSockets || Agent.defaultMaxSockets;
  // 最大的空闲socket个数
  this.maxFreeSockets = this.options.maxFreeSockets || 256;
  // 监听socket空闲事件
  this.on('free', (socket, options) => {
    const name = this.getName(options);
    debug('agent.on(free)', name);
    // socket还可写并且还有等待socket的请求，则复用socket
    if (socket.writable &&
        this.requests[name] && this.requests[name].length) {
      // 拿到一个等待socket的请求，然后通知他有socket可用
      const req = this.requests[name].shift();
      setRequestSocket(this, req, socket);
      // 没有等待socket的请求则删除，防止内存泄漏
      if (this.requests[name].length === 0) {
        // don't leak
        delete this.requests[name];
      }
    } else {
      // If there are no pending requests, then put it in
      // the freeSockets pool, but only if we're allowed to do so.
      // socket不可用写或者没有等待socket的请求了
      const req = socket._httpMessage;
      // socket可写并且请求设置了允许使用复用的socket
      if (req &&
          req.shouldKeepAlive &&
          socket.writable &&
          this.keepAlive) {
        let freeSockets = this.freeSockets[name];
        // 该key下当前的空闲socket个数
        const freeLen = freeSockets ? freeSockets.length : 0;
        let count = freeLen;
        // 正在使用的socket个数
        if (this.sockets[name])
          count += this.sockets[name].length;
        // 该key使用的socket个数达到阈值或者空闲socket达到阈值，则不复用socket，直接销毁socket
        if (count > this.maxSockets || freeLen >= this.maxFreeSockets) {
          socket.destroy();
        } else if (this.keepSocketAlive(socket)) { // 重新设置socket的存活时间，设置失败说明无法重新设置存活时间，则说明可能不支持复用
          freeSockets = freeSockets || [];
          this.freeSockets[name] = freeSockets;
          socket[async_id_symbol] = -1;
          socket._httpMessage = null;
          // 把socket从正在使用队列中移除
          this.removeSocket(socket, options);
          // 插入socket空闲队列
          freeSockets.push(socket);
        } else {
          // Implementation doesn't want to keep socket alive
          // 不复用则直接销毁
          socket.destroy();
        }
      } else {
        socket.destroy();
      }
    }
  });

  // Don't emit keylog events unless there is a listener for them.
  this.on('newListener', maybeEnableKeylog);
}
ObjectSetPrototypeOf(Agent.prototype, EventEmitter.prototype);
ObjectSetPrototypeOf(Agent, EventEmitter);

function maybeEnableKeylog(eventName) {
  if (eventName === 'keylog') {
    this.removeListener('newListener', maybeEnableKeylog);
    // Future sockets will listen on keylog at creation.
    const agent = this;
    this[kOnKeylog] = function onkeylog(keylog) {
      agent.emit('keylog', keylog, this);
    };
    // Existing sockets will start listening on keylog now.
    for (const socket of ObjectValues(this.sockets)) {
      socket.on('keylog', this[kOnKeylog]);
    }
  }
}

Agent.defaultMaxSockets = Infinity;

Agent.prototype.createConnection = net.createConnection;

// Get the key for a given set of request options
// 一个请求对应的key
Agent.prototype.getName = function getName(options) {
  let name = options.host || 'localhost';

  name += ':';
  if (options.port)
    name += options.port;

  name += ':';
  if (options.localAddress)
    name += options.localAddress;

  // Pacify parallel/test-http-agent-getname by only appending
  // the ':' when options.family is set.
  if (options.family === 4 || options.family === 6)
    name += `:${options.family}`;

  if (options.socketPath)
    name += `:${options.socketPath}`;

  return name;
};

Agent.prototype.addRequest = function addRequest(req, options, port/* legacy */,
                                                 localAddress/* legacy */) {
  // Legacy API: addRequest(req, host, port, localAddress)
  if (typeof options === 'string') {
    options = {
      host: options,
      port,
      localAddress
    };
  }

  options = { ...options, ...this.options };
  if (options.socketPath)
    options.path = options.socketPath;

  if (!options.servername && options.servername !== '')
    options.servername = calculateServerName(options, req);
  // 拿到请求对应的key
  const name = this.getName(options);
  // 该key还没有在使用的socekt则初始化数据结构
  if (!this.sockets[name]) {
    this.sockets[name] = [];
  }
  // 该key对应的空闲socket列表
  const freeLen = this.freeSockets[name] ? this.freeSockets[name].length : 0;
  // 该key对应的所有socket个数
  const sockLen = freeLen + this.sockets[name].length;
  // 该key有对应的空闲socekt
  if (freeLen) {
    // We have a free socket, so use that.
    // 获取一个该key对应的空闲socket
    const socket = this.freeSockets[name].shift();
    // Guard against an uninitialized or user supplied Socket.
    const handle = socket._handle;
    if (handle && typeof handle.asyncReset === 'function') {
      // Assign the handle a new asyncId and run any destroy()/init() hooks.
      handle.asyncReset(new ReusedHandle(handle.getProviderType(), handle));
      socket[async_id_symbol] = handle.getAsyncId();
    }

    // don't leak
    // 取完了删除，防止内存泄漏
    if (!this.freeSockets[name].length)
      delete this.freeSockets[name];
    // 设置ref标记，因为正在使用该socket
    this.reuseSocket(socket, req);
    // 设置请求对应的socket
    setRequestSocket(this, req, socket);
    // 插入正在使用的socket队列
    this.sockets[name].push(socket);
  } else if (sockLen < this.maxSockets) { 
    /*
      如果该key没有对应的空闲socket并且使用的
      socket个数还没有得到阈值，则继续创建
    */
    debug('call onSocket', sockLen, freeLen);
    // If we are under maxSockets create a new one.
    this.createSocket(req, options, handleSocketCreation(this, req, true));
  } else {
    debug('wait for socket');
    // We are over limit so we'll add it to the queue.
    // 等待该key下有空闲的socket
    if (!this.requests[name]) {
      this.requests[name] = [];
    }
    this.requests[name].push(req);
  }
};

Agent.prototype.createSocket = function createSocket(req, options, cb) {
  options = { ...options, ...this.options };
  if (options.socketPath)
    options.path = options.socketPath;

  if (!options.servername && options.servername !== '')
    options.servername = calculateServerName(options, req);

  const name = this.getName(options);
  options._agentKey = name;

  debug('createConnection', name, options);
  options.encoding = null;
  let called = false;

  const oncreate = (err, s) => {
    if (called)
      return;
    called = true;
    if (err)
      return cb(err);
    if (!this.sockets[name]) {
      this.sockets[name] = [];
    }
    // 插入正在使用的socket队列
    this.sockets[name].push(s);
    debug('sockets', name, this.sockets[name].length);
    installListeners(this, s, options);
    cb(null, s);
  };
  // 创建一个新的socket
  const newSocket = this.createConnection(options, oncreate);
  if (newSocket)
    oncreate(null, newSocket);
};

function calculateServerName(options, req) {
  let servername = options.host;
  const hostHeader = req.getHeader('host');
  if (hostHeader) {
    if (typeof hostHeader !== 'string') {
      throw new ERR_INVALID_ARG_TYPE('options.headers.host',
                                     'String', hostHeader);
    }

    // abc => abc
    // abc:123 => abc
    // [::1] => ::1
    // [::1]:123 => ::1
    if (hostHeader.startsWith('[')) {
      const index = hostHeader.indexOf(']');
      if (index === -1) {
        // Leading '[', but no ']'. Need to do something...
        servername = hostHeader;
      } else {
        servername = hostHeader.substr(1, index - 1);
      }
    } else {
      servername = hostHeader.split(':', 1)[0];
    }
  }
  // Don't implicitly set invalid (IP) servernames.
  if (net.isIP(servername))
    servername = '';
  return servername;
}

function installListeners(agent, s, options) {
  // socket触发空闲事件的处理函数，告诉agent该socket空闲了，agent会回收该socket到空闲队列
  function onFree() {
    debug('CLIENT socket onFree');
    agent.emit('free', s, options);
  }
  // 监听socket空闲事件
  s.on('free', onFree);

  function onClose(err) {
    debug('CLIENT socket onClose');
    // This is the only place where sockets get removed from the Agent.
    // If you want to remove a socket from the pool, just close it.
    // All socket errors end in a close event anyway.
    agent.removeSocket(s, options);
  }
  // socket关闭则agent会从socket队列中删除他
  s.on('close', onClose);

  function onRemove() {
    // We need this function for cases like HTTP 'upgrade'
    // (defined by WebSockets) where we need to remove a socket from the
    // pool because it'll be locked up indefinitely
    debug('CLIENT socket onRemove');
    agent.removeSocket(s, options);
    s.removeListener('close', onClose);
    s.removeListener('free', onFree);
    s.removeListener('agentRemove', onRemove);
  }
  // agent被移除
  s.on('agentRemove', onRemove);

  if (agent[kOnKeylog]) {
    s.on('keylog', agent[kOnKeylog]);
  }
}
// 把socket从正在使用队列或者空闲队列中移出
Agent.prototype.removeSocket = function removeSocket(s, options) {
  const name = this.getName(options);
  debug('removeSocket', name, 'writable:', s.writable);
  const sets = [this.sockets];

  // If the socket was destroyed, remove it from the free buffers too.
  // socket不可写了，则有可能是存在空闲的队列中，所以需要遍历空闲队列
  if (!s.writable)
    sets.push(this.freeSockets);
  // 从队列中删除对应的socket
  for (const sockets of sets) {
    if (sockets[name]) {
      const index = sockets[name].indexOf(s);
      if (index !== -1) {
        sockets[name].splice(index, 1);
        // Don't leak
        if (sockets[name].length === 0)
          delete sockets[name];
      }
    }
  }
  // 如果还有在等待socekt的请求，则创建socket去处理他，因为socket数已经减一了，说明socket个数还没有达到阈值
  if (this.requests[name] && this.requests[name].length) {
    debug('removeSocket, have a request, make a socket');
    const req = this.requests[name][0];
    // If we have pending requests and a socket gets closed make a new one
    const socketCreationHandler = handleSocketCreation(this, req, false);
    this.createSocket(req, options, socketCreationHandler);
  }
};

// socket空闲时设置socket的空闲属性防止连接断开，但是需要设置ref标记，防止该socket阻止事件循环的退出
Agent.prototype.keepSocketAlive = function keepSocketAlive(socket) {
  socket.setKeepAlive(true, this.keepAliveMsecs);
  socket.unref();

  return true;
};

// 重新使用该socket，需要修改ref标记，阻止事件循环退出，并标记请求使用的是复用socket
Agent.prototype.reuseSocket = function reuseSocket(socket, req) {
  debug('have free socket');
  req.reusedSocket = true;
  socket.ref();
};

// 销毁agent，即销毁他所维护的所有socket
Agent.prototype.destroy = function destroy() {
  for (const set of [this.freeSockets, this.sockets]) {
    for (const key of ObjectKeys(set)) {
      for (const setName of set[key]) {
        setName.destroy();
      }
    }
  }
};
// 创建socket后的回调 
function handleSocketCreation(agent, request, informRequest) {
  return function handleSocketCreation_Inner(err, socket) {
    if (err) {
      process.nextTick(emitErrorNT, request, err);
      return;
    }
    // 是否需要直接通知请求方，这时候request不是来自等待socket的requests队列，而是来自调用方，见addRequest
    if (informRequest)
      setRequestSocket(agent, request, socket);
    else
      // 不直接通知，先告诉agent有空闲的socket，agent会判断是否有正在等待socket的请求，有则处理
      socket.emit('free');
  };
}
// 通知请求对应的socket创建成功
function setRequestSocket(agent, req, socket) {
  // 通知请求socket创建成功
  req.onSocket(socket);
  const agentTimeout = agent.options.timeout || 0;
  if (req.timeout === undefined || req.timeout === agentTimeout) {
    return;
  }
  // 开启一个定时器，过期后触发timeout事件
  socket.setTimeout(req.timeout);
  // Reset timeout after response end
  // 监听响应事件，响应结束后需要重新设置超时时间，开启下一个请求的超时计算，否则会提前过期
  req.once('response', (res) => {
    res.once('end', () => {
      if (socket.timeout !== agentTimeout) {
        socket.setTimeout(agentTimeout);
      }
    });
  });
}

function emitErrorNT(emitter, err) {
  emitter.emit('error', err);
}

module.exports = {
  Agent,
  globalAgent: new Agent()
};
