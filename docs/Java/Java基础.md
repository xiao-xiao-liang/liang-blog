---
layout: post
title:  "Java基础"
categories: [Java]
tags: [Java]
---

# Java有哪些结合类？


# Java集合

* 1.Java中有哪些集合类？
* 2.数组和链表在Java中的区别？
* 3.List接口有哪些实现类？
* 4.HashMap和HasnTable区别？
* 20.ConcurrentModificationException错误？如何产生的？


```Java
public void set(T value) {
    //获取当前请求的线程
    Thread t = Thread.currentThread();
    //取出 Thread 类内部的 threadLocals 变量(哈希表结构)
    ThreadLocalMap map = getMap(t);
    if (map != null)
        // 将需要存储的值放入到这个哈希表中
        map.set(this, value);
    else
        createMap(t, value);
}
ThreadLocalMap getMap(Thread t) {
    return t.threadLocals;
}
```

通过上面这些内容，我们足以通过猜测得出结论：**最终的变量是放在了当前线程的 ****`ThreadLocalMap`**** 中，并不是存在 ****`ThreadLocal`**** 上，****`ThreadLocal`**** 可以理解为只是****`ThreadLocalMap`****的封装，传递了变量值。**`ThrealLocal` 类中可以通过`Thread.currentThread()`获取到当前线程对象后，直接通过`getMap(Thread t)`可以访问到该线程的`ThreadLocalMap`对象。

每个`Thread`中都具备一个`ThreadLocalMap`，而`ThreadLocalMap`可以存储以`ThreadLocal`为 key ，Object 对象为 value 的键值对。