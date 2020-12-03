#ifndef SRC_STREAM_BASE_INL_H_
#define SRC_STREAM_BASE_INL_H_

#if defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS

#include "stream_base.h"

#include "node.h"
#include "env-inl.h"
#include "v8.h"

namespace node {

using v8::Signature;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::HandleScope;
using v8::Local;
using v8::Object;
using v8::PropertyAttribute;
using v8::PropertyCallbackInfo;
using v8::String;
using v8::Value;

inline void StreamReq::AttachToObject(v8::Local<v8::Object> req_wrap_obj) {
  CHECK_EQ(req_wrap_obj->GetAlignedPointerFromInternalField(kStreamReqField),
           nullptr);
  req_wrap_obj->SetAlignedPointerInInternalField(kStreamReqField, this);
}

inline StreamReq* StreamReq::FromObject(v8::Local<v8::Object> req_wrap_obj) {
  return static_cast<StreamReq*>(
      req_wrap_obj->GetAlignedPointerFromInternalField(kStreamReqField));
}

inline void StreamReq::Dispose() {
  object()->SetAlignedPointerInInternalField(kStreamReqField, nullptr);
  delete this;
}
// 获取和该请求相关联的原始js对象
inline v8::Local<v8::Object> StreamReq::object() {
  return GetAsyncWrap()->object();
}
// 从listen所属的流的listener队列中删除自己
inline StreamListener::~StreamListener() {
  if (stream_ != nullptr)
    stream_->RemoveStreamListener(this);
}

inline void StreamListener::PassReadErrorToPreviousListener(ssize_t nread) {
  CHECK_NOT_NULL(previous_listener_);
  previous_listener_->OnStreamRead(nread, uv_buf_init(nullptr, 0));
}
// 实现流关闭时的处理逻辑
inline void StreamListener::OnStreamAfterShutdown(ShutdownWrap* w, int status) {
  CHECK_NOT_NULL(previous_listener_);
  previous_listener_->OnStreamAfterShutdown(w, status);
}
// 实现写结束时的处理逻辑
inline void StreamListener::OnStreamAfterWrite(WriteWrap* w, int status) {
  CHECK_NOT_NULL(previous_listener_);
  previous_listener_->OnStreamAfterWrite(w, status);
}
// 逐个销毁listener然后把它从队列中删除
inline StreamResource::~StreamResource() {
  while (listener_ != nullptr) {
    StreamListener* listener = listener_;
    listener->OnStreamDestroy();
    // Remove the listener if it didn’t remove itself. This makes the logic
    // in `OnStreamDestroy()` implementations easier, because they
    // may call generic cleanup functions which can just remove the
    // listener unconditionally.
    if (listener == listener_)
      RemoveStreamListener(listener_);
  }
}
// 增加一个listener
inline void StreamResource::PushStreamListener(StreamListener* listener) {
  CHECK_NOT_NULL(listener);
  CHECK_NULL(listener->stream_);
  // 头插法 
  listener->previous_listener_ = listener_;
  listener->stream_ = this;

  listener_ = listener;
}
// 删除listener
inline void StreamResource::RemoveStreamListener(StreamListener* listener) {
  CHECK_NOT_NULL(listener);

  StreamListener* previous;
  StreamListener* current;

  // Remove from the linked list. 遍历单链表
  for (current = listener_, previous = nullptr;
       /* No loop condition because we want a crash if listener is not found */
       ; previous = current, current = current->previous_listener_) {
    CHECK_NOT_NULL(current);
    if (current == listener) {
      // 非空说明需要删除的不是第一个节点
      if (previous != nullptr)
        previous->previous_listener_ = current->previous_listener_;
      else
        // 删除的是第一个节点，更新头指针就行
        listener_ = listener->previous_listener_;
      break;
    }
  }
  // 重置
  listener->stream_ = nullptr;
  listener->previous_listener_ = nullptr;
}
// 有数据可读时执行的回调，申请一块内存准备保存数据，资源方只负责同通知listener，具体逻辑在listener中实现
inline uv_buf_t StreamResource::EmitAlloc(size_t suggested_size) {
  DebugSealHandleScope handle_scope(v8::Isolate::GetCurrent());
  return listener_->OnStreamAlloc(suggested_size);
}

inline void StreamResource::EmitRead(ssize_t nread, const uv_buf_t& buf) {
  DebugSealHandleScope handle_scope(v8::Isolate::GetCurrent());
  // bytes_read_表示已读的字节数
  if (nread > 0)
    bytes_read_ += static_cast<uint64_t>(nread);
  listener_->OnStreamRead(nread, buf);
}

inline void StreamResource::EmitAfterWrite(WriteWrap* w, int status) {
  DebugSealHandleScope handle_scope(v8::Isolate::GetCurrent());
  listener_->OnStreamAfterWrite(w, status);
}

inline void StreamResource::EmitAfterShutdown(ShutdownWrap* w, int status) {
  DebugSealHandleScope handle_scope(v8::Isolate::GetCurrent());
  listener_->OnStreamAfterShutdown(w, status);
}

inline void StreamResource::EmitWantsWrite(size_t suggested_size) {
  DebugSealHandleScope handle_scope(v8::Isolate::GetCurrent());
  listener_->OnStreamWantsWrite(suggested_size);
}
// 继承StreamBase流的类默认拥有一个listener
inline StreamBase::StreamBase(Environment* env) : env_(env) {
  PushStreamListener(&default_listener_);
}

inline Environment* StreamBase::stream_env() const {
  return env_;
}
// 关闭一个流，req_wrap_obj是js层传进来的对象
inline int StreamBase::Shutdown(v8::Local<v8::Object> req_wrap_obj) {
  Environment* env = stream_env();

  HandleScope handle_scope(env->isolate());

  if (req_wrap_obj.IsEmpty()) {
    if (!env->shutdown_wrap_template()
             ->NewInstance(env->context())
             .ToLocal(&req_wrap_obj)) {
      return UV_EBUSY;
    }
    StreamReq::ResetObject(req_wrap_obj);
  }

  AsyncHooks::DefaultTriggerAsyncIdScope trigger_scope(GetAsyncWrap());
  // 创建一个用于请求Libuv的数据结构
  ShutdownWrap* req_wrap = CreateShutdownWrap(req_wrap_obj);
  // 子类实现，不同流关闭的逻辑不一样 
  int err = DoShutdown(req_wrap);
  // 执行出错则销毁js层对象
  if (err != 0 && req_wrap != nullptr) {
    req_wrap->Dispose();
  }

  const char* msg = Error();
  if (msg != nullptr) {
    req_wrap_obj->Set(
        env->context(),
        env->error_string(), OneByteString(env->isolate(), msg)).Check();
    ClearError();
  }

  return err;
}

inline StreamWriteResult StreamBase::Write(
    uv_buf_t* bufs,
    size_t count,
    uv_stream_t* send_handle,
    v8::Local<v8::Object> req_wrap_obj) {
  Environment* env = stream_env();
  int err;

  size_t total_bytes = 0;
  // 计算需要写入的数据大小
  for (size_t i = 0; i < count; ++i)
    total_bytes += bufs[i].len;
  // 同上
  bytes_written_ += total_bytes;
  // 是否需要发送文件描述符，不需要则直接写
  if (send_handle == nullptr) {
    err = DoTryWrite(&bufs, &count);
    if (err != 0 || count == 0) {
      return StreamWriteResult { false, err, nullptr, total_bytes };
    }
  }

  HandleScope handle_scope(env->isolate());

  if (req_wrap_obj.IsEmpty()) {
    if (!env->write_wrap_template()
             ->NewInstance(env->context())
             .ToLocal(&req_wrap_obj)) {
      return StreamWriteResult { false, UV_EBUSY, nullptr, 0 };
    }
    StreamReq::ResetObject(req_wrap_obj);
  }

  AsyncHooks::DefaultTriggerAsyncIdScope trigger_scope(GetAsyncWrap());
  // 创建一个用于请求Libuv的写请求对象
  WriteWrap* req_wrap = CreateWriteWrap(req_wrap_obj);
  // 执行写
  err = DoWrite(req_wrap, bufs, count, send_handle);
  bool async = err == 0;

  if (!async) {
    req_wrap->Dispose();
    req_wrap = nullptr;
  }

  const char* msg = Error();
  if (msg != nullptr) {
    req_wrap_obj->Set(env->context(),
                      env->error_string(),
                      OneByteString(env->isolate(), msg)).Check();
    ClearError();
  }

  return StreamWriteResult { async, err, req_wrap, total_bytes };
}

template <typename OtherBase>
SimpleShutdownWrap<OtherBase>::SimpleShutdownWrap(
    StreamBase* stream,
    v8::Local<v8::Object> req_wrap_obj)
  : ShutdownWrap(stream, req_wrap_obj),
    OtherBase(stream->stream_env(),
              req_wrap_obj,
              AsyncWrap::PROVIDER_SHUTDOWNWRAP) {
}

inline ShutdownWrap* StreamBase::CreateShutdownWrap(
    v8::Local<v8::Object> object) {
  return new SimpleShutdownWrap<AsyncWrap>(this, object);
}

template <typename OtherBase>
SimpleWriteWrap<OtherBase>::SimpleWriteWrap(
    StreamBase* stream,
    v8::Local<v8::Object> req_wrap_obj)
  : WriteWrap(stream, req_wrap_obj),
    OtherBase(stream->stream_env(),
              req_wrap_obj,
              AsyncWrap::PROVIDER_WRITEWRAP) {
}

inline WriteWrap* StreamBase::CreateWriteWrap(
    v8::Local<v8::Object> object) {
  return new SimpleWriteWrap<AsyncWrap>(this, object);
}

inline void StreamBase::AttachToObject(v8::Local<v8::Object> obj) {
  obj->SetAlignedPointerInInternalField(kStreamBaseField, this);
}

inline StreamBase* StreamBase::FromObject(v8::Local<v8::Object> obj) {
  if (obj->GetAlignedPointerFromInternalField(0) == nullptr)
    return nullptr;

  return static_cast<StreamBase*>(
      obj->GetAlignedPointerFromInternalField(kStreamBaseField));
}

/*
  关闭结束时回调，由请求类（ShutdownWrap）调用Libuv，
  所以Libuv操作完成后，首先执行请求类的回调，请求类通知流，流触发
  对应的事件，进一步通知listener
*/
inline void ShutdownWrap::OnDone(int status) {
  stream()->EmitAfterShutdown(this, status);
  Dispose();
}

inline void WriteWrap::SetAllocatedStorage(AllocatedBuffer&& storage) {
  CHECK_NULL(storage_.data());
  storage_ = std::move(storage);
}
// 同ShutdownWrap::OnDone
inline void WriteWrap::OnDone(int status) {
  stream()->EmitAfterWrite(this, status);
  Dispose();
}
// 请求Libuv结束后的回调，调用子类的OnDone
inline void StreamReq::Done(int status, const char* error_str) {
  AsyncWrap* async_wrap = GetAsyncWrap();
  Environment* env = async_wrap->env();
  if (error_str != nullptr) {
    async_wrap->object()->Set(env->context(),
                              env->error_string(),
                              OneByteString(env->isolate(), error_str))
                              .Check();
  }
  // 执行子类的OnDone
  OnDone(status);
}

inline void StreamReq::ResetObject(v8::Local<v8::Object> obj) {
  DCHECK_GT(obj->InternalFieldCount(), StreamReq::kStreamReqField);

  obj->SetAlignedPointerInInternalField(0, nullptr);  // BaseObject field.
  obj->SetAlignedPointerInInternalField(StreamReq::kStreamReqField, nullptr);
}


}  // namespace node

#endif  // defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS

#endif  // SRC_STREAM_BASE_INL_H_
