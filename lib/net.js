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
  Number,
  NumberIsNaN,
  ObjectDefineProperty,
  ObjectSetPrototypeOf,
  Symbol,
} = primordials;

const EventEmitter = require('events');
const stream = require('stream');
const { inspect } = require('internal/util/inspect');
const debug = require('internal/util/debuglog').debuglog('net');
const { deprecate } = require('internal/util');
const {
  isIP,
  isIPv4,
  isIPv6,
  isLegalPort,
  normalizedArgsSymbol,
  makeSyncWrite
} = require('internal/net');
const assert = require('internal/assert');
const {
  UV_EADDRINUSE,
  UV_EINVAL,
  UV_ENOTCONN
} = internalBinding('uv');

const { Buffer } = require('buffer');
const { guessHandleType } = internalBinding('util');
const { ShutdownWrap } = internalBinding('stream_wrap');
const {
  TCP,
  TCPConnectWrap,
  constants: TCPConstants
} = internalBinding('tcp_wrap');
const {
  Pipe,
  PipeConnectWrap,
  constants: PipeConstants
} = internalBinding('pipe_wrap');
const {
  newAsyncId,
  defaultTriggerAsyncIdScope,
  symbols: { async_id_symbol, owner_symbol }
} = require('internal/async_hooks');
const {
  writevGeneric,
  writeGeneric,
  onStreamRead,
  kAfterAsyncWrite,
  kHandle,
  kUpdateTimer,
  setStreamTimeout,
  kBuffer,
  kBufferCb,
  kBufferGen
} = require('internal/stream_base_commons');
const {
  codes: {
    ERR_INVALID_ADDRESS_FAMILY,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_FD_TYPE,
    ERR_INVALID_IP_ADDRESS,
    ERR_INVALID_OPT_VALUE,
    ERR_SERVER_ALREADY_LISTEN,
    ERR_SERVER_NOT_RUNNING,
    ERR_SOCKET_BAD_PORT,
    ERR_SOCKET_CLOSED
  },
  errnoException,
  exceptionWithHostPort,
  uvExceptionWithHostPort
} = require('internal/errors');
const { isUint8Array } = require('internal/util/types');
const { validateInt32, validateString } = require('internal/validators');
const kLastWriteQueueSize = Symbol('lastWriteQueueSize');
const {
  DTRACE_NET_SERVER_CONNECTION,
  DTRACE_NET_STREAM_END
} = require('internal/dtrace');

// Lazy loaded to improve startup performance.
let cluster;
let dns;

const { clearTimeout } = require('timers');
const { kTimeout } = require('internal/timers');

const DEFAULT_IPV4_ADDR = '0.0.0.0';
const DEFAULT_IPV6_ADDR = '::';

function noop() {}

function getFlags(ipv6Only) {
  return ipv6Only === true ? TCPConstants.UV_TCP_IPV6ONLY : 0;
}

function createHandle(fd, is_server) {
  validateInt32(fd, 'fd', 0);
  // 通过文件描述符获得底层的数据，判断handle类型
  const type = guessHandleType(fd);
  if (type === 'PIPE') {
    return new Pipe(
      is_server ? PipeConstants.SERVER : PipeConstants.SOCKET
    );
  }

  if (type === 'TCP') {
    return new TCP(
      is_server ? TCPConstants.SERVER : TCPConstants.SOCKET
    );
  }

  throw new ERR_INVALID_FD_TYPE(type);
}


function getNewAsyncId(handle) {
  return (!handle || typeof handle.getAsyncId !== 'function') ?
    newAsyncId() : handle.getAsyncId();
}


function isPipeName(s) {
  return typeof s === 'string' && toNumber(s) === false;
}

function createServer(options, connectionListener) {
  return new Server(options, connectionListener);
}


// Target API:
//
// let s = net.connect({port: 80, host: 'google.com'}, function() {
//   ...
// });
//
// There are various forms:
//
// connect(options, [cb])
// connect(port, [host], [cb])
// connect(path, [cb]);
//
function connect(...args) {
  const normalized = normalizeArgs(args);
  const options = normalized[0];
  debug('createConnection', normalized);
  const socket = new Socket(options);

  if (options.timeout) {
    socket.setTimeout(options.timeout);
  }

  return socket.connect(normalized);
}


// Returns an array [options, cb], where options is an object,
// cb is either a function or null.
// Used to normalize arguments of Socket.prototype.connect() and
// Server.prototype.listen(). Possible combinations of parameters:
//   (options[...][, cb])
//   (path[...][, cb])
//   ([port][, host][...][, cb])
// For Socket.prototype.connect(), the [...] part is ignored
// For Server.prototype.listen(), the [...] part is [, backlog]
// but will not be handled here (handled in listen())

// @return [options = {path: '', port: '', host: ''} | args[0], cb = null]
function normalizeArgs(args) {
  let arr;

  if (args.length === 0) {
    arr = [{}, null];
    arr[normalizedArgsSymbol] = true;
    return arr;
  }

  const arg0 = args[0];
  let options = {};
  // 第一个参数是对象
  if (typeof arg0 === 'object' && arg0 !== null) {
    // (options[...][, cb])
    options = arg0;
  // 第一个参数是管道
  } else if (isPipeName(arg0)) {
    // (path[...][, cb])
    options.path = arg0;
  } else {
    // 这里应该判断一下第一个参数是不是数字比较好
    // ([port][, host][...][, cb])
    // 否则第一个是端口
    options.port = arg0;
    // 有第二个参数并且是字符串则是host
    if (args.length > 1 && typeof args[1] === 'string') {
      options.host = args[1];
    }
  }
  // 最后一个参数，这里要保证参数个数大于2，即第一个参数不能是函数
  const cb = args[args.length - 1];
  if (typeof cb !== 'function')
    arr = [options, null];
  else
    arr = [options, cb];

  arr[normalizedArgsSymbol] = true;
  return arr;
}


// Called when creating new Socket, or when re-using a closed Socket
function initSocketHandle(self) {
  self._undestroy();
  self._sockname = null;

  // Handle creation may be deferred to bind() or connect() time.
  if (self._handle) {
    self._handle[owner_symbol] = self;
    self._handle.onread = onStreamRead;
    self[async_id_symbol] = getNewAsyncId(self._handle);

    let userBuf = self[kBuffer];
    if (userBuf) {
      const bufGen = self[kBufferGen];
      if (bufGen !== null) {
        userBuf = bufGen();
        if (!isUint8Array(userBuf))
          return;
        self[kBuffer] = userBuf;
      }
      self._handle.useUserBuffer(userBuf);
    }
  }
}


const kBytesRead = Symbol('kBytesRead');
const kBytesWritten = Symbol('kBytesWritten');


function Socket(options) {
  if (!(this instanceof Socket)) return new Socket(options);

  this.connecting = false;
  // Problem with this is that users can supply their own handle, that may not
  // have _handle.getAsyncId(). In this case an[async_id_symbol] should
  // probably be supplied by async_hooks.
  this[async_id_symbol] = -1;
  this._hadError = false;
  this[kHandle] = null;
  this._parent = null;
  this._host = null;
  this[kLastWriteQueueSize] = 0;
  this[kTimeout] = null;
  this[kBuffer] = null;
  this[kBufferCb] = null;
  this[kBufferGen] = null;

  if (typeof options === 'number')
    options = { fd: options }; // Legacy interface.
  else
    options = { ...options };

  options.readable = options.readable || false;
  options.writable = options.writable || false;
  const { allowHalfOpen } = options;

  // Prevent the "no-half-open enforcer" from being inherited from `Duplex`.
  options.allowHalfOpen = true;
  // For backwards compat do not emit close on destroy.
  options.emitClose = false;
  options.autoDestroy = false;
  // Handle strings directly.
  options.decodeStrings = false;
  stream.Duplex.call(this, options);

  // Default to *not* allowing half open sockets.
  this.allowHalfOpen = Boolean(allowHalfOpen);
  // 来自accept返回的client_handle
  if (options.handle) {
    this._handle = options.handle; // private
    this[async_id_symbol] = getNewAsyncId(this._handle);
  } else {
    // 来自发起connect
    const onread = options.onread;
    if (onread !== null && typeof onread === 'object' &&
        (isUint8Array(onread.buffer) || typeof onread.buffer === 'function') &&
        typeof onread.callback === 'function') {
      if (typeof onread.buffer === 'function') {
        this[kBuffer] = true;
        this[kBufferGen] = onread.buffer;
      } else {
        this[kBuffer] = onread.buffer;
      }
      this[kBufferCb] = onread.callback;
    }
    if (options.fd !== undefined) {
      const { fd } = options;
      let err;

      // createHandle will throw ERR_INVALID_FD_TYPE if `fd` is not
      // a valid `PIPE` or `TCP` descriptor
      this._handle = createHandle(fd, false);

      err = this._handle.open(fd);

      // While difficult to fabricate, in some architectures
      // `open` may return an error code for valid file descriptors
      // which cannot be opened. This is difficult to test as most
      // un-openable fds will throw on `createHandle`
      if (err)
        throw errnoException(err, 'open');

      this[async_id_symbol] = this._handle.getAsyncId();

      if ((fd === 1 || fd === 2) &&
          (this._handle instanceof Pipe) &&
          process.platform === 'win32') {
        // Make stdout and stderr blocking on Windows
        err = this._handle.setBlocking(true);
        if (err)
          throw errnoException(err, 'setBlocking');

        this._writev = null;
        this._write = makeSyncWrite(fd);
        // makeSyncWrite adjusts this value like the original handle would, so
        // we need to let it do that by turning it into a writable, own
        // property.
        ObjectDefineProperty(this._handle, 'bytesWritten', {
          value: 0, writable: true
        });
      }
    }
  }

  // Shut down the socket when we're finished with it.
  this.on('end', onReadableStreamEnd);

  initSocketHandle(this);

  this._pendingData = null;
  this._pendingEncoding = '';

  // If we have a handle, then start the flow of data into the
  // buffer.  if not, then this will happen when we connect
  if (this._handle && options.readable !== false) {
    // pauseOnConnect代表不注册socket的读事件
    if (options.pauseOnCreate) {
      // Stop the handle from reading and pause the stream
      this._handle.reading = false;
      this._handle.readStop();
      this.readableFlowing = false;
    } else if (!options.manualStart) {
      this.read(0);
    }
  }

  // Reserve properties
  this.server = null;
  this._server = null;

  // Used after `.destroy()`
  this[kBytesRead] = 0;
  this[kBytesWritten] = 0;
}
ObjectSetPrototypeOf(Socket.prototype, stream.Duplex.prototype);
ObjectSetPrototypeOf(Socket, stream.Duplex);

// Refresh existing timeouts.
Socket.prototype._unrefTimer = function _unrefTimer() {
  for (let s = this; s !== null; s = s._parent) {
    if (s[kTimeout])
      s[kTimeout].refresh();
  }
};


// The user has called .end(), and all the bytes have been
// sent out to the other side.
Socket.prototype._final = function(cb) {
  // If still connecting - defer handling `_final` until 'connect' will happen
  // 正在连接，连接成功后再执行
  if (this.pending) {
    debug('_final: not yet connected');
    return this.once('connect', () => this._final(cb));
  }

  if (!this._handle)
    return cb();

  debug('_final: not ended, call shutdown()');
  // 关闭handle写端
  const req = new ShutdownWrap();
  req.oncomplete = afterShutdown;
  req.handle = this._handle;
  req.callback = cb;
  const err = this._handle.shutdown(req);

  if (err === 1 || err === UV_ENOTCONN)  // synchronous finish
    return afterShutdown.call(req, 0);
  else if (err !== 0)
    return this.destroy(errnoException(err, 'shutdown'));
};

// 关闭写端后的回调
function afterShutdown(status) {
  const self = this.handle[owner_symbol];

  debug('afterShutdown destroyed=%j', self.destroyed,
        self._readableState);
  // 执行回调
  this.callback();

  // Callback may come after call to destroy.
  if (self.destroyed)
    return;
  // 关闭写端后也不可读了，则销毁socket
  if (!self.readable || self.readableEnded) {
    debug('readableState ended, destroying');
    self.destroy();
  }
}

// Provide a better error message when we call end() as a result
// of the other side sending a FIN.  The standard 'write after end'
// is overly vague, and makes it seem like the user's code is to blame.
// 关闭写端后又执行写操作
function writeAfterFIN(chunk, encoding, cb) {
  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  // eslint-disable-next-line no-restricted-syntax
  const er = new Error('This socket has been ended by the other party');
  er.code = 'EPIPE';
  process.nextTick(emitErrorNT, this, er);
  if (typeof cb === 'function') {
    defaultTriggerAsyncIdScope(this[async_id_symbol], process.nextTick, cb, er);
  }

  return false;
}

Socket.prototype.setTimeout = setStreamTimeout;


Socket.prototype._onTimeout = function() {
  const handle = this._handle;
  const lastWriteQueueSize = this[kLastWriteQueueSize];
  if (lastWriteQueueSize > 0 && handle) {
    // `lastWriteQueueSize !== writeQueueSize` means there is
    // an active write in progress, so we suppress the timeout.
    const { writeQueueSize } = handle;
    if (lastWriteQueueSize !== writeQueueSize) {
      this[kLastWriteQueueSize] = writeQueueSize;
      this._unrefTimer();
      return;
    }
  }
  debug('_onTimeout');
  this.emit('timeout');
};


Socket.prototype.setNoDelay = function(enable) {
  if (!this._handle) {
    this.once('connect',
              enable ? this.setNoDelay : () => this.setNoDelay(enable));
    return this;
  }

  // Backwards compatibility: assume true when `enable` is omitted
  if (this._handle.setNoDelay)
    this._handle.setNoDelay(enable === undefined ? true : !!enable);

  return this;
};


Socket.prototype.setKeepAlive = function(setting, msecs) {
  if (!this._handle) {
    this.once('connect', () => this.setKeepAlive(setting, msecs));
    return this;
  }

  if (this._handle.setKeepAlive)
    this._handle.setKeepAlive(setting, ~~(msecs / 1000));

  return this;
};


Socket.prototype.address = function() {
  return this._getsockname();
};


ObjectDefineProperty(Socket.prototype, '_connecting', {
  get: function() {
    return this.connecting;
  }
});

ObjectDefineProperty(Socket.prototype, 'pending', {
  get() {
    return !this._handle || this.connecting;
  },
  configurable: true
});


ObjectDefineProperty(Socket.prototype, 'readyState', {
  get: function() {
    if (this.connecting) {
      return 'opening';
    } else if (this.readable && this.writable) {
      return 'open';
    } else if (this.readable && !this.writable) {
      return 'readOnly';
    } else if (!this.readable && this.writable) {
      return 'writeOnly';
    } else {
      return 'closed';
    }
  }
});


ObjectDefineProperty(Socket.prototype, 'bufferSize', {
  get: function() {
    if (this._handle) {
      return this[kLastWriteQueueSize] + this.writableLength;
    }
  }
});

ObjectDefineProperty(Socket.prototype, kUpdateTimer, {
  get: function() {
    return this._unrefTimer;
  }
});


function tryReadStart(socket) {
  // Not already reading, start the flow
  debug('Socket._handle.readStart');
  socket._handle.reading = true;
  const err = socket._handle.readStart();
  if (err)
    socket.destroy(errnoException(err, 'read'));
}

// Just call handle.readStart until we have enough in the buffer
// 注册等待读事件
Socket.prototype._read = function(n) {
  debug('_read');
  // 还在连接，则等待连接成功
  if (this.connecting || !this._handle) {
    debug('_read wait for connection');
    this.once('connect', () => this._read(n));
  } else if (!this._handle.reading) {
    tryReadStart(this);
  }
};

// 关闭写端
Socket.prototype.end = function(data, encoding, callback) {
  stream.Duplex.prototype.end.call(this, data, encoding, callback);
  DTRACE_NET_STREAM_END(this);
  return this;
};


Socket.prototype.pause = function() {
  if (this[kBuffer] && !this.connecting && this._handle &&
      this._handle.reading) {
    this._handle.reading = false;
    if (!this.destroyed) {
      const err = this._handle.readStop();
      if (err)
        this.destroy(errnoException(err, 'read'));
    }
  }
  return stream.Duplex.prototype.pause.call(this);
};


Socket.prototype.resume = function() {
  if (this[kBuffer] && !this.connecting && this._handle &&
      !this._handle.reading) {
    tryReadStart(this);
  }
  return stream.Duplex.prototype.resume.call(this);
};


Socket.prototype.read = function(n) {
  if (this[kBuffer] && !this.connecting && this._handle &&
      !this._handle.reading) {
    tryReadStart(this);
  }
  return stream.Duplex.prototype.read.call(this, n);
};


// Called when the 'end' event is emitted.
// 对端发送了fin，即不可读了
function onReadableStreamEnd() {
  // 不允许半连接
  if (!this.allowHalfOpen) {
    // 修改write函数，用户再点write的函数则报错
    this.write = writeAfterFIN;
    // 如果还可写，则发送fin给对端，说明不会再发送数据了
    if (this.writable)
      this.end();
  }
  // 还没有销毁，不可写了则销毁
  if (!this.destroyed && !this.writable && !this.writableLength)
    this.destroy();
}


Socket.prototype.destroySoon = function() {
  if (this.writable)
    this.end();

  if (this.writableFinished)
    this.destroy();
  else
    this.once('finish', this.destroy);
};


Socket.prototype._destroy = function(exception, cb) {
  debug('destroy');

  this.connecting = false;

  this.readable = this.writable = false;

  for (let s = this; s !== null; s = s._parent) {
    clearTimeout(s[kTimeout]);
  }

  debug('close');
  if (this._handle) {
    if (this !== process.stderr)
      debug('close handle');
    const isException = exception ? true : false;
    // `bytesRead` and `kBytesWritten` should be accessible after `.destroy()`
    this[kBytesRead] = this._handle.bytesRead;
    this[kBytesWritten] = this._handle.bytesWritten;

    this._handle.close(() => {
      debug('emit close');
      this.emit('close', isException);
    });
    this._handle.onread = noop;
    this._handle = null;
    this._sockname = null;
    cb(exception);
  } else {
    cb(exception);
    process.nextTick(emitCloseNT, this);
  }
  // socket关联的server，通信socket才有server
  if (this._server) {
    debug('has server');
    this._server._connections--;
    if (this._server._emitCloseIfDrained) {
      this._server._emitCloseIfDrained();
    }
  }
};
// 获取对端地址信息
Socket.prototype._getpeername = function() {
  // 还没有缓存则获取，否则直接返回
  if (!this._peername) {
    if (!this._handle || !this._handle.getpeername) {
      return {};
    }
    const out = {};
    const err = this._handle.getpeername(out);
    if (err) return {};  // FIXME(bnoordhuis) Throw?
    this._peername = out;
  }
  return this._peername;
};

function protoGetter(name, callback) {
  ObjectDefineProperty(Socket.prototype, name, {
    configurable: false,
    enumerable: true,
    get: callback
  });
}

protoGetter('bytesRead', function bytesRead() {
  return this._handle ? this._handle.bytesRead : this[kBytesRead];
});
// 对端的信息字段
protoGetter('remoteAddress', function remoteAddress() {
  return this._getpeername().address;
});

protoGetter('remoteFamily', function remoteFamily() {
  return this._getpeername().family;
});

protoGetter('remotePort', function remotePort() {
  return this._getpeername().port;
});

// 获取本端地址信息，同_getpeername
Socket.prototype._getsockname = function() {
  if (!this._handle || !this._handle.getsockname) {
    return {};
  }
  if (!this._sockname) {
    const out = {};
    const err = this._handle.getsockname(out);
    if (err) return {};  // FIXME(bnoordhuis) Throw?
    this._sockname = out;
  }
  return this._sockname;
};


protoGetter('localAddress', function localAddress() {
  return this._getsockname().address;
});


protoGetter('localPort', function localPort() {
  return this._getsockname().port;
});


Socket.prototype[kAfterAsyncWrite] = function() {
  this[kLastWriteQueueSize] = 0;
};

Socket.prototype._writeGeneric = function(writev, data, encoding, cb) {
  // If we are still connecting, then buffer this for later.
  // The Writable logic will buffer up any more writes while
  // waiting for this one to be done.
  if (this.connecting) {
    this._pendingData = data;
    this._pendingEncoding = encoding;
    this.once('connect', function connect() {
      this._writeGeneric(writev, data, encoding, cb);
    });
    return;
  }
  this._pendingData = null;
  this._pendingEncoding = '';

  if (!this._handle) {
    cb(new ERR_SOCKET_CLOSED());
    return false;
  }

  this._unrefTimer();

  let req;
  if (writev)
    req = writevGeneric(this, data, cb);
  else
    req = writeGeneric(this, data, encoding, cb);
  if (req.async)
    this[kLastWriteQueueSize] = req.bytes;
};


Socket.prototype._writev = function(chunks, cb) {
  this._writeGeneric(true, chunks, '', cb);
};


Socket.prototype._write = function(data, encoding, cb) {
  this._writeGeneric(false, data, encoding, cb);
};


// Legacy alias. Having this is probably being overly cautious, but it doesn't
// really hurt anyone either. This can probably be removed safely if desired.
protoGetter('_bytesDispatched', function _bytesDispatched() {
  return this._handle ? this._handle.bytesWritten : this[kBytesWritten];
});

protoGetter('bytesWritten', function bytesWritten() {
  let bytes = this._bytesDispatched;
  const state = this._writableState;
  const data = this._pendingData;
  const encoding = this._pendingEncoding;

  if (!state)
    return undefined;

  this.writableBuffer.forEach(function(el) {
    if (el.chunk instanceof Buffer)
      bytes += el.chunk.length;
    else
      bytes += Buffer.byteLength(el.chunk, el.encoding);
  });

  if (ArrayIsArray(data)) {
    // Was a writev, iterate over chunks to get total length
    for (let i = 0; i < data.length; i++) {
      const chunk = data[i];

      if (data.allBuffers || chunk instanceof Buffer)
        bytes += chunk.length;
      else
        bytes += Buffer.byteLength(chunk.chunk, chunk.encoding);
    }
  } else if (data) {
    // Writes are either a string or a Buffer.
    if (typeof data !== 'string')
      bytes += data.length;
    else
      bytes += Buffer.byteLength(data, encoding);
  }

  return bytes;
});


function checkBindError(err, port, handle) {
  // EADDRINUSE may not be reported until we call listen() or connect().
  // To complicate matters, a failed bind() followed by listen() or connect()
  // will implicitly bind to a random port. Ergo, check that the socket is
  // bound to the expected port before calling listen() or connect().
  //
  // FIXME(bnoordhuis) Doesn't work for pipe handles, they don't have a
  // getsockname() method. Non-issue for now, the cluster module doesn't
  // really support pipes anyway.
  if (err === 0 && port > 0 && handle.getsockname) {
    const out = {};
    err = handle.getsockname(out);
    if (err === 0 && port !== out.port) {
      debug(`checkBindError, bound to ${out.port} instead of ${port}`);
      err = UV_EADDRINUSE;
    }
  }
  return err;
}

// 执行连接
function internalConnect(
  self, address, port, addressType, localAddress, localPort, flags) {
  // TODO return promise from Socket.prototype.connect which
  // wraps _connectReq.

  assert(self.connecting);

  let err;
  // 设置了源ip和地址，则绑定，否则操作系统随机选择
  if (localAddress || localPort) {
    // 绑定ipv4或ipv6
    if (addressType === 4) {
      localAddress = localAddress || DEFAULT_IPV4_ADDR;
      err = self._handle.bind(localAddress, localPort);
    } else { // addressType === 6
      localAddress = localAddress || DEFAULT_IPV6_ADDR;
      err = self._handle.bind6(localAddress, localPort, flags);
    }
    debug('binding to localAddress: %s and localPort: %d (addressType: %d)',
          localAddress, localPort, addressType);
    // 检查bind的结果
    err = checkBindError(err, localPort, self._handle);
    // 销毁socket
    if (err) {
      const ex = exceptionWithHostPort(err, 'bind', localAddress, localPort);
      self.destroy(ex);
      return;
    }
  }
  // 设置ip类型说明是tcp，否则是unix域
  if (addressType === 6 || addressType === 4) {
    const req = new TCPConnectWrap();
    req.oncomplete = afterConnect;
    req.address = address;
    req.port = port;
    req.localAddress = localAddress;
    req.localPort = localPort;
    // 开始三次握手建立连接
    if (addressType === 4)
      err = self._handle.connect(req, address, port);
    else
      err = self._handle.connect6(req, address, port);
  } else {
    // unix域，address是路径
    const req = new PipeConnectWrap();
    req.address = address;
    req.oncomplete = afterConnect;

    err = self._handle.connect(req, address, afterConnect);
  }
  // 出错
  if (err) {
    // 拿到本端的地址信息
    const sockname = self._getsockname();
    let details;

    if (sockname) {
      details = sockname.address + ':' + sockname.port;
    }

    const ex = exceptionWithHostPort(err, 'connect', address, port, details);
    self.destroy(ex);
  }
}


Socket.prototype.connect = function(...args) {
  let normalized;
  // If passed an array, it's treated as an array of arguments that have
  // already been normalized (so we don't normalize more than once). This has
  // been solved before in https://github.com/nodejs/node/pull/12342, but was
  // reverted as it had unintended side effects.
  if (ArrayIsArray(args[0]) && args[0][normalizedArgsSymbol]) {
    normalized = args[0];
  } else {
    normalized = normalizeArgs(args);
  }
  const options = normalized[0];
  const cb = normalized[1];

  if (this.write !== Socket.prototype.write)
    this.write = Socket.prototype.write;

  if (this.destroyed) {
    this._handle = null;
    this._peername = null;
    this._sockname = null;
  }

  const { path } = options;
  const pipe = !!path;
  debug('pipe', pipe, path);

  if (!this._handle) {
    this._handle = pipe ?
      new Pipe(PipeConstants.SOCKET) :
      new TCP(TCPConstants.SOCKET);
    initSocketHandle(this);
  }

  if (cb !== null) {
    this.once('connect', cb);
  }

  this._unrefTimer();
  // 正在连接
  this.connecting = true;
  // 可写，但是如果写的时候是connecting状态则需要等到连接建立后再真正执行写
  this.writable = true;
  // unix域则直接开始连接，tcp则可能还需要dns解析
  if (pipe) {
    validateString(path, 'options.path');
    defaultTriggerAsyncIdScope(
      this[async_id_symbol], internalConnect, this, path
    );
  } else {
    lookupAndConnect(this, options);
  }
  return this;
};


function lookupAndConnect(self, options) {
  const { localAddress, localPort } = options;
  const host = options.host || 'localhost';
  let { port } = options;

  if (localAddress && !isIP(localAddress)) {
    throw new ERR_INVALID_IP_ADDRESS(localAddress);
  }

  if (localPort && typeof localPort !== 'number') {
    throw new ERR_INVALID_ARG_TYPE('options.localPort', 'number', localPort);
  }

  if (typeof port !== 'undefined') {
    if (typeof port !== 'number' && typeof port !== 'string') {
      throw new ERR_INVALID_ARG_TYPE('options.port',
                                     ['number', 'string'], port);
    }
    if (!isLegalPort(port)) {
      throw new ERR_SOCKET_BAD_PORT(port);
    }
  }
  // 变成整形
  port |= 0;

  // If host is an IP, skip performing a lookup
  const addressType = isIP(host);
  // 是ip则不需要dns解析
  if (addressType) {
    defaultTriggerAsyncIdScope(self[async_id_symbol], process.nextTick, () => {
      if (self.connecting)
        defaultTriggerAsyncIdScope(
          self[async_id_symbol],
          internalConnect,
          self, host, port, addressType, localAddress, localPort
        );
    });
    return;
  }
  // 自定义了dns解析函数
  if (options.lookup && typeof options.lookup !== 'function')
    throw new ERR_INVALID_ARG_TYPE('options.lookup',
                                   'Function', options.lookup);


  if (dns === undefined) dns = require('dns');
  const dnsopts = {
    family: options.family,
    hints: options.hints || 0
  };

  if (process.platform !== 'win32' &&
      dnsopts.family !== 4 &&
      dnsopts.family !== 6 &&
      dnsopts.hints === 0) {
    dnsopts.hints = dns.ADDRCONFIG;
  }

  debug('connect: find host', host);
  debug('connect: dns options', dnsopts);
  self._host = host;
  const lookup = options.lookup || dns.lookup;
  defaultTriggerAsyncIdScope(self[async_id_symbol], function() {
    lookup(host, dnsopts, function emitLookup(err, ip, addressType) {
      self.emit('lookup', err, ip, addressType, host);

      // It's possible we were destroyed while looking this up.
      // XXX it would be great if we could cancel the promise returned by
      // the look up.
      // lookup回调里销毁了socket
      if (!self.connecting) return;
      // dns解析出错
      if (err) {
        // net.createConnection() creates a net.Socket object and immediately
        // calls net.Socket.connect() on it (that's us). There are no event
        // listeners registered yet so defer the error event to the next tick.
        process.nextTick(connectErrorNT, self, err);
      } else if (addressType !== 4 && addressType !== 6) {
        err = new ERR_INVALID_ADDRESS_FAMILY(addressType,
                                             options.host,
                                             options.port);
        process.nextTick(connectErrorNT, self, err);
      } else {
        self._unrefTimer();
        defaultTriggerAsyncIdScope(
          self[async_id_symbol],
          internalConnect,
          self, ip, port, addressType, localAddress, localPort
        );
      }
    });
  });
}


function connectErrorNT(self, err) {
  self.destroy(err);
}

// 置handle为ref状态，影响事件循环的退出
Socket.prototype.ref = function() {
  if (!this._handle) {
    this.once('connect', this.ref);
    return this;
  }

  if (typeof this._handle.ref === 'function') {
    this._handle.ref();
  }

  return this;
};

// 和上面相反
Socket.prototype.unref = function() {
  if (!this._handle) {
    this.once('connect', this.unref);
    return this;
  }

  if (typeof this._handle.unref === 'function') {
    this._handle.unref();
  }

  return this;
};

// 
function afterConnect(status, handle, req, readable, writable) {
  const self = handle[owner_symbol];

  // Callback may come after call to destroy
  if (self.destroyed) {
    return;
  }

  debug('afterConnect');

  assert(self.connecting);
  // 连接完毕，可能成功可能失败
  self.connecting = false;
  self._sockname = null;
  // 成功
  if (status === 0) {
    self.readable = readable;
    // 可能正在连接的时候，执行了end函数
    if (!self._writableState.ended)
      self.writable = writable;
    self._unrefTimer();
    
    self.emit('connect');
    self.emit('ready');

    // Start the first read, or get an immediate EOF.
    // this doesn't actually consume any bytes, because len=0.
    // 可读并且不是暂停模式，则注册等待可读事件
    if (readable && !self.isPaused())
      self.read(0);

  } else {
    // 连接失败
    self.connecting = false;
    let details;
    if (req.localAddress && req.localPort) {
      details = req.localAddress + ':' + req.localPort;
    }
    const ex = exceptionWithHostPort(status,
                                     'connect',
                                     req.address,
                                     req.port,
                                     details);
    if (details) {
      ex.localAddress = req.localAddress;
      ex.localPort = req.localPort;
    }
    // 销毁socket
    self.destroy(ex);
  }
}

/*
  一个tcp或者unix域服务器
  options = funtion | null | object
  connectionListener = funtion
*/
function Server(options, connectionListener) {
  if (!(this instanceof Server))
    return new Server(options, connectionListener);

  EventEmitter.call(this);
  // 没有options，只有一个回调
  if (typeof options === 'function') {
    connectionListener = options;
    options = {};
    // 有连接的时候的回调
    this.on('connection', connectionListener);
  } else if (options == null || typeof options === 'object') {
    options = { ...options };

    if (typeof connectionListener === 'function') {
      this.on('connection', connectionListener);
    }
  } else {
    throw new ERR_INVALID_ARG_TYPE('options', 'Object', options);
  }
  // 连接数
  this._connections = 0;

  ObjectDefineProperty(this, 'connections', {
    get: deprecate(() => {

      if (this._usingWorkers) {
        return null;
      }
      return this._connections;
    }, 'Server.connections property is deprecated. ' +
       'Use Server.getConnections method instead.', 'DEP0020'),
    set: deprecate((val) => (this._connections = val),
                   'Server.connections property is deprecated.',
                   'DEP0020'),
    configurable: true, enumerable: false
  });

  this[async_id_symbol] = -1;
  // c++类
  this._handle = null;
  this._usingWorkers = false;
  this._workers = [];
  this._unref = false;
  // 是否允许半连接，用于设置和客户端通信的socket
  this.allowHalfOpen = options.allowHalfOpen || false;
  // 有连接到来时是否禁止socekt不读取数据，用于设置和客户端通信的socket
  this.pauseOnConnect = !!options.pauseOnConnect;
}
ObjectSetPrototypeOf(Server.prototype, EventEmitter.prototype);
ObjectSetPrototypeOf(Server, EventEmitter);


function toNumber(x) { return (x = Number(x)) >= 0 ? x : false; }

// Returns handle if it can be created, or error code if it can't
/*
  参数来自setupListenHandle
  1 传fd = null, null, null, backlog, fd
  2 传了端口port没传host
      支持ipv6 DEFAULT_IPV6_ADDR, port | 0, 6, backlog, undefined, options
      不支持ipv6 DEFAULT_IPV4_ADDR, port | 0, 4, backlog, undefined, options
  3 传了端口port也传了host = ip, port | 0, 4, backlog, undefined, options
  4 unix域 = pipeName, -1, -1, backlog, undefined, exclusive
*/
function createServerHandle(address, port, addressType, fd, flags) {
  let err = 0;
  // Assign handle in listen, and clean up if bind or listen fails
  let handle;

  let isTCP = false;
  if (typeof fd === 'number' && fd >= 0) {
    try {
      handle = createHandle(fd, true);
    } catch (e) {
      // Not a fd we can listen on.  This will trigger an error.
      debug('listen invalid fd=%d:', fd, e.message);
      return UV_EINVAL;
    }
    // 把fd记录到handle对应的io观察者里，见tcp_wrap.c的Open函数
    err = handle.open(fd);
    if (err)
      return err;

    assert(!address && !port);
  // unix域
  } else if (port === -1 && addressType === -1) {
    handle = new Pipe(PipeConstants.SERVER);
    if (process.platform === 'win32') {
      const instances = parseInt(process.env.NODE_PENDING_PIPE_INSTANCES);
      if (!NumberIsNaN(instances)) {
        handle.setPendingInstances(instances);
      }
    }
  } else {
    handle = new TCP(TCPConstants.SERVER);
    isTCP = true;
  }
  // 2，3，4符合
  if (address || port || isTCP) {
    debug('bind to', address || 'any');
    if (!address) {
      // Try binding to ipv6 first
      err = handle.bind6(DEFAULT_IPV6_ADDR, port, flags);
      if (err) {
        handle.close();
        // Fallback to ipv4
        return createServerHandle(DEFAULT_IPV4_ADDR, port);
      }
    } else if (addressType === 6) {
      err = handle.bind6(address, port, flags);
    } else {
      err = handle.bind(address, port);
    }
  }

  if (err) {
    handle.close();
    return err;
  }

  return handle;
}
/*
  参数来自listenInCluster
  1 server实例已经有handle = null, -1, -1, backlog
  2 传fd = null, null, null, backlog, fd
  3 传了端口port没传host = null, port | 0, 4, backlog, undefined, options
  4 传了端口port也传了host = ip, port | 0, 4, backlog, undefined, options
  5 unix域 = pipeName, -1, -1, backlog, undefined, exclusive
*/
function setupListenHandle(address, port, addressType, backlog, fd, flags) {
  debug('setupListenHandle', address, port, addressType, backlog, fd);

  // If there is not yet a handle, we need to create one and bind.
  // In the case of a server sent via IPC, we don't need to do this.
  if (this._handle) {
    debug('setupListenHandle: have a handle already');
  } else {
    debug('setupListenHandle: create a handle');

    let rval = null;

    // Try to bind to the unspecified IPv6 address, see if IPv6 is available
    // 1，2，3没有传address，1，3没有fd。3没有handle，所以这里是针对3这种情况，即传了端口没传host
    if (!address && typeof fd !== 'number') {
      rval = createServerHandle(DEFAULT_IPV6_ADDR, port, 6, fd, flags);
      // rval是数字说明createServerHandle报错了，不支持v6，否则返回一个handle
      if (typeof rval === 'number') {
        // 绑定v4
        rval = null;
        address = DEFAULT_IPV4_ADDR;
        addressType = 4;
      } else {
        // createServerHandle没有报错，支持v6
        address = DEFAULT_IPV6_ADDR;
        addressType = 6;
      }
    }
    // rval等于null说明createServerHandle报错，即handle没有创建成功，这里创建，否则说明创建成功了，不需要处理了
    if (rval === null)
      rval = createServerHandle(address, port, addressType, fd, flags);

    if (typeof rval === 'number') {
      const error = uvExceptionWithHostPort(rval, 'listen', address, port);
      process.nextTick(emitErrorNT, this, error);
      return;
    }
    this._handle = rval;
  }

  this[async_id_symbol] = getNewAsyncId(this._handle);
  // 有完成三次握手的连接时触发
  this._handle.onconnection = onconnection;
  this._handle[owner_symbol] = this;

  // Use a backlog of 512 entries. We pass 511 to the listen() call because
  // the kernel does: backlogsize = roundup_pow_of_two(backlogsize + 1);
  // which will thus give us a backlog of 512 entries.
  const err = this._handle.listen(backlog || 511);

  if (err) {
    const ex = uvExceptionWithHostPort(err, 'listen', address, port);
    this._handle.close();
    this._handle = null;
    defaultTriggerAsyncIdScope(this[async_id_symbol],
                               process.nextTick,
                               emitErrorNT,
                               this,
                               ex);
    return;
  }

  // Generate connection key, this should be unique to the connection
  this._connectionKey = addressType + ':' + address + ':' + port;

  // Unref the handle if the server was unref'ed prior to listening
  if (this._unref)
    this.unref();

  defaultTriggerAsyncIdScope(this[async_id_symbol],
                             process.nextTick,
                             emitListeningNT,
                             this);
}

Server.prototype._listen2 = setupListenHandle;  // legacy alias

function emitErrorNT(self, err) {
  self.emit('error', err);
}

// listen成功，触发回调
function emitListeningNT(self) {
  // Ensure handle hasn't closed
  if (self._handle)
    self.emit('listening');
}


function listenInCluster(server, address, port, addressType,
                         backlog, fd, exclusive, flags) {
  exclusive = !!exclusive;

  if (cluster === undefined) cluster = require('cluster');

  if (cluster.isMaster || exclusive) {
    // Will create a new handle
    // _listen2 sets up the listened handle, it is still named like this
    // to avoid breaking code that wraps this method
    server._listen2(address, port, addressType, backlog, fd, flags);
    return;
  }

  const serverQuery = {
    address: address,
    port: port,
    addressType: addressType,
    fd: fd,
    flags,
  };

  // Get the master's server handle, and listen on it
  cluster._getServer(server, serverQuery, listenOnMasterHandle);

  function listenOnMasterHandle(err, handle) {
    err = checkBindError(err, port, handle);

    if (err) {
      const ex = exceptionWithHostPort(err, 'bind', address, port);
      return server.emit('error', ex);
    }

    // Reuse master's server handle
    server._handle = handle;
    // _listen2 sets up the listened handle, it is still named like this
    // to avoid breaking code that wraps this method
    server._listen2(address, port, addressType, backlog, fd, flags);
  }
}


Server.prototype.listen = function(...args) {
  const normalized = normalizeArgs(args);
  let options = normalized[0];
  const cb = normalized[1];
  // listen过了
  if (this._handle) {
    throw new ERR_SERVER_ALREADY_LISTEN();
  }
  // 调用底层的listen函数成功后执行的回调
  if (cb !== null) {
    this.once('listening', cb);
  }
  // 获得backlog参数,还没完成连接的队列长度
  const backlogFromArgs =
    // (handle, backlog) or (path, backlog) or (port, backlog)
    toNumber(args.length > 1 && args[1]) ||
    toNumber(args.length > 2 && args[2]);  // (port, host, backlog)

  options = options._handle || options.handle || options;
  const flags = getFlags(options.ipv6Only);
  // (handle[, backlog][, cb]) where handle is an object with a handle
  // tcp
  if (options instanceof TCP) {
    this._handle = options;
    this[async_id_symbol] = this._handle.getAsyncId();
    listenInCluster(this, null, -1, -1, backlogFromArgs);
    return this;
  }
  // (handle[, backlog][, cb]) where handle is an object with a fd
  // fd
  if (typeof options.fd === 'number' && options.fd >= 0) {
    listenInCluster(this, null, null, null, backlogFromArgs, options.fd);
    return this;
  }

  // ([port][, host][, backlog][, cb]) where port is omitted,
  // that is, listen(), listen(null), listen(cb), or listen(null, cb)
  // or (options[, cb]) where options.port is explicitly set as undefined or
  // null, bind to an arbitrary unused port
  // 第一个参数是function或者传了port但是没有定义值
  if (args.length === 0 || typeof args[0] === 'function' ||
      (typeof options.port === 'undefined' && 'port' in options) ||
      options.port === null) {
    options.port = 0;
  }
  // ([port][, host][, backlog][, cb]) where port is specified
  // or (options[, cb]) where options.port is specified
  // or if options.port is normalized as 0 before
  let backlog;
  // 传了端口
  if (typeof options.port === 'number' || typeof options.port === 'string') {
    if (!isLegalPort(options.port)) {
      throw new ERR_SOCKET_BAD_PORT(options.port);
    }
    backlog = options.backlog || backlogFromArgs;
    // start TCP server listening on host:port
    // 传了host，先做dns解析，在listen
    if (options.host) {
      lookupAndListen(this, options.port | 0, options.host, backlog,
                      options.exclusive, flags);
    } else { // Undefined host, listens on unspecified address
      // Default addressType 4 will be used to search for master server
      // 没有传host，取本机地址
      listenInCluster(this, null, options.port | 0, 4,
                      backlog, undefined, options.exclusive);
    }
    return this;
  }

  // (path[, backlog][, cb]) or (options[, cb])
  // where path or options.path is a UNIX domain socket or Windows pipe
  // unix域
  if (options.path && isPipeName(options.path)) {
    const pipeName = this._pipeName = options.path;
    backlog = options.backlog || backlogFromArgs;
    listenInCluster(this, pipeName, -1, -1,
                    backlog, undefined, options.exclusive);

    if (!this._handle) {
      // Failed and an error shall be emitted in the next tick.
      // Therefore, we directly return.
      return this;
    }

    let mode = 0;
    if (options.readableAll === true)
      mode |= PipeConstants.UV_READABLE;
    if (options.writableAll === true)
      mode |= PipeConstants.UV_WRITABLE;
    if (mode !== 0) {
      // 修改文件的访问属性
      const err = this._handle.fchmod(mode);
      if (err) {
        this._handle.close();
        this._handle = null;
        throw errnoException(err, 'uv_pipe_chmod');
      }
    }
    return this;
  }

  if (!(('port' in options) || ('path' in options))) {
    throw new ERR_INVALID_ARG_VALUE('options', options,
                                    'must have the property "port" or "path"');
  }

  throw new ERR_INVALID_OPT_VALUE('options', inspect(options));
};
// dns查询完后再listen
function lookupAndListen(self, port, address, backlog, exclusive, flags) {
  if (dns === undefined) dns = require('dns');
  dns.lookup(address, function doListen(err, ip, addressType) {
    if (err) {
      self.emit('error', err);
    } else {
      addressType = ip ? addressType : 4;
      listenInCluster(self, ip, port, addressType,
                      backlog, undefined, exclusive, flags);
    }
  });
}
// 还没有handle或者handle还没销毁
ObjectDefineProperty(Server.prototype, 'listening', {
  get: function() {
    return !!this._handle;
  },
  configurable: true,
  enumerable: true
});
// 获取监听socket对应的地址
Server.prototype.address = function() {
  // 调底层函数
  if (this._handle && this._handle.getsockname) {
    const out = {};
    const err = this._handle.getsockname(out);
    if (err) {
      throw errnoException(err, 'address');
    }
    return out;
  // unix域路径
  } else if (this._pipeName) {
    return this._pipeName;
  } else {
    return null;
  }
};

function onconnection(err, clientHandle) {
  const handle = this;
  // handle所属的server对象
  const self = handle[owner_symbol];

  debug('onconnection');

  if (err) {
    self.emit('error', errnoException(err, 'accept'));
    return;
  }
  // 连接过载
  if (self.maxConnections && self._connections >= self.maxConnections) {
    clientHandle.close();
    return;
  }

  const socket = new Socket({
    handle: clientHandle,
    allowHalfOpen: self.allowHalfOpen,
    pauseOnCreate: self.pauseOnConnect,
    readable: true,
    writable: true
  });
  // 连接数加一
  self._connections++;
  socket.server = self;
  socket._server = self;

  DTRACE_NET_SERVER_CONNECTION(socket);
  // 触发server对象的connection事件，由用户定义的回调
  self.emit('connection', socket);
}


Server.prototype.getConnections = function(cb) {
  const self = this;

  function end(err, connections) {
    defaultTriggerAsyncIdScope(self[async_id_symbol],
                               process.nextTick,
                               cb,
                               err,
                               connections);
  }

  if (!this._usingWorkers) {
    end(null, this._connections);
    return this;
  }

  // Poll workers
  let left = this._workers.length;
  let total = this._connections;

  function oncount(err, count) {
    if (err) {
      left = -1;
      return end(err);
    }

    total += count;
    if (--left === 0) return end(null, total);
  }

  for (let n = 0; n < this._workers.length; n++) {
    this._workers[n].getConnections(oncount);
  }

  return this;
};

// 关闭handle
Server.prototype.close = function(cb) {
  if (typeof cb === 'function') {
    if (!this._handle) {
      this.once('close', function close() {
        cb(new ERR_SERVER_NOT_RUNNING());
      });
    } else {
      this.once('close', cb);
    }
  }

  if (this._handle) {
    this._handle.close();
    this._handle = null;
  }
  // 关闭所有关联的worker再触发server的close事件
  if (this._usingWorkers) {
    let left = this._workers.length;
    const onWorkerClose = () => {
      // 是否全部worker都close了
      if (--left !== 0) return;

      this._connections = 0;
      this._emitCloseIfDrained();
    };

    // Increment connections to be sure that, even if all sockets will be closed
    // during polling of workers, `close` event will be emitted only once.
    this._connections++;

    // Poll workers
    for (let n = 0; n < this._workers.length; n++)
      this._workers[n].close(onWorkerClose);
  } else {
    this._emitCloseIfDrained();
  }

  return this;
};

Server.prototype._emitCloseIfDrained = function() {
  debug('SERVER _emitCloseIfDrained');

  if (this._handle || this._connections) {
    debug('SERVER handle? %j   connections? %d',
          !!this._handle, this._connections);
    return;
  }

  defaultTriggerAsyncIdScope(this[async_id_symbol],
                             process.nextTick,
                             emitCloseNT,
                             this);
};


function emitCloseNT(self) {
  debug('SERVER: emit close');
  self.emit('close');
}


Server.prototype[EventEmitter.captureRejectionSymbol] = function(
  err, event, sock) {

  switch (event) {
    case 'connection':
      sock.destroy(err);
      break;
    default:
      this.emit('error', err);
  }
};


// Legacy alias on the C++ wrapper object. This is not public API, so we may
// want to runtime-deprecate it at some point. There's no hurry, though.
ObjectDefineProperty(TCP.prototype, 'owner', {
  get() { return this[owner_symbol]; },
  set(v) { return this[owner_symbol] = v; }
});

ObjectDefineProperty(Socket.prototype, '_handle', {
  get() { return this[kHandle]; },
  set(v) { return this[kHandle] = v; }
});

Server.prototype._setupWorker = function(socketList) {
  this._usingWorkers = true;
  this._workers.push(socketList);
  socketList.once('exit', (socketList) => {
    const index = this._workers.indexOf(socketList);
    this._workers.splice(index, 1);
  });
};

Server.prototype.ref = function() {
  this._unref = false;

  if (this._handle)
    this._handle.ref();

  return this;
};

Server.prototype.unref = function() {
  this._unref = true;

  if (this._handle)
    this._handle.unref();

  return this;
};

let _setSimultaneousAccepts;
let warnSimultaneousAccepts = true;

if (process.platform === 'win32') {
  let simultaneousAccepts;

  _setSimultaneousAccepts = function(handle) {
    if (warnSimultaneousAccepts) {
      process.emitWarning(
        'net._setSimultaneousAccepts() is deprecated and will be removed.',
        'DeprecationWarning', 'DEP0121');
      warnSimultaneousAccepts = false;
    }
    if (handle === undefined) {
      return;
    }

    if (simultaneousAccepts === undefined) {
      simultaneousAccepts = (process.env.NODE_MANY_ACCEPTS &&
                             process.env.NODE_MANY_ACCEPTS !== '0');
    }

    if (handle._simultaneousAccepts !== simultaneousAccepts) {
      handle.setSimultaneousAccepts(!!simultaneousAccepts);
      handle._simultaneousAccepts = simultaneousAccepts;
    }
  };
} else {
  _setSimultaneousAccepts = function() {
    if (warnSimultaneousAccepts) {
      process.emitWarning(
        'net._setSimultaneousAccepts() is deprecated and will be removed.',
        'DeprecationWarning', 'DEP0121');
      warnSimultaneousAccepts = false;
    }
  };
}

module.exports = {
  _createServerHandle: createServerHandle,
  _normalizeArgs: normalizeArgs,
  _setSimultaneousAccepts,
  connect,
  createConnection: connect,
  createServer,
  isIP: isIP,
  isIPv4: isIPv4,
  isIPv6: isIPv6,
  Server,
  Socket,
  Stream: Socket, // Legacy naming
};
