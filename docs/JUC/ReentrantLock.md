---
title: ReentrantLock 源码全解
sidebar_position: 6
description: 基于 JDK 17 源码深入分析 ReentrantLock 的公平/非公平锁实现、可重入机制、Condition 全链路流转与性能实测
---

# ReentrantLock 源码全解 — 从 tryAcquire 到性能实测

> **前置阅读**：[《AQS — Java 并发的基石》](./aqs-deep-dive.md)。本文假设你已理解 AQS 的 state、CLH 队列、模板方法模式和 ConditionObject 双队列模型。
>
> 本文基于 **JDK 17** 源码，深入分析 ReentrantLock 如何基于 AQS 实现一把功能完整的可重入互斥锁。

---

## 目录

1. [ReentrantLock 的架构](#1-reentrantlock-的架构)
2. [非公平锁的实现（NonfairSync）](#2-非公平锁的实现nonfairsync)
3. [公平锁的实现（FairSync）](#3-公平锁的实现fairsync)
4. [可重入的实现](#4-可重入的实现)
5. [tryRelease() — 解锁源码](#5-tryrelease--解锁源码)
6. [Condition 在 ReentrantLock 中的应用](#6-condition-在-reentrantlock-中的应用)
7. [公平 vs 非公平：性能实测](#7-公平-vs-非公平性能实测)
8. [最佳实践与陷阱](#8-最佳实践与陷阱)
9. [常见面试题](#9-常见面试题)
10. [总结](#10-总结)

---

## 1. ReentrantLock 的架构

打开 `ReentrantLock` 的源码，你会发现它出奇地简洁——**锁的核心逻辑不到 100 行**，因为繁重的排队、阻塞、唤醒全部交给了 AQS。

### 类继承关系

```
ReentrantLock implements Lock
│
└── 内部类 Sync extends AbstractQueuedSynchronizer (AQS)
      │
      ├── NonfairSync extends Sync    // 非公平锁（默认）
      │     └── 重写 tryAcquire()
      │
      └── FairSync extends Sync       // 公平锁
            └── 重写 tryAcquire()
```

### 构造器

```java
public ReentrantLock() {
    sync = new NonfairSync();   // 默认非公平
}

public ReentrantLock(boolean fair) {
    sync = fair ? new FairSync() : new NonfairSync();
}
```

### ReentrantLock 对 state 的定义

在 AQS 篇中我们知道，state 的语义由子类定义。ReentrantLock 的定义是：

| state 值 | 含义 |
|----------|------|
| 0 | 锁空闲，没有线程持有 |
| 1 | 锁被一个线程持有 |
| N（N > 1） | 锁被同一个线程重入了 N 次 |

同时，AQS 还有一个字段 `exclusiveOwnerThread`（继承自 `AbstractOwnableSynchronizer`），记录当前持有锁的线程。

## 2. 非公平锁的实现（NonfairSync）

非公平锁是 ReentrantLock 的**默认模式**，也是性能更优的模式。

### lock() 入口

```java
// NonfairSync 源码（JDK 17）
static final class NonfairSync extends Sync {

    final void lock() {
        // ① 上来直接 CAS 抢锁（插队！）
        if (compareAndSetState(0, 1))
            setExclusiveOwnerThread(Thread.currentThread());
        else
            // ② 抢不到，走 AQS 标准流程
            acquire(1);
    }

    protected final boolean tryAcquire(int acquires) {
        return nonfairTryAcquire(acquires);
    }
}
```

> 💡 注意第 ① 步：新线程**不管队列里有没有人排队**，上来就 CAS 抢锁。这就是"非公平"的含义——插队！

### nonfairTryAcquire() — 核心逻辑

```java
// Sync 类中（NonfairSync 和 FairSync 的父类）
final boolean nonfairTryAcquire(int acquires) {
    final Thread current = Thread.currentThread();
    int c = getState();

    if (c == 0) {
        // 锁空闲 → 直接 CAS 抢（不检查队列！）
        if (compareAndSetState(0, acquires)) {
            setExclusiveOwnerThread(current);
            return true;  // ✅ 获取成功
        }
    }
    else if (current == getExclusiveOwnerThread()) {
        // 锁被自己持有 → 重入，state + 1
        int nextc = c + acquires;
        if (nextc < 0) // overflow
            throw new Error("Maximum lock count exceeded");
        setState(nextc);
        return true;  // ✅ 重入成功
    }

    return false;  // ❌ 获取失败，AQS 会将线程放入 CLH 队列
}
```

**完整流程：**

```
线程 X 调用 lock()
│
├── ① CAS(state: 0 → 1) —— 直接插队抢锁
│     ├── 成功 → 设置 owner = X，返回 ✅
│     └── 失败 ↓
│
├── ② acquire(1) → tryAcquire(1) → nonfairTryAcquire(1)
│     │
│     ├── state == 0？→ CAS 再抢一次（第二次机会！）
│     │     ├── 成功 → ✅
│     │     └── 失败 ↓
│     │
│     ├── owner == X？→ 重入，state++ → ✅
│     │
│     └── 都不是 → 返回 false ↓
│
├── ③ addWaiter() → 入队
│
└── ④ acquireQueued() → 排队等待 → park 阻塞 💤
```

> 💡 非公平锁给了新来的线程**两次插队机会**（lock 中一次，tryAcquire 中一次），然后才老老实实排队。

---

## 3. 公平锁的实现（FairSync）

### tryAcquire() — 与非公平锁只差一行！

```java
// FairSync 源码
static final class FairSync extends Sync {

    final void lock() {
        acquire(1);  // 没有 CAS 插队！直接走 AQS 标准流程
    }

    protected final boolean tryAcquire(int acquires) {
        final Thread current = Thread.currentThread();
        int c = getState();

        if (c == 0) {
            // ⭐ 关键差异：多了 hasQueuedPredecessors() 检查！
            if (!hasQueuedPredecessors() &&
                compareAndSetState(0, acquires)) {
                setExclusiveOwnerThread(current);
                return true;
            }
        }
        else if (current == getExclusiveOwnerThread()) {
            int nextc = c + acquires;
            if (nextc < 0)
                throw new Error("Maximum lock count exceeded");
            setState(nextc);
            return true;
        }

        return false;
    }
}
```

### 差异对比（只标注不同的行）

```diff
  // 非公平锁
  if (c == 0) {
-     if (compareAndSetState(0, acquires)) {          // 直接 CAS
+     if (!hasQueuedPredecessors() &&                  // 先检查队列
+         compareAndSetState(0, acquires)) {           // 没人排队才 CAS
          setExclusiveOwnerThread(current);
      }
  }
```

**就这一行 `hasQueuedPredecessors()`，决定了公平与否。**

### hasQueuedPredecessors() 详解

```java
// AQS 源码
public final boolean hasQueuedPredecessors() {
    Node t = tail;
    Node h = head;
    Node s;
    return h != t &&                               // 队列非空
        ((s = h.next) == null ||                   // head 的后继为空（有人正在入队）
         s.thread != Thread.currentThread());       // 或者排在最前面的不是自己
}
```

返回 `true` 表示"队列中有排在我前面的线程"，此时公平锁**不允许抢锁**，必须排到队尾。

```
场景：锁刚释放，队列中有 B 在等待

非公平锁：线程 C 新来 → CAS 直接抢 → 可能成功（B 被插队）
公平锁：  线程 C 新来 → hasQueuedPredecessors() = true → 不抢 → 排到 B 后面
```

---

## 4. 可重入的实现

可重入意味着**同一个线程可以多次获取同一把锁**，不会死锁。

### 加锁时：state 递增

```java
// nonfairTryAcquire / FairSync.tryAcquire 中的重入逻辑
else if (current == getExclusiveOwnerThread()) {
    // 判断当前线程就是锁的持有者
    int nextc = c + acquires;  // state + 1
    if (nextc < 0)
        throw new Error("Maximum lock count exceeded");
    setState(nextc);           // 不需要 CAS！因为只有持有者才能走到这里
    return true;
}
```

> 💡 **为什么 `setState` 不需要 CAS？** 因为执行到这一步时，当前线程已经是锁的持有者（`current == getExclusiveOwnerThread()`），不可能有其他线程同时修改 state。这是一个巧妙的优化。

### 解锁时：state 递减

```java
// 后面第 5 章会详细讲
protected final boolean tryRelease(int releases) {
    int c = getState() - releases;  // state - 1
    // ...
    if (c == 0) {
        // 重入全部释放，锁真正空闲
        setExclusiveOwnerThread(null);
        free = true;
    }
    setState(c);
    return free;  // 只有 state == 0 时才返回 true
}
```

### 重入的状态变化图

```
线程 A 第一次 lock():  state: 0 → 1,  owner: null → A
线程 A 第二次 lock():  state: 1 → 2,  owner: A（不变）
线程 A 第三次 lock():  state: 2 → 3,  owner: A（不变）

线程 A 第一次 unlock(): state: 3 → 2,  owner: A（不变）
线程 A 第二次 unlock(): state: 2 → 1,  owner: A（不变）
线程 A 第三次 unlock(): state: 1 → 0,  owner: A → null  ← 真正释放！
```

> ⚠️ **lock 和 unlock 必须配对！** 如果 lock 了 3 次只 unlock 了 2 次，锁不会释放，其他线程将永久阻塞。

### 重入的常见场景

```java
public class ReentrantDemo {
    private final ReentrantLock lock = new ReentrantLock();

    public void methodA() {
        lock.lock();
        try {
            // 在持有锁的情况下调用 methodB
            methodB();  // ← 这里会再次 lock()，如果不支持重入就死锁了！
        } finally {
            lock.unlock();
        }
    }

    public void methodB() {
        lock.lock();  // 重入：state 1 → 2
        try {
            // 业务逻辑
        } finally {
            lock.unlock();  // state 2 → 1
        }
    }
}
```

## 5. tryRelease() — 解锁源码

```java
// Sync 类源码
protected final boolean tryRelease(int releases) {
    int c = getState() - releases;

    // 只有持有者才能释放锁，否则抛异常
    if (Thread.currentThread() != getExclusiveOwnerThread())
        throw new IllegalMonitorStateException();

    boolean free = false;

    if (c == 0) {
        // state 减到 0 → 锁真正被释放
        free = true;
        setExclusiveOwnerThread(null);  // 清除持有者
    }

    setState(c);  // 更新 state（不需要 CAS，原因同重入时的 setState）
    return free;  // 返回 true 时，AQS 会调用 unparkSuccessor 唤醒后继
}
```

**流程串联（结合 AQS 的 release）：**

```java
// AQS 中的 release（回顾）
public final boolean release(int arg) {
    if (tryRelease(arg)) {       // ReentrantLock 的 tryRelease
        Node h = head;
        if (h != null && h.waitStatus != 0)
            unparkSuccessor(h);  // 唤醒 CLH 队列中的下一个线程
        return true;
    }
    return false;  // state 还不为 0（锁被重入了），不唤醒任何人
}
```

```
unlock() 调用链：
  unlock()
    → sync.release(1)
      → tryRelease(1): state--
        ├── state == 0 → 清除 owner，返回 true → unparkSuccessor() 唤醒后继
        └── state > 0  → 还有重入未释放，返回 false → 不唤醒
```

---

## 6. Condition 在 ReentrantLock 中的应用

`ReentrantLock` 通过 `newCondition()` 返回 AQS 内部类 `ConditionObject` 的实例。在 AQS 篇中我们已经讲过了 Condition 的双队列模型和源码流程，这里用一个完整的生产者-消费者例子，串联 await/signal 的**全链路流转**。

### 完整流转示例

```java
public class ProducerConsumerTrace {
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition notFull = lock.newCondition();
    private final Condition notEmpty = lock.newCondition();
    private final Queue<Integer> queue = new LinkedList<>();
    private static final int MAX = 3;

    public void produce(int item) throws InterruptedException {
        lock.lock();  // ① 获取锁
        try {
            while (queue.size() == MAX) {
                notFull.await();  // ② 队列满 → 进入 notFull 条件队列
            }
            queue.offer(item);
            System.out.println("生产: " + item);
            notEmpty.signal();  // ③ 通知消费者
        } finally {
            lock.unlock();  // ④ 释放锁
        }
    }

    public int consume() throws InterruptedException {
        lock.lock();
        try {
            while (queue.isEmpty()) {
                notEmpty.await();  // 队列空 → 进入 notEmpty 条件队列
            }
            int item = queue.poll();
            System.out.println("消费: " + item);
            notFull.signal();  // 通知生产者
            return item;
        } finally {
            lock.unlock();
        }
    }
}
```

### 全链路流转图

假设队列已满（size == 3），生产者 P 调用 `produce()`：

```
【阶段一：P 进入条件等待】

P 调用 lock.lock()
  → state: 0 → 1, owner: P
  → 同步队列: [head]

P 发现 queue 满了，调用 notFull.await()
  → ① addConditionWaiter(): P 加入 notFull 条件队列
  → ② fullyRelease(): state: 1 → 0, owner: null
  →    唤醒同步队列后继（如有）
  → ③ LockSupport.park(P) → 💤

此时状态：
  同步队列: [head]（空）
  notFull 条件队列: [P, ws=-2]
  notEmpty 条件队列: (空)
  锁: 空闲 (state=0)

──────────────────────────────────────────

【阶段二：C 消费并唤醒 P】

消费者 C 调用 lock.lock()
  → state: 0 → 1, owner: C

C 消费一个元素，调用 notFull.signal()
  → transferForSignal(P):
    → P 的 ws: -2 → 0
    → enq(P): P 加入同步队列尾部
    
此时状态：
  同步队列: [head] ←→ [P]
  notFull 条件队列: (空)
  锁: C 持有 (state=1)

C 调用 lock.unlock()
  → state: 1 → 0, owner: null
  → unparkSuccessor(head) → unpark(P)

──────────────────────────────────────────

【阶段三：P 被唤醒，重新获取锁】

P 从 park 中醒来
  → isOnSyncQueue(P) = true → 退出 while 循环
  → acquireQueued(P, savedState=1)
    → P 的前驱是 head → tryAcquire(1) → 成功！
    → state: 0 → 1, owner: P
    → P 成为新 head

P 继续执行 await() 之后的代码
  → queue.offer(item) → 生产成功
  → notEmpty.signal() → 唤醒消费者
  → lock.unlock()
```

> 💡 **关键理解**：Condition 的 await/signal 本质上是**在两个队列之间转移 Node**：
> - `await()`：同步队列 → 条件队列（同时释放锁）
> - `signal()`：条件队列 → 同步队列（等待重新获取锁）

## 7. 公平 vs 非公平：性能实测

### Benchmark 代码

以下是一个可直接运行的性能对比测试，你可以在自己的机器上运行：

```java
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 公平锁 vs 非公平锁性能对比
 * 运行方式：javac LockBenchmark.java && java LockBenchmark
 */
public class LockBenchmark {

    private static final int THREAD_COUNT = 20;
    private static final int OPERATIONS_PER_THREAD = 100_000;

    public static void main(String[] args) throws Exception {
        // 预热
        System.out.println("预热中...");
        runBenchmark(new ReentrantLock(false), "预热");

        System.out.println("\n===== 正式测试 =====\n");

        // 非公平锁
        long unfairTime = runBenchmark(new ReentrantLock(false), "非公平锁");

        // 公平锁
        long fairTime = runBenchmark(new ReentrantLock(true), "公平锁");

        // 对比
        System.out.println("\n===== 结果对比 =====");
        System.out.printf("非公平锁: %,d ms%n", unfairTime);
        System.out.printf("公  平锁: %,d ms%n", fairTime);
        System.out.printf("公平锁是非公平锁的 %.1f 倍%n", (double) fairTime / unfairTime);
    }

    private static long runBenchmark(ReentrantLock lock, String name) throws Exception {
        CountDownLatch startLatch = new CountDownLatch(1);
        CountDownLatch doneLatch = new CountDownLatch(THREAD_COUNT);

        // 共享计数器
        long[] counter = {0};

        for (int i = 0; i < THREAD_COUNT; i++) {
            new Thread(() -> {
                try {
                    startLatch.await(); // 等待发令
                } catch (InterruptedException e) {
                    return;
                }

                for (int j = 0; j < OPERATIONS_PER_THREAD; j++) {
                    lock.lock();
                    try {
                        counter[0]++;
                    } finally {
                        lock.unlock();
                    }
                }
                doneLatch.countDown();
            }).start();
        }

        long start = System.currentTimeMillis();
        startLatch.countDown(); // 发令！
        doneLatch.await();
        long elapsed = System.currentTimeMillis() - start;

        System.out.printf("[%s] 耗时: %,d ms, 计数: %,d%n", name, elapsed, counter[0]);
        return elapsed;
    }
}
```

### 预期结果

在多数机器上（8 核+），你会看到类似的结果：

```
===== 结果对比 =====
非公平锁: 312 ms
公  平锁: 1,847 ms
公平锁是非公平锁的 5.9 倍
```

> 实际倍数取决于核心数和竞争强度，通常在 **2-10 倍**之间。

### 为什么非公平锁更快？

```
非公平锁的优势场景：

  线程 A 持有锁 → 释放锁 → unparkSuccessor(B)
                           │
                           │ 此时 B 正在被唤醒（上下文切换中...）
                           │
  线程 C 新来 → CAS 抢锁 → 成功！→ 执行临界区 → 释放锁
                           │
                           │ B 终于醒来 → tryAcquire → 成功
                           │
  效果：C 在 B 苏醒的间隙中完成了工作，锁没有空转！
```

非公平锁通过允许"插队"，**避免了锁在线程上下文切换期间的空闲浪费**，提高了整体吞吐量。

### 什么时候必须用公平锁？

- **防止线程饥饿**：如果锁竞争非常激烈，且线程优先级差异大，非公平锁可能导致某些线程长时间拿不到锁
- **严格的顺序要求**：业务上需要按请求顺序处理
- **长时间持有锁的场景**：锁持有时间远大于上下文切换时间时，非公平的性能优势减弱

> 💡 **经验法则**：99% 的场景用默认的非公平锁。只有明确出现线程饥饿时，才考虑公平锁。

---

## 8. 最佳实践与陷阱

### 8.1 lock() 必须写在 try 外面

```java
// ✅ 正确
lock.lock();
try {
    // 业务代码
} finally {
    lock.unlock();
}

// ❌ 错误
try {
    lock.lock();   // 如果 lock() 之前出现异常（如 lock 为 null）
    // 业务代码
} finally {
    lock.unlock(); // finally 中 unlock 一个未持有的锁 → IllegalMonitorStateException
}
```

**深层原因**：如果 `lock()` 写在 try 内，而 `lock()` 执行前发生了异常（比如 lock 对象本身为 null 引发 NPE），`finally` 中的 `unlock()` 会尝试释放一个没有获取过的锁，导致 `IllegalMonitorStateException`，且会掩盖原始异常。

### 8.2 tryLock 防死锁模式

```java
public void transferMoney(Account from, Account to, int amount) {
    while (true) {
        if (from.lock.tryLock(1, TimeUnit.SECONDS)) {
            try {
                if (to.lock.tryLock(1, TimeUnit.SECONDS)) {
                    try {
                        // 两把锁都拿到了，执行转账
                        from.balance -= amount;
                        to.balance += amount;
                        return;
                    } finally {
                        to.lock.unlock();
                    }
                }
            } finally {
                from.lock.unlock();
            }
        }
        // 没拿到 → 随机等待后重试，避免活锁
        Thread.sleep((long) (Math.random() * 100));
    }
}
```

### 8.3 lockInterruptibly 响应中断

```java
// 适用场景：用户取消操作时，不希望线程一直阻塞等锁
public void cancelableTask() {
    try {
        lock.lockInterruptibly();  // 等锁期间可被中断
        try {
            // 业务代码
        } finally {
            lock.unlock();
        }
    } catch (InterruptedException e) {
        // 被中断了，做清理工作
        Thread.currentThread().interrupt();
        System.out.println("任务被取消");
    }
}
```

### 8.4 synchronized vs ReentrantLock 最终选型

| 场景 | 推荐 | 理由 |
|------|------|------|
| 简单的互斥同步 | `synchronized` | 简洁安全，JVM 自动释放，不会忘记 unlock |
| 需要 tryLock / 超时 | `ReentrantLock` | synchronized 不支持 |
| 需要可中断 | `ReentrantLock` | `lockInterruptibly()` |
| 需要公平锁 | `ReentrantLock` | synchronized 是非公平的 |
| 需要多个 Condition | `ReentrantLock` | synchronized 只有一个等待队列 |
| 需要在 finally 中确保释放 | 都行 | synchronized 自动释放更安全 |

---

## 9. 常见面试题

### Q1：ReentrantLock 和 synchronized 的区别？

**从实现层面回答：**

| 维度 | synchronized | ReentrantLock |
|------|-------------|---------------|
| 实现层面 | JVM 指令（monitorenter/monitorexit） | Java API（基于 AQS） |
| 锁获取 | 自动 | 手动 `lock()` |
| 锁释放 | 自动（异常也会释放） | 手动 `unlock()`（必须 finally） |
| 可重入 | ✅ | ✅ |
| 底层机制 | 对象头 Mark Word + Monitor | AQS 的 state + CLH 队列 |
| 优化 | 偏向锁 → 轻量级锁 → 重量级锁 | CAS 抢锁 → park 阻塞 |

### Q2：AQS 为什么用 CLH 队列而不是普通队列？

CLH 队列的优势：
1. **无锁入队**：通过 CAS 操作 tail 指针实现入队，不需要额外加锁
2. **局部自旋**：每个节点只关注前驱的状态，减少了全局竞争
3. **公平性好**：天然 FIFO 顺序，适合实现公平锁
4. **取消方便**：双向链表支持 O(1) 的节点删除

### Q3：为什么非公平锁比公平锁性能好？

**一句话**：非公平锁在锁释放和下一个线程被唤醒之间的"空窗期"，允许新来的线程直接获取锁，避免了锁空转。

**本质**：线程上下文切换（~10μs）比 CAS（~10ns）慢 1000 倍。非公平锁用 CAS 抢锁替代了部分上下文切换。

### Q4：ReentrantLock 能防止死锁吗？

`ReentrantLock` 本身不能自动检测死锁，但它提供了**预防死锁的工具**：

```java
// 方法1：tryLock 超时
if (lock.tryLock(1, TimeUnit.SECONDS)) { ... }

// 方法2：lockInterruptibly 响应中断
lock.lockInterruptibly();
```

而 `synchronized` 一旦阻塞就无法退出，除非获取到锁或线程被终止。

### Q5：公平锁和非公平锁的代码差异在哪？

**两处差异：**

1. `lock()` 方法：非公平锁先 CAS 插队，公平锁直接 `acquire(1)`
2. `tryAcquire()` 方法：公平锁多了 `!hasQueuedPredecessors()` 检查

本质上就是：**公平锁在每次获取前检查"前面有没有人排队"**。

---

## 10. 总结

### ReentrantLock 全貌

```
ReentrantLock
│
├── Sync (extends AQS)
│     ├── state: 0=空闲, ≥1=持有（重入次数）
│     ├── exclusiveOwnerThread: 持有锁的线程
│     ├── tryRelease(): state-- → 到 0 才真正释放
│     └── newCondition() → ConditionObject（双队列模型）
│
├── NonfairSync
│     ├── lock(): CAS 插队 → acquire(1)
│     └── tryAcquire(): 不检查队列，直接 CAS
│
└── FairSync
      ├── lock(): acquire(1)（不插队）
      └── tryAcquire(): hasQueuedPredecessors() + CAS
```

### 核心结论

| 要点 | 说明 |
|------|------|
| ReentrantLock ≈ AQS + 100 行代码 | 排队、阻塞、唤醒全部复用 AQS |
| 公平 vs 非公平差在一行 | `hasQueuedPredecessors()` |
| 可重入 = state 的递增递减 | state > 0 时 unlock 不会释放锁 |
| Condition = 双队列转移 | await 进条件队列，signal 回同步队列 |
| 默认用非公平，性能好 2-10 倍 | 除非明确需要防饥饿 |

### 系列文章导航

```
已完成：
  📄 Java 并发工具类全景指南         → java-concurrency-tools.md
  📄 AQS — Java 并发的基石           → aqs-deep-dive.md
  📄 ReentrantLock 源码全解（本文）   → reentrantlock-source-code.md

可选后续：
  📝 Semaphore 源码解析 — AQS 共享模式的典型应用
  📝 ReentrantReadWriteLock 源码解析 — 读写锁的 state 拆分设计
  📝 Java 内存模型（JMM）与 happens-before
```

---

> 📝 **作者注**：本文基于 JDK 17 源码。核心设计自 JDK 5 以来保持稳定，不同版本的差异主要在性能优化和代码组织上，不影响理解。
