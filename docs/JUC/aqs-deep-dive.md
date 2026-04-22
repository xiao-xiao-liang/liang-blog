---
title: AQS 深度解析
sidebar_position: 5
description: 基于 JDK 17 源码深入解析 AQS 的设计思想与内部实现，涵盖 state、CLH 队列、模板方法模式和 ConditionObject
---

# AQS（AbstractQueuedSynchronizer）— Java 并发的基石

> 本文深入解析 AQS 的设计思想与内部实现，基于 **JDK 17** 源码。AQS 是 `ReentrantLock`、`Semaphore`、`CountDownLatch`、`ReentrantReadWriteLock` 等并发工具的底层框架，理解 AQS 等于拿到了打开 JUC 源码大门的钥匙。
>
> **前置知识**：了解 `synchronized`、`volatile`、CAS 的基本概念；会使用 `ReentrantLock`。

---

## 目录

1. [开篇：为什么需要 AQS？](#1-开篇为什么需要-aqs)
2. [AQS 核心设计：三大支柱](#2-aqs-核心设计三大支柱)
3. [独占模式完整流程](#3-独占模式完整流程)
4. [共享模式简述](#4-共享模式简述)
5. [LockSupport — 线程的遥控器](#5-locksupport--线程的遥控器)
6. [ConditionObject — 双队列模型](#6-conditionobject--双队列模型)
7. [总结](#7-总结)

---

## 1. 开篇：为什么需要 AQS？

假设没有 AQS，你要从零实现一个互斥锁，需要解决以下问题：

| 问题 | 你需要做的 |
|------|-----------|
| 如何表示"锁的状态"？ | 维护一个状态变量，用 CAS 修改 |
| 拿不到锁的线程怎么办？ | 构建一个等待队列，让线程排队 |
| 锁释放后怎么通知排队线程？ | 从队列中取出线程，唤醒它 |
| 如何支持公平/非公平？ | 控制新线程是否可以插队 |
| 如何支持可重入？ | 记录持有锁的线程，允许同一线程多次获取 |
| 如何支持条件等待（类似 wait/notify）？ | 再维护一个条件等待队列... |

每实现一个同步器（锁、信号量、倒计时器...），这些逻辑都要重写一遍。**代码大量重复，且极易出错。**

Doug Lea 的解决方案：**将公共逻辑抽取到一个抽象框架（AQS）中**，子类只需定义"获取和释放的语义"。

```
┌─────────────────────────────────────────────────────┐
│                      AQS 框架                        │
│                                                     │
│  ┌───────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  state    │  │  CLH 等待    │  │  线程阻塞/   │  │
│  │  状态管理  │  │  队列管理    │  │  唤醒机制    │  │
│  └───────────┘  └──────────────┘  └──────────────┘  │
│                                                     │
│  模板方法：acquire() / release() / acquireShared()    │
│                                                     │
│  ─────────── 子类只需实现 ↓ ───────────              │
│                                                     │
│  钩子方法：tryAcquire() / tryRelease()               │
└─────────────────────────────────────────────────────┘
        │               │                │
  ┌─────┴───┐    ┌──────┴─────┐   ┌──────┴──────┐
  │Reentrant│    │ Semaphore  │   │CountDown    │
  │  Lock   │    │            │   │  Latch      │
  └─────────┘    └────────────┘   └─────────────┘
```

AQS 的设计思想可以用一句话概括：**框架定义流程，子类定义语义**。

## 2. AQS 核心设计：三大支柱

AQS 的内部机制建立在三大核心组件之上：**state 同步状态**、**CLH 等待队列**、**模板方法模式**。

### 2.1 支柱一：state — 一个 int 承载所有语义

```java
// AQS 中的核心字段
private volatile int state;
```

一个简单的 `volatile int`，却在不同的同步器中承载着完全不同的含义：

| 同步器 | state 含义 |
|--------|-----------|
| ReentrantLock | 0 = 空闲，≥1 = 被持有（值 = 重入次数） |
| Semaphore | 剩余许可证数量 |
| CountDownLatch | 剩余计数值 |
| ReentrantReadWriteLock | 高 16 位 = 读锁持有数，低 16 位 = 写锁重入数 |

AQS 提供了三个方法来操作 state：

```java
protected final int getState()        // 获取 state
protected final void setState(int)    // 设置 state（volatile 写）
protected final boolean compareAndSetState(int expect, int update)  // CAS 修改
```

> 💡 **关键洞察**：AQS 不关心 state 代表什么，它只提供"安全地读写 state"的能力。state 的语义完全由子类定义。

### 2.2 支柱二：CLH 等待队列 — 线程排队的数据结构

当线程获取资源失败（`tryAcquire` 返回 false）时，AQS 会将该线程封装为一个 **Node 节点**，加入一个 **CLH 变体队列**（双向链表）中排队等待。

#### Node 节点结构

```java
static final class Node {
    // ---- 等待状态 ----
    volatile int waitStatus;

    // ---- 双向链表指针 ----
    volatile Node prev;       // 前驱节点
    volatile Node next;       // 后继节点

    // ---- 排队的线程 ----
    volatile Thread thread;

    // ---- Condition 队列 / 模式标记 ----
    Node nextWaiter;          // SHARED 或 EXCLUSIVE 标记，或 Condition 队列的后继
}
```

#### waitStatus 状态详解

| 值 | 常量名 | 含义 |
|----|--------|------|
| 0 | (初始) | 新建节点的默认状态 |
| -1 | SIGNAL | **"我的后继需要被唤醒"**。当前节点释放锁或被取消时，必须 unpark 后继 |
| 1 | CANCELLED | 节点已取消（因超时或中断），会被清理出队列 |
| -2 | CONDITION | 节点当前在 Condition 等待队列中（不在同步队列） |
| -3 | PROPAGATE | 共享模式专用，释放操作需要向后传播唤醒 |

> 💡 **waitStatus 的核心设计**：一个节点的 waitStatus 描述的是**"它对后继节点的责任"**，而不是自身状态。当 `ws = SIGNAL(-1)` 时，意味着"当我释放时，我负责唤醒后面那个人"。

#### 队列结构

```
                  CLH 等待队列（双向链表）
                  
  ┌──────────┐    ┌──────────┐    ┌──────────┐
  │   head   │←──→│  Node A  │←──→│  Node B  │ ← tail
  │ (哨兵)   │    │          │    │          │
  │ ws = 0   │    │ ws = -1  │    │ ws = 0   │
  │ thread = │    │ thread = │    │ thread = │
  │   null   │    │ threadA  │    │ threadB  │
  └──────────┘    └──────────┘    └──────────┘
  
  说明：
  • head 是哨兵节点（dummy），不代表任何线程
  • head 的后继（Node A）是下一个有资格获取锁的线程
  • 新节点通过 CAS 加入 tail 尾部
```

**几个关键设计细节：**

1. **为什么用双向链表？** 取消节点时需要修改前驱的 next 指针，必须能回溯
2. **为什么有哨兵 head？** 简化边界处理，head 永远指向"当前持有锁的线程"（或初始的 dummy 节点）
3. **为什么 waitStatus 初始是 0 而不是 SIGNAL？** 为了延迟设置——只有当后继节点确认需要阻塞时，才将前驱设为 SIGNAL

### 2.3 支柱三：模板方法模式 — 框架定义流程，子类定义语义

AQS 的精妙之处在于**模板方法模式**的运用。它将获取/释放资源的完整流程固化在框架中，子类只需通过重写钩子方法来定义"什么条件下算获取成功"。

#### 模板方法（AQS 实现，`final` 不可重写）

| 方法 | 模式 | 说明 |
|------|------|------|
| `acquire(int arg)` | 独占 | 获取资源，失败则排队阻塞 |
| `release(int arg)` | 独占 | 释放资源，唤醒后继 |
| `acquireShared(int arg)` | 共享 | 获取共享资源 |
| `releaseShared(int arg)` | 共享 | 释放共享资源 |
| `acquireInterruptibly(int arg)` | 独占 | 可响应中断的获取 |
| `tryAcquireNanos(int arg, long nanos)` | 独占 | 带超时的获取 |

#### 钩子方法（子类必须重写）

| 方法 | 说明 | 谁来实现 |
|------|------|---------|
| `tryAcquire(int arg)` | 尝试独占获取 | ReentrantLock |
| `tryRelease(int arg)` | 尝试独占释放 | ReentrantLock |
| `tryAcquireShared(int arg)` | 尝试共享获取 | Semaphore、CountDownLatch |
| `tryReleaseShared(int arg)` | 尝试共享释放 | Semaphore、CountDownLatch |
| `isHeldExclusively()` | 当前线程是否独占 | ReentrantLock（Condition 需要） |

> 以 `ReentrantLock` 为例，它只需实现 `tryAcquire` 和 `tryRelease`，整个排队、阻塞、唤醒的逻辑全部由 AQS 框架处理。

```java
// 伪代码：AQS 的 acquire 流程
public final void acquire(int arg) {
    if (!tryAcquire(arg))           // 子类定义：什么条件算获取成功
        排队入队();                  // AQS 框架处理
        阻塞等待();                  // AQS 框架处理
}

// 伪代码：AQS 的 release 流程
public final boolean release(int arg) {
    if (tryRelease(arg))            // 子类定义：什么条件算释放成功
        唤醒后继节点();              // AQS 框架处理
}
```

## 3. 独占模式完整流程

独占模式是最常用的模式，`ReentrantLock` 就是基于独占模式实现的。下面我们以 `acquire()` 和 `release()` 为主线，逐层拆解源码。

### 3.1 acquire() — 入口方法

```java
// AQS 源码（JDK 17）
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&                          // ① 尝试获取
        acquireQueued(addWaiter(Node.EXCLUSIVE), arg)) // ② 入队 + 排队等待
        selfInterrupt();                              // ③ 补上中断标记
}
```

这三行代码浓缩了整个加锁流程：

1. **`tryAcquire(arg)`**：由子类实现，尝试直接获取资源。成功直接返回，不涉及队列
2. **`addWaiter(Node.EXCLUSIVE)`**：获取失败，将当前线程封装为独占模式的 Node，加入队尾
3. **`acquireQueued(node, arg)`**：在队列中排队，前驱是 head 时再尝试获取，否则阻塞
4. **`selfInterrupt()`**：如果排队期间被中断过，在获取到资源后补上中断标记

下面逐个拆解。

### 3.2 addWaiter() — 入队

```java
// AQS 源码
private Node addWaiter(Node mode) {
    Node node = new Node(Thread.currentThread(), mode); // 封装为 Node

    // 快速路径：尝试直接 CAS 设为 tail
    Node pred = tail;
    if (pred != null) {
        node.prev = pred;
        if (compareAndSetTail(pred, node)) {  // CAS 将 tail 指向新节点
            pred.next = node;                 // 连接 next 指针
            return node;
        }
    }

    // 快速路径失败（队列为空，或 CAS 竞争失败），走完整入队流程
    enq(node);
    return node;
}

private Node enq(final Node node) {
    for (;;) {  // 自旋直到入队成功
        Node t = tail;
        if (t == null) {
            // 队列为空，初始化一个哨兵 head
            if (compareAndSetHead(new Node()))
                tail = head;
        } else {
            node.prev = t;
            if (compareAndSetTail(t, node)) {
                t.next = node;
                return t;
            }
        }
    }
}
```

**入队流程图：**

```
初始状态（队列为空）：
  head = null, tail = null

第一个线程入队：
  ① 创建哨兵 head
  ② 将 Node 加到哨兵后面
  
  head(哨兵) ←→ Node(线程A) = tail

第二个线程入队：
  ③ CAS 将新 Node 设为 tail
  
  head(哨兵) ←→ Node(线程A) ←→ Node(线程B) = tail
```

> ⚠️ **注意**：`pred.next = node` 在 CAS 之后执行，意味着 **next 指针的设置不是原子的**。这就是为什么后面 `unparkSuccessor` 要从 tail 往前遍历的原因。

### 3.3 acquireQueued() — 排队等待（核心！）

这是独占模式最核心的方法——线程在队列中自旋 + 阻塞，直到获取到资源。

```java
// AQS 源码（简化版，移除了 cancelled 处理的细节）
final boolean acquireQueued(final Node node, int arg) {
    boolean interrupted = false;
    try {
        for (;;) {  // 死循环
            final Node p = node.predecessor();  // 获取前驱

            // 关键判断：只有前驱是 head 时，才有资格尝试获取
            if (p == head && tryAcquire(arg)) {
                setHead(node);     // 获取成功！自己成为新的 head
                p.next = null;     // 帮助 GC 回收旧 head
                return interrupted;
            }

            // 获取失败，判断是否应该阻塞
            if (shouldParkAfterFailedAcquire(p, node) &&  // 确保前驱 ws = SIGNAL
                parkAndCheckInterrupt())                   // 阻塞！
                interrupted = true;
        }
    } catch (Throwable t) {
        cancelAcquire(node);  // 异常时取消节点
        throw t;
    }
}
```

**流程图：**

```
acquireQueued(node, arg)
│
└── for (;;)  // 无限循环
      │
      ├── 前驱是 head？
      │     │
      │     ├── 是 → tryAcquire(arg)
      │     │         │
      │     │         ├── 成功 → setHead(node)，出队返回 ✅
      │     │         │
      │     │         └── 失败 ↓
      │     │
      │     └── 否 ↓
      │
      ├── shouldParkAfterFailedAcquire(pred, node)
      │     将前驱的 waitStatus 设为 SIGNAL(-1)
      │     意思是："嘿前面的，你走的时候记得叫醒我"
      │
      └── parkAndCheckInterrupt()
            LockSupport.park(this)  → 💤 阻塞在此
            ......被唤醒后回到 for 循环开头......
```

#### shouldParkAfterFailedAcquire() 详解

```java
private static boolean shouldParkAfterFailedAcquire(Node pred, Node node) {
    int ws = pred.waitStatus;

    if (ws == Node.SIGNAL)
        // 前驱已经是 SIGNAL 状态，可以安心阻塞
        return true;

    if (ws > 0) {
        // 前驱被取消了（CANCELLED），跳过所有已取消的节点
        do {
            node.prev = pred = pred.prev;
        } while (pred.waitStatus > 0);
        pred.next = node;
    } else {
        // 前驱是 0 或 PROPAGATE，将其设为 SIGNAL
        compareAndSetWaitStatus(pred, ws, Node.SIGNAL);
    }

    return false;  // 返回 false，回到 acquireQueued 的循环再试一次
}
```

> 💡 **为什么不直接 park？** 因为 waitStatus 的设置采用**延迟策略**：新节点默认 ws=0，只有后继确认要阻塞时，才把前驱设为 SIGNAL。这避免了不必要的状态更新。

### 3.4 release() — 释放与唤醒

```java
// AQS 源码
public final boolean release(int arg) {
    if (tryRelease(arg)) {          // ① 子类实现：释放资源
        Node h = head;
        if (h != null && h.waitStatus != 0)
            unparkSuccessor(h);     // ② 唤醒后继节点
        return true;
    }
    return false;
}
```

#### unparkSuccessor() — 唤醒后继

```java
private void unparkSuccessor(Node node) {
    int ws = node.waitStatus;
    if (ws < 0)
        compareAndSetWaitStatus(node, ws, 0);  // 清除 SIGNAL 状态

    // 从 node（head）找到下一个需要唤醒的节点
    Node s = node.next;

    if (s == null || s.waitStatus > 0) {
        s = null;
        // ⚠️ 从 tail 向前遍历，找到最靠前的非取消节点
        for (Node t = tail; t != null && t != node; t = t.prev)
            if (t.waitStatus <= 0)
                s = t;
    }

    if (s != null)
        LockSupport.unpark(s.thread);  // 唤醒！
}
```

> ⚠️ **为什么要从 tail 往前找？**
> 
> 因为在 `addWaiter` 中，`node.prev = pred` 和 `compareAndSetTail` 是先执行的，而 `pred.next = node` 是后执行的。也就是说，prev 指针总是可靠的，但 next 指针可能还没来得及设置。从 tail 往前遍历能保证不遗漏节点。

### 3.5 完整流程串联

```
线程 A 获取锁成功:
  state: 0 → 1
  exclusiveOwnerThread: null → threadA

线程 B 尝试获取锁:
  ① tryAcquire(1) → state=1, 不是自己持有 → 失败
  ② addWaiter() → [head(哨兵)] ←→ [B] = tail
  ③ acquireQueued() → B 的前驱是 head，tryAcquire 失败 → park 阻塞 💤

线程 C 尝试获取锁:
  ① tryAcquire(1) → 失败
  ② addWaiter() → [head] ←→ [B, ws=-1] ←→ [C] = tail
  ③ acquireQueued() → C 的前驱不是 head → park 阻塞 💤

线程 A 释放锁:
  ① tryRelease(1) → state: 1 → 0 → 返回 true
  ② unparkSuccessor(head) → unpark(B)
  ③ B 被唤醒 → acquireQueued 循环 → 前驱是 head → tryAcquire 成功！
  ④ B 成为新的 head → [head/B] ←→ [C] = tail

线程 B 释放锁:
  ① tryRelease(1) → state → 0
  ② unparkSuccessor(head/B) → unpark(C)
  ③ C 获取锁...
```

## 4. 共享模式简述

共享模式允许**多个线程同时获取资源**，`Semaphore`、`CountDownLatch`、`ReentrantReadWriteLock` 的读锁都基于此模式。

### 4.1 与独占模式的核心区别

| 维度 | 独占模式 | 共享模式 |
|------|---------|---------|
| 同时持有 | 只允许一个线程 | 允许多个线程 |
| tryAcquire 返回值 | `boolean`（成功/失败） | `int`（&lt;0 失败，≥0 成功，值=剩余资源数） |
| 获取成功后 | 仅当前线程受益 | **传播唤醒**后续共享节点 |
| 典型实现 | ReentrantLock | Semaphore、CountDownLatch |

### 4.2 acquireShared() 源码

```java
public final void acquireShared(int arg) {
    if (tryAcquireShared(arg) < 0)    // 子类实现：返回值 < 0 表示获取失败
        doAcquireShared(arg);          // 入队排队，类似 acquireQueued
}
```

共享模式最大的特点在于 `doAcquireShared` 中的 **`setHeadAndPropagate()`**：

```java
private void setHeadAndPropagate(Node node, int propagate) {
    Node h = head;
    setHead(node);  // 当前节点成为 head

    // 关键：如果还有剩余资源（propagate > 0），继续唤醒后面的共享节点
    if (propagate > 0 || h == null || h.waitStatus < 0) {
        Node s = node.next;
        if (s == null || s.isShared())
            doReleaseShared();  // 唤醒后继共享节点
    }
}
```

> 💡 **传播唤醒**是共享模式的精髓：一个线程获取到资源后，发现还有剩余，就会接力唤醒后面的共享节点，形成链式唤醒。
>
> 例如 `Semaphore(3)`：三个线程同时等待时，`release()` 一次就会触发链式唤醒，依次让三个线程都获取到许可证。

### 4.3 releaseShared()

```java
public final boolean releaseShared(int arg) {
    if (tryReleaseShared(arg)) {
        doReleaseShared();  // 唤醒后继 + 传播
        return true;
    }
    return false;
}
```

`doReleaseShared()` 中使用了 `PROPAGATE(-3)` 状态来确保唤醒信号不丢失，这是共享模式中最复杂的部分，此处不深入展开。

---

## 5. LockSupport — 线程的"遥控器"

AQS 的线程阻塞与唤醒全部依赖 `LockSupport`，它是 JUC 包中最底层的线程阻塞原语。

### 5.1 核心方法

```java
LockSupport.park();              // 阻塞当前线程
LockSupport.park(Object blocker); // 阻塞 + 关联 blocker（方便调试，jstack 可见）
LockSupport.unpark(Thread thread); // 唤醒指定线程
```

### 5.2 许可证机制

`LockSupport` 使用了一种**许可证（permit）**机制：

- 每个线程有一个许可证，初始为 0（无许可证）
- `unpark(thread)`：给线程发放一个许可证（如果已有，不累加，最多 1 个）
- `park()`：消耗一个许可证；如果没有许可证，阻塞等待

```
场景1：先 park 后 unpark（正常阻塞）
  线程A: park()   → 无许可证 → 💤 阻塞
  线程B: unpark(A) → 给 A 发许可证 → A 被唤醒 ✅

场景2：先 unpark 后 park（不会阻塞！）
  线程B: unpark(A) → A 获得许可证
  线程A: park()   → 有许可证 → 消耗掉 → 直接返回，不阻塞 ✅

场景3：多次 unpark（许可证不累加）
  线程B: unpark(A) → 许可证 = 1
  线程B: unpark(A) → 许可证还是 1（不累加！）
  线程A: park()   → 消耗许可证 → 不阻塞
  线程A: park()   → 无许可证 → 💤 阻塞
```

### 5.3 与 wait/notify 的本质区别

| 维度 | Object.wait/notify | LockSupport.park/unpark |
|------|-------------------|------------------------|
| 前提条件 | 必须在 `synchronized` 块中 | **不需要任何锁** |
| 调用顺序 | `notify` 必须在 `wait` 之后，否则信号丢失 | `unpark` 可以先于 `park`（许可证机制） |
| 精确唤醒 | `notify()` 随机唤醒一个线程 | `unpark(thread)` **精确指定线程** |
| 中断响应 | 抛出 InterruptedException | 直接返回，需手动检查中断标志 |
| 调试友好 | `jstack` 显示 `in Object.wait()` | `jstack` 显示 `parking + blocker 对象` |

> 💡 **为什么 AQS 选择 LockSupport？**
> 1. 不需要依赖 `synchronized`（AQS 本身就是要替代 `synchronized` 的）
> 2. `unpark` 可以先于 `park`，避免信号丢失的竞态条件
> 3. 可以精确唤醒指定线程，而不是随机唤醒

## 6. ConditionObject — 双队列模型

`ConditionObject` 是 AQS 的内部类，实现了 `Condition` 接口。它为 AQS 提供了类似 `Object.wait/notify` 的条件等待能力，但**每个 Condition 对象都维护一个独立的等待队列**。

### 6.1 双队列架构

AQS 内部同时存在**两种队列**，理解它们的关系是掌握 Condition 的关键：

```
┌─────────────────────────────────────────────────────────────────┐
│                          AQS 内部                               │
│                                                                 │
│  同步队列（CLH，竞争锁的线程）:                                    │
│  head(哨兵) ←→ [NodeA] ←→ [NodeB] ←→ tail                      │
│                                                                 │
│  条件队列1（Condition, 调用 await 的线程）:                        │
│  firstWaiter → [NodeC, ws=-2] → [NodeD, ws=-2] → lastWaiter    │
│                                                                 │
│  条件队列2（另一个 Condition）:                                    │
│  firstWaiter → [NodeE, ws=-2] → lastWaiter                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

注意：
• 同步队列是双向链表（prev + next）
• 条件队列是单向链表（nextWaiter）
• 条件队列中的节点 waitStatus = CONDITION(-2)
• 一个节点在同一时刻只能在一个队列中
```

### 6.2 await() 流程

当线程持有锁并调用 `condition.await()` 时：

```java
// ConditionObject 源码（简化）
public final void await() throws InterruptedException {
    if (Thread.interrupted()) throw new InterruptedException();

    Node node = addConditionWaiter();    // ① 加入条件队列
    int savedState = fullyRelease(node); // ② 完全释放锁（state 置 0）

    int interruptMode = 0;
    while (!isOnSyncQueue(node)) {       // ③ 不在同步队列 → 阻塞
        LockSupport.park(this);          //    💤 阻塞在此
        if ((interruptMode = checkInterruptWhileWaiting(node)) != 0)
            break;
    }

    // ④ 被 signal 唤醒后，重新竞争锁
    if (acquireQueued(node, savedState) && interruptMode != THROW_IE)
        interruptMode = REINTERRUPT;

    // ⑤ 清理取消的条件节点
    if (node.nextWaiter != null)
        unlinkCancelledWaiters();
    if (interruptMode != 0)
        reportInterruptAfterWait(interruptMode);
}
```

**流程图：**

```
线程 T 持有锁（state=1）
│
├── ① addConditionWaiter()
│     创建 Node(ws=CONDITION)，加入条件队列尾部
│
├── ② fullyRelease(node)
│     完全释放锁：state → 0，清除 owner
│     唤醒同步队列的后继（其他线程可以获取锁了）
│
├── ③ while (!isOnSyncQueue(node))
│     └── LockSupport.park() → 💤 阻塞
│         （等待 signal 将自己转移到同步队列）
│
├── [被 signal 唤醒，此时已在同步队列中]
│
├── ④ acquireQueued(node, savedState)
│     在同步队列中排队等待，重新获取锁
│     获取成功后恢复 state = savedState
│
└── 继续执行 await() 之后的代码
```

> 💡 **关键洞察**：`await()` 会**完全释放锁**（不是减 1，而是清零！），并在被唤醒后重新获取锁。这意味着即使锁被重入了 N 次，`await` 也会全部释放，唤醒后再恢复到原来的重入次数。

### 6.3 signal() 流程

当另一个线程持有锁并调用 `condition.signal()` 时：

```java
// ConditionObject 源码（简化）
public final void signal() {
    if (!isHeldExclusively())           // 必须持有锁才能 signal
        throw new IllegalMonitorStateException();

    Node first = firstWaiter;
    if (first != null)
        doSignal(first);                // 转移第一个节点
}

private void doSignal(Node first) {
    do {
        // 将 firstWaiter 移出条件队列
        if ((firstWaiter = first.nextWaiter) == null)
            lastWaiter = null;
        first.nextWaiter = null;
    } while (!transferForSignal(first) &&   // 转移到同步队列
             (first = firstWaiter) != null);
}

final boolean transferForSignal(Node node) {
    // 将 waitStatus 从 CONDITION(-2) 改为 0
    if (!compareAndSetWaitStatus(node, Node.CONDITION, 0))
        return false;  // 节点已取消

    // enq() 加入同步队列尾部，返回前驱节点
    Node p = enq(node);
    int ws = p.waitStatus;

    // 设置前驱的 ws = SIGNAL，或直接唤醒
    if (ws > 0 || !compareAndSetWaitStatus(p, ws, Node.SIGNAL))
        LockSupport.unpark(node.thread);

    return true;
}
```

**流程图：**

```
signal() 执行前：
  同步队列: head ←→ [A(持有锁)] ←→ tail
  条件队列: [C] → [D]

signal() 执行后：
  同步队列: head ←→ [A(持有锁)] ←→ [C] ←→ tail   ← C 被转移到这里
  条件队列: [D]

C 被转移到同步队列后：
  ① C 从条件队列移除（waitStatus: -2 → 0）
  ② C 通过 enq() 加入同步队列尾部
  ③ C 等待前驱释放锁后被唤醒
```

### 6.4 与 Object.wait/notify 的对比

| 维度 | Object.wait/notify | Condition.await/signal |
|------|-------------------|----------------------|
| 配合的锁 | `synchronized` | `ReentrantLock` |
| 等待队列数 | 每个对象只有 **1 个** | 可以创建 **多个** Condition |
| 精确唤醒 | `notify()` 随机唤醒一个 | `signal()` 唤醒对应 Condition 的第一个 |
| 唤醒全部 | `notifyAll()` | `signalAll()` |
| 前提条件 | 必须在 synchronized 块中 | 必须持有 ReentrantLock |

> 💡 **多个 Condition 的价值**：生产者-消费者模式中，可以用 `notFull` 和 `notEmpty` 两个 Condition，生产者只唤醒消费者，消费者只唤醒生产者，避免 `notifyAll()` 的惊群效应。

---

## 7. 总结

### AQS 全景图

```
┌──────────────────────────────────────────────────────────┐
│                   AQS 架构全景                            │
│                                                          │
│  ┌────────────────┐                                      │
│  │  state (int)   │  ← volatile + CAS                   │
│  │  同步状态变量   │  ← 语义由子类定义                     │
│  └────────────────┘                                      │
│                                                          │
│  ┌────────────────────────────────────────────┐           │
│  │  CLH 同步队列（双向链表）                    │           │
│  │  head ←→ Node ←→ Node ←→ ... ←→ tail      │           │
│  │  获取资源失败的线程在此排队                   │           │
│  └────────────────────────────────────────────┘           │
│                                                          │
│  ┌──────────────────────────┐                             │
│  │  Condition 条件队列（单向） │  ← 可创建多个             │
│  │  firstWaiter → Node → ...│                             │
│  │  await 的线程在此等待信号  │                             │
│  └──────────────────────────┘                             │
│                                                          │
│  阻塞/唤醒: LockSupport.park() / unpark()                │
│                                                          │
│  模板方法                      钩子方法（子类实现）         │
│  ├── acquire()                ├── tryAcquire()            │
│  ├── release()                ├── tryRelease()            │
│  ├── acquireShared()          ├── tryAcquireShared()      │
│  └── releaseShared()          └── tryReleaseShared()      │
└──────────────────────────────────────────────────────────┘
```

### 核心三板斧

| 组件 | 职责 | 关键实现 |
|------|------|---------|
| **state** | 表示同步状态 | `volatile int` + CAS |
| **CLH 队列** | 管理等待线程 | 双向链表 + `LockSupport.park/unpark` |
| **模板方法** | 固化流程框架 | `acquire/release` 调用子类 `tryAcquire/tryRelease` |

### 推荐的源码阅读顺序

```
1. AbstractQueuedSynchronizer.acquire()     ← 入口
2. AbstractQueuedSynchronizer.addWaiter()   ← 入队
3. AbstractQueuedSynchronizer.acquireQueued() ← 排队核心
4. AbstractQueuedSynchronizer.release()     ← 释放
5. AbstractQueuedSynchronizer.ConditionObject.await()   ← 条件等待
6. AbstractQueuedSynchronizer.ConditionObject.signal()  ← 条件唤醒
```

### 下一篇预告

有了 AQS 的基础，下一篇我们将深入 **ReentrantLock** 的源码，看它如何用不到 100 行代码实现一把功能完整的锁：

- 非公平锁 vs 公平锁的 `tryAcquire` 究竟差在哪一行？
- 可重入的 state 递增/递减机制
- Condition 在生产者-消费者中的完整流转
- 公平/非公平性能实测 benchmark

---

> 📝 **作者注**：本文基于 JDK 17 源码。JDK 不同版本的 AQS 实现可能有差异（如 JDK 9 引入了 VarHandle 替代 Unsafe 的部分 CAS 操作），但核心设计思想保持一致。
