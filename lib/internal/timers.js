'use strict';

// HOW and WHY the timers implementation works the way it does.
//
// Timers are crucial to Node.js. Internally, any TCP I/O connection creates a
// timer so that we can time out of connections. Additionally, many user
// libraries and applications also use timers. As such there may be a
// significantly large amount of timeouts scheduled at any given time.
// Therefore, it is very important that the timers implementation is performant
// and efficient.
//
// Note: It is suggested you first read through the lib/internal/linkedlist.js
// linked list implementation, since timers depend on it extensively. It can be
// somewhat counter-intuitive at first, as it is not actually a class. Instead,
// it is a set of helpers that operate on an existing object.
//
// In order to be as performant as possible, the architecture and data
// structures are designed so that they are optimized to handle the following
// use cases as efficiently as possible:

// - Adding a new timer. (insert)
// - Removing an existing timer. (remove)
// - Handling a timer timing out. (timeout)
//
// Whenever possible, the implementation tries to make the complexity of these
// operations as close to constant-time as possible.
// (So that performance is not impacted by the number of scheduled timers.)
//
// Object maps are kept which contain linked lists keyed by their duration in
// milliseconds.
//
/* eslint-disable node-core/non-ascii-character */
//
// ╔════ > Object Map
// ║
// ╠══
// ║ lists: { '40': { }, '320': { etc } } (keys of millisecond duration)
// ╚══          ┌────┘
//              │
// ╔══          │
// ║ TimersList { _idleNext: { }, _idlePrev: (self) }
// ║         ┌────────────────┘
// ║    ╔══  │                              ^
// ║    ║    { _idleNext: { },  _idlePrev: { }, _onTimeout: (callback) }
// ║    ║      ┌───────────┘
// ║    ║      │                                  ^
// ║    ║      { _idleNext: { etc },  _idlePrev: { }, _onTimeout: (callback) }
// ╠══  ╠══
// ║    ║
// ║    ╚════ >  Actual JavaScript timeouts
// ║
// ╚════ > Linked List
//
/* eslint-enable node-core/non-ascii-character */
//
// With this, virtually constant-time insertion (append), removal, and timeout
// is possible in the JavaScript layer. Any one list of timers is able to be
// sorted by just appending to it because all timers within share the same
// duration. Therefore, any timer added later will always have been scheduled to
// timeout later, thus only needing to be appended.
// Removal from an object-property linked list is also virtually constant-time
// as can be seen in the lib/internal/linkedlist.js implementation.
// Timeouts only need to process any timers currently due to expire, which will
// always be at the beginning of the list for reasons stated above. Any timers
// after the first one encountered that does not yet need to timeout will also
// always be due to timeout at a later time.
//
// Less-than constant time operations are thus contained in two places:
// The PriorityQueue — an efficient binary heap implementation that does all
// operations in worst-case O(log n) time — which manages the order of expiring
// Timeout lists and the object map lookup of a specific list by the duration of
// timers within (or creation of a new list). However, these operations combined
// have shown to be trivial in comparison to other timers architectures.

const {
  MathMax,
  MathTrunc,
  NumberMIN_SAFE_INTEGER,
  ObjectCreate,
  Symbol,
} = primordials;

const {
  scheduleTimer,
  toggleTimerRef,
  getLibuvNow,
  immediateInfo
} = internalBinding('timers');

const {
  getDefaultTriggerAsyncId,
  newAsyncId,
  initHooksExist,
  destroyHooksExist,
  // The needed emit*() functions.
  emitInit,
  emitBefore,
  emitAfter,
  emitDestroy
} = require('internal/async_hooks');

// Symbols for storing async id state.
const async_id_symbol = Symbol('asyncId');
const trigger_async_id_symbol = Symbol('triggerId');

const {
  ERR_INVALID_CALLBACK,
  ERR_OUT_OF_RANGE
} = require('internal/errors').codes;
const { validateNumber } = require('internal/validators');

const L = require('internal/linkedlist');
const PriorityQueue = require('internal/priority_queue');

const { inspect } = require('internal/util/inspect');
const debug = require('internal/util/debuglog').debuglog('timer');

// *Must* match Environment::ImmediateInfo::Fields in src/env.h.
const kCount = 0;
const kRefCount = 1;
const kHasOutstanding = 2;

// Timeout values > TIMEOUT_MAX are set to 1.
const TIMEOUT_MAX = 2 ** 31 - 1;

let timerListId = NumberMIN_SAFE_INTEGER;

const kRefed = Symbol('refed');

// Create a single linked list instance only once at startup
const immediateQueue = new ImmediateList();

let nextExpiry = Infinity;
let refCount = 0;

// This is a priority queue with a custom sorting function that first compares
// the expiry times of two lists and if they're the same then compares their
// individual IDs to determine which list was created first.
const timerListQueue = new PriorityQueue(compareTimersLists, setPosition);

// Object map containing linked lists of timers, keyed and sorted by their
// duration in milliseconds.
//
// - key = time in milliseconds
// - value = linked list
const timerListMap = ObjectCreate(null);

function initAsyncResource(resource, type) {
  const asyncId = resource[async_id_symbol] = newAsyncId();
  const triggerAsyncId =
    resource[trigger_async_id_symbol] = getDefaultTriggerAsyncId();
  if (initHooksExist())
    emitInit(asyncId, type, triggerAsyncId, resource);
}

// Timer constructor function.
// The entire prototype is defined in lib/timers.js
function Timeout(callback, after, args, isRepeat, isRefed) {
  after *= 1; // Coalesce to number or NaN
  if (!(after >= 1 && after <= TIMEOUT_MAX)) {
    if (after > TIMEOUT_MAX) {
      process.emitWarning(`${after} does not fit into` +
                          ' a 32-bit signed integer.' +
                          '\nTimeout duration was set to 1.',
                          'TimeoutOverflowWarning');
    }
    after = 1; // Schedule on next tick, follows browser behavior
  }
  // 超时时间相对值
  this._idleTimeout = after;
  // 前后指针，用于链表
  this._idlePrev = this;
  this._idleNext = this;
  // 定时器的开始时间
  this._idleStart = null;
  // This must be set to null first to avoid function tracking
  // on the hidden class, revisit in V8 versions after 6.2
  // 超时回调
  this._onTimeout = null;
  this._onTimeout = callback;
  // 执行回调时传入的参数
  this._timerArgs = args;
  // 是否定期执行回调，用于setInterval
  this._repeat = isRepeat ? after : null;
  this._destroyed = false;
  // 激活底层的定时器节点（二叉堆的节点），说明有定时节点需要处理
  if (isRefed)
    incRefCount();
  this[kRefed] = isRefed;

  initAsyncResource(this, 'Timeout');
}

// Make sure the linked list only shows the minimal necessary information.
Timeout.prototype[inspect.custom] = function(_, options) {
  return inspect(this, {
    ...options,
    // Only inspect one level.
    depth: 0,
    // It should not recurse.
    customInspect: false
  });
};

Timeout.prototype.refresh = function() {
  if (this[kRefed])
    active(this);
  else
    unrefActive(this);

  return this;
};

Timeout.prototype.unref = function() {
  if (this[kRefed]) {
    this[kRefed] = false;
    if (!this._destroyed)
      decRefCount();
  }
  return this;
};

Timeout.prototype.ref = function() {
  if (!this[kRefed]) {
    this[kRefed] = true;
    if (!this._destroyed)
      incRefCount();
  }
  return this;
};

Timeout.prototype.hasRef = function() {
  return this[kRefed];
};
// expiry是超时时间的绝对值。用来记录队列中最快到期的节点的时间，msecs是超时时间的相对值（相对插入时的当前时间） 
function TimersList(expiry, msecs) {
  // 用于链表
  this._idleNext = this; // Create the list with the linkedlist properties to
  this._idlePrev = this; // Prevent any unnecessary hidden class changes.
  this.expiry = expiry;
  this.id = timerListId++;
  this.msecs = msecs;
  // 在优先队列里的位置
  this.priorityQueuePosition = null;
}

// Make sure the linked list only shows the minimal necessary information.
TimersList.prototype[inspect.custom] = function(_, options) {
  return inspect(this, {
    ...options,
    // Only inspect one level.
    depth: 0,
    // It should not recurse.
    customInspect: false
  });
};

// A linked list for storing `setImmediate()` requests
// 双向非循环的链表
function ImmediateList() {
  this.head = null;
  this.tail = null;
}

// Appends an item to the end of the linked list, adjusting the current tail's
// previous and next pointers where applicable
ImmediateList.prototype.append = function(item) {
  // 尾指针非空，说明链表非空，直接追加在尾节点后面
  if (this.tail !== null) {
    this.tail._idleNext = item;
    item._idlePrev = this.tail;
  } else {
    // 尾指针是空说明链表是空的，头尾指针都指向item
    this.head = item;
  }
  this.tail = item;
};

// Removes an item from the linked list, adjusting the pointers of adjacent
// items and the linked list's head or tail pointers as necessary
ImmediateList.prototype.remove = function(item) {
  // 如果item在中间则自己全身而退，前后两个节点连上
  if (item._idleNext !== null) {
    item._idleNext._idlePrev = item._idlePrev;
  }

  if (item._idlePrev !== null) {
    item._idlePrev._idleNext = item._idleNext;
  }
  // 是头指针，则需要更新头指针指向item的下一个，因为item被删除了，尾指针同理
  if (item === this.head)
    this.head = item._idleNext;
  if (item === this.tail)
    this.tail = item._idlePrev;
  // 重置前后指针
  item._idleNext = null;
  item._idlePrev = null;
};

function incRefCount() {
  if (refCount++ === 0)
    toggleTimerRef(true);
}

function decRefCount() {
  if (--refCount === 0)
    toggleTimerRef(false);
}

// Schedule or re-schedule a timer.
// The item must have been enroll()'d first.
function active(item) {
  insertGuarded(item, true);
}

// Internal APIs that need timeouts should use `unrefActive()` instead of
// `active()` so that they do not unnecessarily keep the process open.
function unrefActive(item) {
  insertGuarded(item, false);
}

// The underlying logic for scheduling or re-scheduling a timer.
//
// Appends a timer onto the end of an existing timers list, or creates a new
// list if one does not already exist for the specified timeout duration.
function insertGuarded(item, refed, start) {
  const msecs = item._idleTimeout;
  if (msecs < 0 || msecs === undefined)
    return;

  insert(item, msecs, start);

  const isDestroyed = item._destroyed;
  if (isDestroyed || !item[async_id_symbol]) {
    item._destroyed = false;
    initAsyncResource(item, 'Timeout');
  }

  if (isDestroyed) {
    if (refed)
      incRefCount();
  } else if (refed === !item[kRefed]) {
    if (refed)
      incRefCount();
    else
      decRefCount();
  }
  item[kRefed] = refed;
}

function insert(item, msecs, start = getLibuvNow()) {
  // Truncate so that accuracy of sub-milisecond timers is not assumed.
  msecs = MathTrunc(msecs);
  item._idleStart = start;

  // Use an existing list if there is one, otherwise we need to make a new one.
  let list = timerListMap[msecs];
  if (list === undefined) {
    debug('no %d list was found in insert, creating a new one', msecs);
    const expiry = start + msecs;
    timerListMap[msecs] = list = new TimersList(expiry, msecs);
    timerListQueue.insert(list);
    // 算出下一次超时的时间，即最快到期的时间
    if (nextExpiry > expiry) {
      scheduleTimer(msecs);
      nextExpiry = expiry;
    }
  }

  L.append(list, item);
}

function setUnrefTimeout(callback, after) {
  // Type checking identical to setTimeout()
  if (typeof callback !== 'function') {
    throw new ERR_INVALID_CALLBACK(callback);
  }

  const timer = new Timeout(callback, after, undefined, false, false);
  insert(timer, timer._idleTimeout);

  return timer;
}

// Type checking used by timers.enroll() and Socket#setTimeout()
function getTimerDuration(msecs, name) {
  validateNumber(msecs, name);
  if (msecs < 0 || !isFinite(msecs)) {
    throw new ERR_OUT_OF_RANGE(name, 'a non-negative finite number', msecs);
  }

  // Ensure that msecs fits into signed int32
  if (msecs > TIMEOUT_MAX) {
    process.emitWarning(`${msecs} does not fit into a 32-bit signed integer.` +
                        `\nTimer duration was truncated to ${TIMEOUT_MAX}.`,
                        'TimeoutOverflowWarning');
    return TIMEOUT_MAX;
  }

  return msecs;
}

function compareTimersLists(a, b) {
  const expiryDiff = a.expiry - b.expiry;
  if (expiryDiff === 0) {
    if (a.id < b.id)
      return -1;
    if (a.id > b.id)
      return 1;
  }
  return expiryDiff;
}

function setPosition(node, pos) {
  node.priorityQueuePosition = pos;
}

function getTimerCallbacks(runNextTicks) {
  // If an uncaught exception was thrown during execution of immediateQueue,
  // this queue will store all remaining Immediates that need to run upon
  // resolution of all error handling (if process is still alive).
  // 保存
  const outstandingQueue = new ImmediateList();

  function processImmediate() {
    // 上次执行processImmediate的时候有遗留的节点则执行outstandingQueue队列，这时候immediateQueue队列是空的
    const queue = outstandingQueue.head !== null ?
      outstandingQueue : immediateQueue;
    let immediate = queue.head;

    // Clear the linked list early in case new `setImmediate()`
    // calls occur while immediate callbacks are executed
    /*
      在执行immediateQueue队列的话，先置空队列，避免执行回调的时候一直往队列加节点，死循环。
      所以新加的接口会插入新的队列，不会在本次被执行。
      并打一个标记,全部immediateQueue节点都被执行则清空，否则会再执行processImmediate一次，见Environment::CheckImmediate
    */
    if (queue !== outstandingQueue) {
      queue.head = queue.tail = null;
      immediateInfo[kHasOutstanding] = 1;
    }

    let prevImmediate;
    let ranAtLeastOneImmediate = false;
    while (immediate !== null) {
      // 执行宏任务
      if (ranAtLeastOneImmediate)
        runNextTicks();
      else
        ranAtLeastOneImmediate = true;

      // It's possible for this current Immediate to be cleared while executing
      // the next tick queue above, which means we need to use the previous
      // Immediate's _idleNext which is guaranteed to not have been cleared.
      // 宏任务把该节点删除了，则不需要指向他的回调了，继续下一个
      if (immediate._destroyed) {
        outstandingQueue.head = immediate = prevImmediate._idleNext;
        continue;
      }

      immediate._destroyed = true;
      // 执行完要修改个数
      immediateInfo[kCount]--;
      if (immediate[kRefed])
        immediateInfo[kRefCount]--;
      immediate[kRefed] = null;
      // 见上面if (immediate._destroyed)的注释
      prevImmediate = immediate;

      const asyncId = immediate[async_id_symbol];
      emitBefore(asyncId, immediate[trigger_async_id_symbol]);
      // 执行回调，指向下一个节点
      try {
        const argv = immediate._argv;
        if (!argv)
          immediate._onImmediate();
        else
          immediate._onImmediate(...argv);
      } finally {
        immediate._onImmediate = null;

        if (destroyHooksExist())
          emitDestroy(asyncId);

        outstandingQueue.head = immediate = immediate._idleNext;
      }

      emitAfter(asyncId);
    }
    // 当前执行的是outstandingQueue的话则把他清空
    if (queue === outstandingQueue)
      outstandingQueue.head = null;
    // 全部节点执行完
    immediateInfo[kHasOutstanding] = 0;
  }


  function processTimers(now) {
    debug('process timer lists %d', now);
    nextExpiry = Infinity;

    let list;
    let ranAtLeastOneList = false;
    // 取出优先队列的根节点，即最快到期的节点
    while (list = timerListQueue.peek()) {
      // 还没过期，
      if (list.expiry > now) {
        nextExpiry = list.expiry;
        // 返回下一次过期的时间
        return refCount > 0 ? nextExpiry : -nextExpiry;
      }
      // 执行宏任务
      if (ranAtLeastOneList)
        runNextTicks();
      else
        ranAtLeastOneList = true;
      listOnTimeout(list, now);
    }
    return 0;
  }

  function listOnTimeout(list, now) {
    const msecs = list.msecs;

    debug('timeout callback %d', msecs);

    let ranAtLeastOneTimer = false;
    let timer;
    // 遍历具有统一相对过期时间的队列
    while (timer = L.peek(list)) {
      // 算出已经过去的时间
      const diff = now - timer._idleStart;

      // Check if this loop iteration is too early for the next timer.
      // This happens if there are more timers scheduled for later in the list.
      // 过期的时间比超时时间小，还没过期
      if (diff < msecs) {
        // 整个链表节点的最快过期时间等于当前还没过期节点的值，链表是有序的
        list.expiry = MathMax(timer._idleStart + msecs, now + 1);
        // 更新id，用于决定在优先队列里的位置
        list.id = timerListId++;
        // 调整过期时间后，当前链表对应的节点不一定是优先队列里的根节点了，可能有他更快到期，即当前链表需要往下沉
        timerListQueue.percolateDown(1);
        debug('%d list wait because diff is %d', msecs, diff);
        return;
      }

      if (ranAtLeastOneTimer)
        runNextTicks();
      else
        ranAtLeastOneTimer = true;

      // The actual logic for when a timeout happens.
      // 准备执行用户设置的回调，删除这个节点
      L.remove(timer);

      const asyncId = timer[async_id_symbol];

      if (!timer._onTimeout) {
        if (!timer._destroyed) {
          timer._destroyed = true;

          if (timer[kRefed])
            refCount--;

          if (destroyHooksExist())
            emitDestroy(asyncId);
        }
        continue;
      }

      emitBefore(asyncId, timer[trigger_async_id_symbol]);

      let start;
      if (timer._repeat)
        start = getLibuvNow();

      try {
        const args = timer._timerArgs;
        // 执行用户设置的回调
        if (args === undefined)
          timer._onTimeout();
        else
          timer._onTimeout(...args);
      } finally {
        // 设置了重复执行回调，即来自setInterval。则需要重新加入链表。
        if (timer._repeat && timer._idleTimeout !== -1) {
          // 更新超时时间，一样的时间间隔
          timer._idleTimeout = timer._repeat;
          // 重新插入链表
          insert(timer, timer._idleTimeout, start);
        } else if (!timer._idleNext && !timer._idlePrev && !timer._destroyed) {
          timer._destroyed = true;

          if (timer[kRefed])
            refCount--;

          if (destroyHooksExist())
            emitDestroy(asyncId);
        }
      }

      emitAfter(asyncId);
    }

    // If `L.peek(list)` returned nothing, the list was either empty or we have
    // called all of the timer timeouts.
    // As such, we can remove the list from the object map and
    // the PriorityQueue.
    debug('%d list empty', msecs);

    // The current list may have been removed and recreated since the reference
    // to `list` was created. Make sure they're the same instance of the list
    // before destroying.
    // 为空则删除
    if (list === timerListMap[msecs]) {
      delete timerListMap[msecs];
      timerListQueue.shift();
    }
  }

  return {
    processImmediate,
    processTimers
  };
}

module.exports = {
  TIMEOUT_MAX,
  kTimeout: Symbol('timeout'), // For hiding Timeouts on other internals.
  async_id_symbol,
  trigger_async_id_symbol,
  Timeout,
  kRefed,
  initAsyncResource,
  setUnrefTimeout,
  getTimerDuration,
  immediateQueue,
  getTimerCallbacks,
  immediateInfoFields: {
    kCount,
    kRefCount,
    kHasOutstanding
  },
  active,
  unrefActive,
  insert,
  timerListMap,
  timerListQueue,
  decRefCount,
  incRefCount
};
