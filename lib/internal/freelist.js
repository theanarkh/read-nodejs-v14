'use strict';

const {
  ReflectApply,
} = primordials;

class FreeList {
  constructor(name, max, ctor) {
    this.name = name;
    // 构造函数
    this.ctor = ctor;
    // 节点的最大值
    this.max = max;
    // 实例列表
    this.list = [];
  }
  // 分配一个实例
  alloc() {
    // 有空闲的则直接返回，否则新建一个
    return this.list.length > 0 ?
      this.list.pop() :
      ReflectApply(this.ctor, this, arguments);
  }
  // 释放实例
  free(obj) {
    // 小于阈值则放到空闲列表，否则释放（调用方负责释放）
    if (this.list.length < this.max) {
      this.list.push(obj);
      return true;
    }
    return false;
  }
}

module.exports = FreeList;
