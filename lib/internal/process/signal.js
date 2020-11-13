'use strict';

const {
  Map,
} = primordials;

const {
  errnoException,
} = require('internal/errors');

const { signals } = internalBinding('constants').os;

let Signal;
const signalWraps = new Map();

function isSignal(event) {
  return typeof event === 'string' && signals[event] !== undefined;
}

// Detect presence of a listener for the special signal types
function startListeningIfSignal(type) {
  if (isSignal(type) && !signalWraps.has(type)) {
    if (Signal === undefined)
      Signal = internalBinding('signal_wrap').Signal;
    const wrap = new Signal();
    // 不影响事件循环的退出
    wrap.unref();
    // 挂载信号处理函数
    wrap.onsignal = process.emit.bind(process, type, type);
    // 通过字符拿到数字
    const signum = signals[type];
    // 注册信号
    const err = wrap.start(signum);
    if (err) {
      wrap.close();
      throw errnoException(err, 'uv_signal_start');
    }
    // 该信号已经注册，不需要往底层再注册了
    signalWraps.set(type, wrap);
  }
}

function stopListeningIfSignal(type) {
  const wrap = signalWraps.get(type);
  if (wrap !== undefined && process.listenerCount(type) === 0) {
    wrap.close();
    signalWraps.delete(type);
  }
}

module.exports = {
  startListeningIfSignal,
  stopListeningIfSignal
};
