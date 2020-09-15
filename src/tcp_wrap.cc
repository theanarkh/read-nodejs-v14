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

#include "tcp_wrap.h"

#include "connection_wrap.h"
#include "env-inl.h"
#include "handle_wrap.h"
#include "node_buffer.h"
#include "node_internals.h"
#include "connect_wrap.h"
#include "stream_base-inl.h"
#include "stream_wrap.h"
#include "util-inl.h"

#include <cstdlib>


namespace node {

using v8::Boolean;
using v8::Context;
using v8::EscapableHandleScope;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::HandleScope;
using v8::Int32;
using v8::Integer;
using v8::Local;
using v8::MaybeLocal;
using v8::Object;
using v8::String;
using v8::Uint32;
using v8::Value;

MaybeLocal<Object> TCPWrap::Instantiate(Environment* env,
                                        AsyncWrap* parent,
                                        TCPWrap::SocketType type) {
  EscapableHandleScope handle_scope(env->isolate());
  AsyncHooks::DefaultTriggerAsyncIdScope trigger_scope(parent);
  CHECK_EQ(env->tcp_constructor_template().IsEmpty(), false);
  Local<Function> constructor = env->tcp_constructor_template()
                                    ->GetFunction(env->context())
                                    .ToLocalChecked();
  CHECK_EQ(constructor.IsEmpty(), false);
  Local<Value> type_value = Int32::New(env->isolate(), type);
  return handle_scope.EscapeMaybe(
      constructor->NewInstance(env->context(), 1, &type_value));
}


void TCPWrap::Initialize(Local<Object> target,
                         Local<Value> unused,
                         Local<Context> context,
                         void* priv) {
  Environment* env = Environment::GetCurrent(context);
  // 以New为模板新建一个函数
  Local<FunctionTemplate> t = env->NewFunctionTemplate(New);
  Local<String> tcpString = FIXED_ONE_BYTE_STRING(env->isolate(), "TCP");
  // 函数名
  t->SetClassName(tcpString);
  t->InstanceTemplate()
    ->SetInternalFieldCount(StreamBase::kStreamBaseFieldCount);

  // Init properties
  // 设置实例的属性，实例是执行new TCP时返回的对象
  t->InstanceTemplate()->Set(FIXED_ONE_BYTE_STRING(env->isolate(), "reading"),
                             Boolean::New(env->isolate(), false));
  t->InstanceTemplate()->Set(env->owner_symbol(), Null(env->isolate()));
  t->InstanceTemplate()->Set(env->onconnection_string(), Null(env->isolate()));

  t->Inherit(LibuvStreamWrap::GetConstructorTemplate(env));
  // 设置t的原型方法，即TCP.prototype的属性
  env->SetProtoMethod(t, "open", Open);
  env->SetProtoMethod(t, "bind", Bind);
  env->SetProtoMethod(t, "listen", Listen);
  env->SetProtoMethod(t, "connect", Connect);
  env->SetProtoMethod(t, "bind6", Bind6);
  env->SetProtoMethod(t, "connect6", Connect6);
  env->SetProtoMethod(t, "getsockname",
                      GetSockOrPeerName<TCPWrap, uv_tcp_getsockname>);
  env->SetProtoMethod(t, "getpeername",
                      GetSockOrPeerName<TCPWrap, uv_tcp_getpeername>);
  env->SetProtoMethod(t, "setNoDelay", SetNoDelay);
  env->SetProtoMethod(t, "setKeepAlive", SetKeepAlive);

#ifdef _WIN32
  env->SetProtoMethod(t, "setSimultaneousAccepts", SetSimultaneousAccepts);
#endif
  // target为导出的对象，设置对象的TCP属性
  target->Set(env->context(),
              tcpString,
              t->GetFunction(env->context()).ToLocalChecked()).Check();
  env->set_tcp_constructor_template(t);

  // Create FunctionTemplate for TCPConnectWrap.
  Local<FunctionTemplate> cwt =
      BaseObject::MakeLazilyInitializedJSTemplate(env);
  cwt->Inherit(AsyncWrap::GetConstructorTemplate(env));
  Local<String> wrapString =
      FIXED_ONE_BYTE_STRING(env->isolate(), "TCPConnectWrap");
  cwt->SetClassName(wrapString);
  // 设置对象的TCPConnectWrap属性 
  target->Set(env->context(),
              wrapString,
              cwt->GetFunction(env->context()).ToLocalChecked()).Check();

  // Define constants
  // 设置对象的constant属性 
  Local<Object> constants = Object::New(env->isolate());
  NODE_DEFINE_CONSTANT(constants, SOCKET);
  NODE_DEFINE_CONSTANT(constants, SERVER);
  NODE_DEFINE_CONSTANT(constants, UV_TCP_IPV6ONLY);
  target->Set(context,
              env->constants_string(),
              constants).Check();
}


void TCPWrap::New(const FunctionCallbackInfo<Value>& args) {
  // This constructor should not be exposed to public javascript.
  // Therefore we assert that we are not trying to call this as a
  // normal function.
  // 要以new TCP的形式调用
  CHECK(args.IsConstructCall());
  // 第一个入参是数字
  CHECK(args[0]->IsInt32());
  Environment* env = Environment::GetCurrent(args);

  int type_value = args[0].As<Int32>()->Value();
  TCPWrap::SocketType type = static_cast<TCPWrap::SocketType>(type_value);

  ProviderType provider;
  switch (type) {
    case SOCKET:
      provider = PROVIDER_TCPWRAP;
      break;
    case SERVER:
      provider = PROVIDER_TCPSERVERWRAP;
      break;
    default:
      UNREACHABLE();
  }

  new TCPWrap(env, args.This(), provider);
}


TCPWrap::TCPWrap(Environment* env, Local<Object> object, ProviderType provider)
    : ConnectionWrap(env, object, provider) {
  // 初始化一个tcp handle
  int r = uv_tcp_init(env->event_loop(), &handle_);
  CHECK_EQ(r, 0);  // How do we proxy this error up to javascript?
                   // Suggestion: uv_tcp_init() returns void.
}


void TCPWrap::SetNoDelay(const FunctionCallbackInfo<Value>& args) {
  TCPWrap* wrap;
  // wrap等于Holder返回的值，如果返回未nul，则取第三个参数的值
  ASSIGN_OR_RETURN_UNWRAP(&wrap,
                          args.Holder(),
                          args.GetReturnValue().Set(UV_EBADF));
  int enable = static_cast<int>(args[0]->IsTrue());
  // wrap即TCPWwrap的实例对象，设置是否开启nagle算法
  int err = uv_tcp_nodelay(&wrap->handle_, enable);
  args.GetReturnValue().Set(err);
}

// 设置长连接是否开启，时间。
void TCPWrap::SetKeepAlive(const FunctionCallbackInfo<Value>& args) {
  TCPWrap* wrap;
  ASSIGN_OR_RETURN_UNWRAP(&wrap,
                          args.Holder(),
                          args.GetReturnValue().Set(UV_EBADF));
  Environment* env = wrap->env();
  int enable;
  if (!args[0]->Int32Value(env->context()).To(&enable)) return;
  unsigned int delay = args[1].As<Uint32>()->Value();
  int err = uv_tcp_keepalive(&wrap->handle_, enable, delay);
  args.GetReturnValue().Set(err);
}


#ifdef _WIN32
void TCPWrap::SetSimultaneousAccepts(const FunctionCallbackInfo<Value>& args) {
  TCPWrap* wrap;
  ASSIGN_OR_RETURN_UNWRAP(&wrap,
                          args.Holder(),
                          args.GetReturnValue().Set(UV_EBADF));
  bool enable = args[0]->IsTrue();
  int err = uv_tcp_simultaneous_accepts(&wrap->handle_, enable);
  args.GetReturnValue().Set(err);
}
#endif


void TCPWrap::Open(const FunctionCallbackInfo<Value>& args) {
  TCPWrap* wrap;
  ASSIGN_OR_RETURN_UNWRAP(&wrap,
                          args.Holder(),
                          args.GetReturnValue().Set(UV_EBADF));
  int64_t val;
  if (!args[0]->IntegerValue(args.GetIsolate()->GetCurrentContext()).To(&val))
    return;
  // open的第一个参数是一个文件描述符
  int fd = static_cast<int>(val);
  // 把fd记录在handle里（handle的io观察者里）
  int err = uv_tcp_open(&wrap->handle_, fd);

  if (err == 0)
    wrap->set_fd(fd);

  args.GetReturnValue().Set(err);
}

template <typename T>
void TCPWrap::Bind(
    const FunctionCallbackInfo<Value>& args,
    int family,
    std::function<int(const char* ip_address, int port, T* addr)> uv_ip_addr) {
  TCPWrap* wrap;
  ASSIGN_OR_RETURN_UNWRAP(&wrap,
                          args.Holder(),
                          args.GetReturnValue().Set(UV_EBADF));
  Environment* env = wrap->env();
  node::Utf8Value ip_address(env->isolate(), args[0]);
  int port;
  unsigned int flags = 0;
  if (!args[1]->Int32Value(env->context()).To(&port)) return;
  // ipv6才有flags参数
  if (family == AF_INET6 &&
      !args[2]->Uint32Value(env->context()).To(&flags)) {
    return;
  }

  T addr;
  int err = uv_ip_addr(*ip_address, port, &addr);

  if (err == 0) {
    // 绑定地址
    err = uv_tcp_bind(&wrap->handle_,
                      reinterpret_cast<const sockaddr*>(&addr),
                      flags);
  }
  args.GetReturnValue().Set(err);
}

void TCPWrap::Bind(const FunctionCallbackInfo<Value>& args) {
  Bind<sockaddr_in>(args, AF_INET, uv_ip4_addr);
}


void TCPWrap::Bind6(const FunctionCallbackInfo<Value>& args) {
  Bind<sockaddr_in6>(args, AF_INET6, uv_ip6_addr);
}


void TCPWrap::Listen(const FunctionCallbackInfo<Value>& args) {
  TCPWrap* wrap;
  ASSIGN_OR_RETURN_UNWRAP(&wrap,
                          args.Holder(),
                          args.GetReturnValue().Set(UV_EBADF));
  Environment* env = wrap->env();
  int backlog;
  if (!args[0]->Int32Value(env->context()).To(&backlog)) return;
  // OnConnection为有新建立的连接时触发的回调（已完成三次握手） 
  int err = uv_listen(reinterpret_cast<uv_stream_t*>(&wrap->handle_),
                      backlog,
                      OnConnection);
  args.GetReturnValue().Set(err);
}


void TCPWrap::Connect(const FunctionCallbackInfo<Value>& args) {
  CHECK(args[2]->IsUint32());
  // 第三个参数是端口，第二个是ip，第一个是TCPConnectWrap对象
  int port = args[2].As<Uint32>()->Value();
  // 第二个参数是一个函数，并带有上下文port
  Connect<sockaddr_in>(args,
                       [port](const char* ip_address, sockaddr_in* addr) {
      return uv_ip4_addr(ip_address, port, addr);
  });
}


void TCPWrap::Connect6(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  CHECK(args[2]->IsUint32());
  int port;
  if (!args[2]->Int32Value(env->context()).To(&port)) return;
  Connect<sockaddr_in6>(args,
                        [port](const char* ip_address, sockaddr_in6* addr) {
      return uv_ip6_addr(ip_address, port, addr);
  });
}

template <typename T>
void TCPWrap::Connect(const FunctionCallbackInfo<Value>& args,
    std::function<int(const char* ip_address, T* addr)> uv_ip_addr) {
  Environment* env = Environment::GetCurrent(args);

  TCPWrap* wrap;
  ASSIGN_OR_RETURN_UNWRAP(&wrap,
                          args.Holder(),
                          args.GetReturnValue().Set(UV_EBADF));

  CHECK(args[0]->IsObject());
  CHECK(args[1]->IsString());
  // 第一个参数是TCPConnectWrap对象
  Local<Object> req_wrap_obj = args[0].As<Object>();
  // 第二个是ip地址
  node::Utf8Value ip_address(env->isolate(), args[1]);

  T addr;
  // 把端口，ip设置到addr上，端口信息在uv_ip_addr上下文里了
  int err = uv_ip_addr(*ip_address, &addr);

  if (err == 0) {
    AsyncHooks::DefaultTriggerAsyncIdScope trigger_scope(wrap);
    ConnectWrap* req_wrap =
        new ConnectWrap(env, req_wrap_obj, AsyncWrap::PROVIDER_TCPCONNECTWRAP);
    err = req_wrap->Dispatch(uv_tcp_connect,
                             &wrap->handle_,
                             reinterpret_cast<const sockaddr*>(&addr),
                             AfterConnect);
    if (err)
      delete req_wrap;
  }

  args.GetReturnValue().Set(err);
}


// also used by udp_wrap.cc
Local<Object> AddressToJS(Environment* env,
                          const sockaddr* addr,
                          Local<Object> info) {
  EscapableHandleScope scope(env->isolate());
  char ip[INET6_ADDRSTRLEN];
  const sockaddr_in* a4;
  const sockaddr_in6* a6;
  int port;

  if (info.IsEmpty())
    info = Object::New(env->isolate());

  switch (addr->sa_family) {
  case AF_INET6:
    a6 = reinterpret_cast<const sockaddr_in6*>(addr);
    uv_inet_ntop(AF_INET6, &a6->sin6_addr, ip, sizeof ip);
    port = ntohs(a6->sin6_port);
    info->Set(env->context(),
              env->address_string(),
              OneByteString(env->isolate(), ip)).Check();
    info->Set(env->context(),
              env->family_string(),
              env->ipv6_string()).Check();
    info->Set(env->context(),
              env->port_string(),
              Integer::New(env->isolate(), port)).Check();
    break;

  case AF_INET:
    a4 = reinterpret_cast<const sockaddr_in*>(addr);
    uv_inet_ntop(AF_INET, &a4->sin_addr, ip, sizeof ip);
    port = ntohs(a4->sin_port);
    info->Set(env->context(),
              env->address_string(),
              OneByteString(env->isolate(), ip)).Check();
    info->Set(env->context(),
              env->family_string(),
              env->ipv4_string()).Check();
    info->Set(env->context(),
              env->port_string(),
              Integer::New(env->isolate(), port)).Check();
    break;

  default:
    info->Set(env->context(),
              env->address_string(),
              String::Empty(env->isolate())).Check();
  }

  return scope.Escape(info);
}


}  // namespace node

NODE_MODULE_CONTEXT_AWARE_INTERNAL(tcp_wrap, node::TCPWrap::Initialize)
