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
  Array,
  Boolean,
  Error,
  MathMin,
  NumberIsNaN,
  ObjectCreate,
  ObjectDefineProperty,
  ObjectGetPrototypeOf,
  ObjectSetPrototypeOf,
  ObjectKeys,
  Promise,
  PromiseReject,
  PromiseResolve,
  ReflectApply,
  ReflectOwnKeys,
  Symbol,
  SymbolFor,
  SymbolAsyncIterator
} = primordials;
const kRejection = SymbolFor('nodejs.rejection');

let spliceOne;

const {
  kEnhanceStackBeforeInspector,
  codes
} = require('internal/errors');
const {
  ERR_INVALID_ARG_TYPE,
  ERR_OUT_OF_RANGE,
  ERR_UNHANDLED_ERROR
} = codes;

const {
  inspect
} = require('internal/util/inspect');

const kCapture = Symbol('kCapture');
const kErrorMonitor = Symbol('events.errorMonitor');

function EventEmitter(opts) {
  EventEmitter.init.call(this, opts);
}
module.exports = EventEmitter;
module.exports.once = once;
module.exports.on = on;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.usingDomains = false;

EventEmitter.captureRejectionSymbol = kRejection;
ObjectDefineProperty(EventEmitter, 'captureRejections', {
  get() {
    return EventEmitter.prototype[kCapture];
  },
  set(value) {
    if (typeof value !== 'boolean') {
      throw new ERR_INVALID_ARG_TYPE('EventEmitter.captureRejections',
                                     'boolean', value);
    }

    EventEmitter.prototype[kCapture] = value;
  },
  enumerable: true
});

ObjectDefineProperty(EventEmitter, 'errorMonitor', {
  value: kErrorMonitor,
  writable: false,
  configurable: true,
  enumerable: true
});

// The default for captureRejections is false
ObjectDefineProperty(EventEmitter.prototype, kCapture, {
  value: false,
  writable: true,
  enumerable: false
});

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._eventsCount = 0;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
// 同一类型事件最大的处理函数个数
let defaultMaxListeners = 10;

function checkListener(listener) {
  if (typeof listener !== 'function') {
    throw new ERR_INVALID_ARG_TYPE('listener', 'Function', listener);
  }
}

ObjectDefineProperty(EventEmitter, 'defaultMaxListeners', {
  enumerable: true,
  get: function() {
    return defaultMaxListeners;
  },
  set: function(arg) {
    if (typeof arg !== 'number' || arg < 0 || NumberIsNaN(arg)) {
      throw new ERR_OUT_OF_RANGE('defaultMaxListeners',
                                 'a non-negative number',
                                 arg);
    }
    defaultMaxListeners = arg;
  }
});

EventEmitter.init = function(opts) {
  // 如果是未初始化或者没有自定义_events，则初始化
  if (this._events === undefined ||
      this._events === ObjectGetPrototypeOf(this)._events) {
    this._events = ObjectCreate(null);
    this._eventsCount = 0;
  }
  // 初始化处理函数个数的阈值
  this._maxListeners = this._maxListeners || undefined;

  // 是否开启捕获promise reject,默认false
  if (opts && opts.captureRejections) {
    if (typeof opts.captureRejections !== 'boolean') {
      throw new ERR_INVALID_ARG_TYPE('options.captureRejections',
                                     'boolean', opts.captureRejections);
    }
    this[kCapture] = Boolean(opts.captureRejections);
  } else {
    // Assigning the kCapture property directly saves an expensive
    // prototype lookup in a very sensitive hot path.
    this[kCapture] = EventEmitter.prototype[kCapture];
  }
};
// 捕获promise
function addCatch(that, promise, type, args) {
  // 没有开启捕获则不需要处理
  if (!that[kCapture]) {
    return;
  }

  // Handle Promises/A+ spec, then could be a getter
  // that throws on second use.
  try {
    const then = promise.then;

    if (typeof then === 'function') {
      // 注册reject的处理函数
      then.call(promise, undefined, function(err) {
        // The callback is called with nextTick to avoid a follow-up
        // rejection from this promise.
        process.nextTick(emitUnhandledRejectionOrErr, that, err, type, args);
      });
    }
  } catch (err) {
    that.emit('error', err);
  }
}

function emitUnhandledRejectionOrErr(ee, err, type, args) {
  // 用户实现了kRejection则执行
  if (typeof ee[kRejection] === 'function') {
    ee[kRejection](err, type, ...args);
  } else {
    // We have to disable the capture rejections mechanism, otherwise
    // we might end up in an infinite loop.
    // 保存当前值
    const prev = ee[kCapture];

    // If the error handler throws, it is not catcheable and it
    // will end up in 'uncaughtException'. We restore the previous
    // value of kCapture in case the uncaughtException is present
    // and the exception is handled.
    try {
      /*
        关闭然后触发error事件，意义
        1 防止error事件处理函数也抛出error，导致死循环
        2 如果用户处理了error，则进程不会退出，所以需要恢复kCapture的值
          如果用户没有处理error，则nodejs会触发uncaughtException，如果用户
          处理了uncaughtException则需要灰度kCapture的值
      */
      ee[kCapture] = false;
      ee.emit('error', err);
    } finally {
      ee[kCapture] = prev;
    }
  }
}

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
// 设置最大处理函数个数的阈值
EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
  if (typeof n !== 'number' || n < 0 || NumberIsNaN(n)) {
    throw new ERR_OUT_OF_RANGE('n', 'a non-negative number', n);
  }
  this._maxListeners = n;
  return this;
};
// 获取处理函数个数的阈值，如果没有设置则返回默认的
function _getMaxListeners(that) {
  if (that._maxListeners === undefined)
    return EventEmitter.defaultMaxListeners;
  return that._maxListeners;
}

EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
  return _getMaxListeners(this);
};

// Returns the length and line number of the first sequence of `a` that fully
// appears in `b` with a length of at least 4.
function identicalSequenceRange(a, b) {
  for (let i = 0; i < a.length - 3; i++) {
    // Find the first entry of b that matches the current entry of a.
    const pos = b.indexOf(a[i]);
    if (pos !== -1) {
      const rest = b.length - pos;
      if (rest > 3) {
        let len = 1;
        const maxLen = MathMin(a.length - i, rest);
        // Count the number of consecutive entries.
        while (maxLen > len && a[i + len] === b[pos + len]) {
          len++;
        }
        if (len > 3) {
          return [len, i];
        }
      }
    }
  }

  return [0, 0];
}
// err是原始错误，own是处理err的函数的栈信息
function enhanceStackTrace(err, own) {
  let ctorInfo = '';
  try {
    // 构造函数名
    const { name } = this.constructor;
    if (name !== 'EventEmitter')
      ctorInfo = ` on ${name} instance`;
  } catch {}
  const sep = `\nEmitted 'error' event${ctorInfo} at:\n`;

  const errStack = err.stack.split('\n').slice(1);
  const ownStack = own.stack.split('\n').slice(1);

  const [ len, off ] = identicalSequenceRange(ownStack, errStack);
  if (len > 0) {
    ownStack.splice(off + 1, len - 2,
                    '    [... lines matching original stack trace ...]');
  }

  return err.stack + sep + ownStack.join('\n');
}

EventEmitter.prototype.emit = function emit(type, ...args) {
  // 触发的事件是否是error，error事件需要特殊处理
  let doError = (type === 'error');

  const events = this._events;
  // 定义了处理函数（不一定是type事件的处理函数）
  if (events !== undefined) {
    // 如果触发的事件是error，并且监听了kErrorMonitor事件则触发kErrorMonitor事件
    if (doError && events[kErrorMonitor] !== undefined)
      this.emit(kErrorMonitor, ...args);
    // 触发的是error事件但是没有定义处理函数
    doError = (doError && events.error === undefined);
  } else if (!doError) // 没有定义处理函数并且触发的不是error事件则不需要处理，
    return false;

  // If there is no 'error' event listener then throw.
  // 触发的是error事件，但是没有定义处理error事件的函数，则报错
  if (doError) {
    let er;
    if (args.length > 0)
      er = args[0];
    // 第一个入参是Error的实例
    if (er instanceof Error) {
      try {
        const capture = {};
        // eslint-disable-next-line no-restricted-syntax
        // 给capture对象注入stack属性，stack的值是执行Error.captureStackTrace语句的当前栈信息，但是不包括emit的部分
        Error.captureStackTrace(capture, EventEmitter.prototype.emit);
        ObjectDefineProperty(er, kEnhanceStackBeforeInspector, {
          value: enhanceStackTrace.bind(this, er, capture),
          configurable: true
        });
      } catch {}

      // Note: The comments on the `throw` lines are intentional, they show
      // up in Node's output if this results in an unhandled exception.
      throw er; // Unhandled 'error' event
    }

    let stringifiedEr;
    const { inspect } = require('internal/util/inspect');
    try {
      stringifiedEr = inspect(er);
    } catch {
      stringifiedEr = er;
    }

    // At least give some kind of context to the user
    const err = new ERR_UNHANDLED_ERROR(stringifiedEr);
    err.context = er;
    throw err; // Unhandled 'error' event
  }
  // 获取type事件对应的处理函数
  const handler = events[type];
  // 没有则不处理
  if (handler === undefined)
    return false;
  // 等于函数说明只有一个
  if (typeof handler === 'function') {
    // 直接执行
    const result = ReflectApply(handler, this, args);

    // We check if result is undefined first because that
    // is the most common case so we do not pay any perf
    // penalty
    // 非空判断是不是promise并且是否需要处理，见addCatch
    if (result !== undefined && result !== null) {
      addCatch(this, result, type, args);
    }
  } else {
    // 多个处理函数，同上
    const len = handler.length;
    const listeners = arrayClone(handler, len);
    for (let i = 0; i < len; ++i) {
      const result = ReflectApply(listeners[i], this, args);

      // We check if result is undefined first because that
      // is the most common case so we do not pay any perf
      // penalty.
      // This code is duplicated because extracting it away
      // would make it non-inlineable.
      if (result !== undefined && result !== null) {
        addCatch(this, result, type, args);
      }
    }
  }

  return true;
};

function _addListener(target, type, listener, prepend) {
  let m;
  let events;
  let existing;

  checkListener(listener);

  events = target._events;
  // 还没有初始化_events则初始化
  if (events === undefined) {
    events = target._events = ObjectCreate(null);
    target._eventsCount = 0;
  } else {
    // To avoid recursion in the case that type === "newListener"! Before
    // adding it to the listeners, first emit "newListener".
    // 是否定义了newListener事件，是的话先触发
    if (events.newListener !== undefined) {
      target.emit('newListener', type,
                  listener.listener ? listener.listener : listener);

      // Re-assign `events` because a newListener handler could have caused the
      // this._events to be assigned to a new object
      // 可能会修改_events，这里重新赋值
      events = target._events;
    }
    // 判断是否已经存在处理函数
    existing = events[type];
  }
  // 不存在则以函数的形式存储，否则是数组
  if (existing === undefined) {
    // Optimize the case of one listener. Don't need the extra array object.
    events[type] = listener;
    ++target._eventsCount;
  } else {
    if (typeof existing === 'function') {
      // Adding the second element, need to change to array.
      existing = events[type] =
        prepend ? [listener, existing] : [existing, listener];
      // If we've already got an array, just append.
    } else if (prepend) {
      existing.unshift(listener);
    } else {
      existing.push(listener);
    }

    // Check for listener leak
    // 处理告警，处理函数过多可能是因为之前的没有删除，造成内存泄漏
    m = _getMaxListeners(target);
    if (m > 0 && existing.length > m && !existing.warned) {
      existing.warned = true;
      // No error code for this since it is a Warning
      // eslint-disable-next-line no-restricted-syntax
      const w = new Error('Possible EventEmitter memory leak detected. ' +
                          `${existing.length} ${String(type)} listeners ` +
                          `added to ${inspect(target, { depth: -1 })}. Use ` +
                          'emitter.setMaxListeners() to increase limit');
      w.name = 'MaxListenersExceededWarning';
      w.emitter = target;
      w.type = type;
      w.count = existing.length;
      process.emitWarning(w);
    }
  }

  return target;
}

EventEmitter.prototype.addListener = function addListener(type, listener) {
  return _addListener(this, type, listener, false);
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.prependListener =
    function prependListener(type, listener) {
      return _addListener(this, type, listener, true);
    };

function onceWrapper() {
  // 还没有触发过
  if (!this.fired) {
    // 删除他
    this.target.removeListener(this.type, this.wrapFn);
    // 触发了
    this.fired = true;
    // 执行
    if (arguments.length === 0)
      return this.listener.call(this.target);
    return this.listener.apply(this.target, arguments);
  }
}
// 支持once api
function _onceWrap(target, type, listener) {
  // fired是否已执行处理函数，wrapFn包裹listener的函数
  const state = { fired: false, wrapFn: undefined, target, type, listener };
  // 生成一个包裹listener的函数
  const wrapped = onceWrapper.bind(state);
  // 把原函数listener也挂到包裹函数中，用于事件没有触发前，用户主动删除，见removeListener
  wrapped.listener = listener;
  // 保存包裹函数，用于执行完后删除，见onceWrapper
  state.wrapFn = wrapped;
  return wrapped;
}

EventEmitter.prototype.once = function once(type, listener) {
  checkListener(listener);

  this.on(type, _onceWrap(this, type, listener));
  return this;
};

EventEmitter.prototype.prependOnceListener =
    function prependOnceListener(type, listener) {
      checkListener(listener);

      this.prependListener(type, _onceWrap(this, type, listener));
      return this;
    };

// Emits a 'removeListener' event if and only if the listener was removed.
EventEmitter.prototype.removeListener =
    function removeListener(type, listener) {
      let originalListener;

      checkListener(listener);

      const events = this._events;
      // 没有东西可删除
      if (events === undefined)
        return this;

      const list = events[type];
      // 同上
      if (list === undefined)
        return this;
      // list是函数说明只有一个处理函数，否则是数组,如果list.listener === listener说明是once注册的
      if (list === listener || list.listener === listener) {
        // type类型的处理函数就一个，并且也没有注册其他类型的事件，则初始化_events
        if (--this._eventsCount === 0)
          this._events = ObjectCreate(null);
        else {
          // 就一个执行完删除type对应的属性
          delete events[type];
          // 注册了removeListener事件，则先注册removeListener事件
          if (events.removeListener)
            this.emit('removeListener', type, list.listener || listener);
        }
      } else if (typeof list !== 'function') {
        // 多个处理函数
        let position = -1;
        // 找出需要删除的函数
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i] === listener || list[i].listener === listener) {
            // 保存原处理函数，如果有的话
            originalListener = list[i].listener;
            position = i;
            break;
          }
        }

        if (position < 0)
          return this;
        // 第一个则出队，否则删除一个
        if (position === 0)
          list.shift();
        else {
          if (spliceOne === undefined)
            spliceOne = require('internal/util').spliceOne;
          spliceOne(list, position);
        }
        // 如果只剩下一个，则值改成函数类型
        if (list.length === 1)
          events[type] = list[0];
        // 触发removeListener
        if (events.removeListener !== undefined)
          this.emit('removeListener', type, originalListener || listener);
      }

      return this;
    };

EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

// 删除所有事件
EventEmitter.prototype.removeAllListeners =
    function removeAllListeners(type) {
      const events = this._events;
      if (events === undefined)
        return this;

      // Not listening for removeListener, no need to emit
      // 没有注册removeListener事件，则只需要删除数据，否则还需要触发removeListener事件
      if (events.removeListener === undefined) {
        // 等于0说明是删除全部
        if (arguments.length === 0) {
          this._events = ObjectCreate(null);
          this._eventsCount = 0;
        } else if (events[type] !== undefined) { // 否则是删除某个类型的事件，
          // 是唯一一个处理函数，则重置_events，否则删除对应的事件类型
          if (--this._eventsCount === 0)
            this._events = ObjectCreate(null);
          else
            delete events[type];
        }
        return this;
      }

      // Emit removeListener for all listeners on all events
      // 说明注册了removeListener事件，arguments.length === 0说明删除所有类型的事件
      if (arguments.length === 0) {
        // 逐个删除，除了removeListener事件，这里删除了非removeListener事件
        for (const key of ObjectKeys(events)) {
          if (key === 'removeListener') continue;
          this.removeAllListeners(key);
        }
        // 这里删除removeListener事件，见下面的逻辑
        this.removeAllListeners('removeListener');
        // 重置数据结构
        this._events = ObjectCreate(null);
        this._eventsCount = 0;
        return this;
      }
      // 删除某类型事件
      const listeners = events[type];

      if (typeof listeners === 'function') {
        this.removeListener(type, listeners);
      } else if (listeners !== undefined) {
        // LIFO order
        for (let i = listeners.length - 1; i >= 0; i--) {
          this.removeListener(type, listeners[i]);
        }
      }

      return this;
    };
// 返回指定的处理函数，unwrap用于处理once注册的事件，如果有的话，则返回用户定义的原始处理函数，而不是包裹函数
function _listeners(target, type, unwrap) {
  const events = target._events;

  if (events === undefined)
    return [];

  const evlistener = events[type];
  if (evlistener === undefined)
    return [];

  if (typeof evlistener === 'function')
    return unwrap ? [evlistener.listener || evlistener] : [evlistener];

  return unwrap ?
    unwrapListeners(evlistener) : arrayClone(evlistener, evlistener.length);
}

EventEmitter.prototype.listeners = function listeners(type) {
  return _listeners(this, type, true);
};

EventEmitter.prototype.rawListeners = function rawListeners(type) {
  return _listeners(this, type, false);
};
// 某类事件处理函数的个数
EventEmitter.listenerCount = function(emitter, type) {
  // 用户可以自定义listenerCount，否则使用默认的
  if (typeof emitter.listenerCount === 'function') {
    return emitter.listenerCount(type);
  } else {
    return listenerCount.call(emitter, type);
  }
};

EventEmitter.prototype.listenerCount = listenerCount;
function listenerCount(type) {
  const events = this._events;

  if (events !== undefined) {
    const evlistener = events[type];

    if (typeof evlistener === 'function') {
      return 1;
    } else if (evlistener !== undefined) {
      return evlistener.length;
    }
  }

  return 0;
}
// 事件类型个数
EventEmitter.prototype.eventNames = function eventNames() {
  return this._eventsCount > 0 ? ReflectOwnKeys(this._events) : [];
};

function arrayClone(arr, n) {
  const copy = new Array(n);
  for (let i = 0; i < n; ++i)
    copy[i] = arr[i];
  return copy;
}

function unwrapListeners(arr) {
  const ret = new Array(arr.length);
  for (let i = 0; i < ret.length; ++i) {
    ret[i] = arr[i].listener || arr[i];
  }
  return ret;
}
// 支持订阅发布模式的对象，比如浏览器的EventTarget
function once(emitter, name) {
  return new Promise((resolve, reject) => {
    // 支持addEventListener则直接执行，这里不需要注册error，因为他没有这个概念
    if (typeof emitter.addEventListener === 'function') {
      // EventTarget does not have `error` event semantics like Node
      // EventEmitters, we do not listen to `error` events here.
      emitter.addEventListener(
        name,
        (...args) => { resolve(args); },
        { once: true }
      );
      return;
    }
    // 非error事件触发的处理函数
    const eventListener = (...args) => {
      // 如果注册了error事件
      if (errorListener !== undefined) {
        emitter.removeListener('error', errorListener);
      }
      resolve(args);
    };
    let errorListener;

    // Adding an error listener is not optional because
    // if an error is thrown on an event emitter we cannot
    // guarantee that the actual event we are waiting will
    // be fired. The result could be a silent way to create
    // memory or file descriptor leaks, which is something
    // we should avoid.
    if (name !== 'error') {
      errorListener = (err) => {
        emitter.removeListener(name, eventListener);
        reject(err);
      };

      emitter.once('error', errorListener);
    }

    emitter.once(name, eventListener);
  });
}

const AsyncIteratorPrototype = ObjectGetPrototypeOf(
  ObjectGetPrototypeOf(async function* () {}).prototype);

function createIterResult(value, done) {
  return { value, done };
}

function on(emitter, event) {
  const unconsumedEvents = [];
  const unconsumedPromises = [];
  let error = null;
  let finished = false;

  const iterator = ObjectSetPrototypeOf({
    next() {
      // First, we consume all unread events
      const value = unconsumedEvents.shift();
      if (value) {
        return PromiseResolve(createIterResult(value, false));
      }

      // Then we error, if an error happened
      // This happens one time if at all, because after 'error'
      // we stop listening
      if (error) {
        const p = PromiseReject(error);
        // Only the first element errors
        error = null;
        return p;
      }

      // If the iterator is finished, resolve to done
      if (finished) {
        return PromiseResolve(createIterResult(undefined, true));
      }

      // Wait until an event happens
      return new Promise(function(resolve, reject) {
        unconsumedPromises.push({ resolve, reject });
      });
    },

    return() {
      emitter.removeListener(event, eventHandler);
      emitter.removeListener('error', errorHandler);
      finished = true;

      for (const promise of unconsumedPromises) {
        promise.resolve(createIterResult(undefined, true));
      }

      return PromiseResolve(createIterResult(undefined, true));
    },

    throw(err) {
      if (!err || !(err instanceof Error)) {
        throw new ERR_INVALID_ARG_TYPE('EventEmitter.AsyncIterator',
                                       'Error', err);
      }
      error = err;
      emitter.removeListener(event, eventHandler);
      emitter.removeListener('error', errorHandler);
    },

    [SymbolAsyncIterator]() {
      return this;
    }
  }, AsyncIteratorPrototype);

  emitter.on(event, eventHandler);
  emitter.on('error', errorHandler);

  return iterator;

  function eventHandler(...args) {
    const promise = unconsumedPromises.shift();
    if (promise) {
      promise.resolve(createIterResult(args, false));
    } else {
      unconsumedEvents.push(args);
    }
  }

  function errorHandler(err) {
    finished = true;

    const toError = unconsumedPromises.shift();

    if (toError) {
      toError.reject(err);
    } else {
      // The next time we call next()
      error = err;
    }

    iterator.return();
  }
}
