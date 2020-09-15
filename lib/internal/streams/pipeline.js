// Ported from https://github.com/mafintosh/pump with
// permission from the author, Mathias Buus (@mafintosh).

'use strict';

const {
  ArrayIsArray,
  SymbolAsyncIterator,
  SymbolIterator
} = primordials;

let eos;

const { once } = require('internal/util');
const destroyImpl = require('internal/streams/destroy');
const {
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_RETURN_VALUE,
  ERR_INVALID_CALLBACK,
  ERR_MISSING_ARGS,
  ERR_STREAM_DESTROYED
} = require('internal/errors').codes;

let EE;
let PassThrough;
let createReadableStreamAsyncIterator;

function destroyer(stream, reading, writing, callback) {
  callback = once(callback);

  let closed = false;
  stream.on('close', () => {
    closed = true;
  });

  if (eos === undefined) eos = require('internal/streams/end-of-stream');
  eos(stream, { readable: reading, writable: writing }, (err) => {
    if (err) return callback(err);
    closed = true;
    callback();
  });

  let destroyed = false;
  return (err) => {
    if (closed) return;
    if (destroyed) return;
    destroyed = true;

    destroyImpl.destroyer(stream, err);

    callback(err || new ERR_STREAM_DESTROYED('pipe'));
  };
}

function popCallback(streams) {
  // Streams should never be an empty array. It should always contain at least
  // a single stream. Therefore optimize for the average case instead of
  // checking for length === 0 as well.
  if (typeof streams[streams.length - 1] !== 'function')
    throw new ERR_INVALID_CALLBACK(streams[streams.length - 1]);
  return streams.pop();
}

function isPromise(obj) {
  return !!(obj && typeof obj.then === 'function');
}

function isReadable(obj) {
  return !!(obj && typeof obj.pipe === 'function');
}

function isWritable(obj) {
  return !!(obj && typeof obj.write === 'function');
}

function isStream(obj) {
  return isReadable(obj) || isWritable(obj);
}

function isIterable(obj, isAsync) {
  if (!obj) return false;
  if (isAsync === true) return typeof obj[SymbolAsyncIterator] === 'function';
  if (isAsync === false) return typeof obj[SymbolIterator] === 'function';
  return typeof obj[SymbolAsyncIterator] === 'function' ||
    typeof obj[SymbolIterator] === 'function';
}

function makeAsyncIterable(val) {
  if (isIterable(val)) {
    return val;
  } else if (isReadable(val)) {
    // Legacy streams are not Iterable.
    return fromReadable(val);
  } else {
    throw new ERR_INVALID_ARG_TYPE(
      'val', ['Readable', 'Iterable', 'AsyncIterable'], val);
  }
}

async function* fromReadable(val) {
  if (!createReadableStreamAsyncIterator) {
    createReadableStreamAsyncIterator =
      require('internal/streams/async_iterator');
  }
  yield* createReadableStreamAsyncIterator(val);
}

async function pump(iterable, writable, finish) {
  if (!EE) {
    EE = require('events');
  }
  try {
    for await (const chunk of iterable) {
      if (!writable.write(chunk)) {
        if (writable.destroyed) return;
        await EE.once(writable, 'drain');
      }
    }
    writable.end();
  } catch (err) {
    finish(err);
  }
}

function pipeline(...streams) {
  const callback = once(popCallback(streams));

  if (ArrayIsArray(streams[0])) streams = streams[0];

  if (streams.length < 2) {
    throw new ERR_MISSING_ARGS('streams');
  }

  let error;
  const destroys = [];

  function finish(err, val, final) {
    if (!error && err) {
      error = err;
    }

    if (error || final) {
      for (const destroy of destroys) {
        destroy(error);
      }
    }

    if (final) {
      callback(error, val);
    }
  }

  function wrap(stream, reading, writing, final) {
    destroys.push(destroyer(stream, reading, writing, (err) => {
      finish(err, null, final);
    }));
  }

  let ret;
  for (let i = 0; i < streams.length; i++) {
    const stream = streams[i];
    const reading = i < streams.length - 1;
    const writing = i > 0;

    if (isStream(stream)) {
      wrap(stream, reading, writing, !reading);
    }

    if (i === 0) {
      if (typeof stream === 'function') {
        ret = stream();
        if (!isIterable(ret)) {
          throw new ERR_INVALID_RETURN_VALUE(
            'Iterable, AsyncIterable or Stream', 'source', ret);
        }
      } else if (isIterable(stream) || isReadable(stream)) {
        ret = stream;
      } else {
        throw new ERR_INVALID_ARG_TYPE(
          'source', ['Stream', 'Iterable', 'AsyncIterable', 'Function'],
          stream);
      }
    } else if (typeof stream === 'function') {
      ret = makeAsyncIterable(ret);
      ret = stream(ret);

      if (reading) {
        if (!isIterable(ret, true)) {
          throw new ERR_INVALID_RETURN_VALUE(
            'AsyncIterable', `transform[${i - 1}]`, ret);
        }
      } else {
        if (!PassThrough) {
          PassThrough = require('_stream_passthrough');
        }

        const pt = new PassThrough();
        if (isPromise(ret)) {
          ret
            .then((val) => {
              pt.end(val);
              finish(null, val, true);
            })
            .catch((err) => {
              finish(err, null, true);
            });
        } else if (isIterable(ret, true)) {
          pump(ret, pt, finish);
        } else {
          throw new ERR_INVALID_RETURN_VALUE(
            'AsyncIterable or Promise', 'destination', ret);
        }

        ret = pt;
        wrap(ret, true, false, true);
      }
    } else if (isStream(stream)) {
      if (isReadable(ret)) {
        ret.pipe(stream);
      } else {
        ret = makeAsyncIterable(ret);
        pump(ret, stream, finish);
      }
      ret = stream;
    } else {
      const name = reading ? `transform[${i - 1}]` : 'destination';
      throw new ERR_INVALID_ARG_TYPE(
        name, ['Stream', 'Function'], ret);
    }
  }

  return ret;
}

module.exports = pipeline;
