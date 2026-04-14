---
slug: distributed-lock
title: 聊聊分布式锁：从数据库到 Redis 再到 Redisson
authors: [xiao-xiao-liang]
tags: [分布式锁, Redis, Redisson, Java, 并发编程]
date: 2026-02-17
---

在单机应用时代，一个 `synchronized` 或 `ReentrantLock` 就能解决多线程竞争共享资源的问题。但随着微服务架构的普及，应用被部署在多台服务器上，JVM 级别的本地锁就失效了——它只能保证单进程内的互斥。这时候，就需要一把"分布式锁"来保证跨进程、跨主机的互斥访问。

本文将带你深入了解分布式锁的常见实现方案，特别是 Redis 方案的演进，以及工业级组件 Redisson 的底层原理。

{/* truncate */}

## 1. 分布式锁的核心要求

一个靠谱的分布式锁，通常需要满足以下条件：

1.  **互斥性**：在任意时刻，只能有一个客户端持有锁。
2.  **防死锁**：即使持有锁的客户端崩溃或网络断开，锁也能自动释放（通常通过过期时间实现）。
3.  **可重入性**：同一个客户端可以多次获取同一把锁。
4.  **高性能/高可用**：加锁和解锁需要开销小，且服务要稳定。

---

## 2. 常见的实现方案

### 2.1 基于数据库（MySQL）实现

用 MySQL 来做分布式锁，是一种非常经典的思路。它适合系统规模不大、并发量不高，且不想为了分布式锁单独引入 Redis 或 Zookeeper 的场景。

在 MySQL 中，主流的方案有两种：**基于唯一索引**和**基于悲观锁（`FOR UPDATE`）**。

#### 方案一：基于唯一索引（Unique Key）

这是最容易想到的一种方式。核心思路是：利用数据库唯一索引的约束，让多个节点竞争插入同一条记录，只有一个能成功。**插入成功 = 拿到锁，删除记录 = 释放锁。**

**① 表结构设计**

```sql
CREATE TABLE `distributed_lock` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',
  `resource_name` varchar(64) NOT NULL COMMENT '锁定的资源名称',
  `owner_info` varchar(128) NOT NULL COMMENT '锁持有者信息(如 机器IP + 线程ID)',
  `create_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uidx_resource` (`resource_name`) -- 核心：唯一索引保证互斥
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='分布式锁表';
```

**② 加锁与解锁**

*   **加锁**：尝试插入一条带有资源名称的记录。
    ```sql
    INSERT INTO distributed_lock (resource_name, owner_info) 
    VALUES ('order_12345', '192.168.1.100:thread-1');
    ```
    插入成功说明拿到了锁；如果抛出 `DuplicateKeyException`（唯一键冲突），说明锁已被占，加锁失败。

*   **解锁**：业务执行完毕后，删除记录即可。
    ```sql
    DELETE FROM distributed_lock WHERE resource_name = 'order_12345';
    ```

**③ 存在的问题**

这种方案看起来简单，但在生产环境中有几个绕不开的坑：

| 问题 | 说明 | 解决思路 |
| :--- | :--- | :--- |
| **死锁（服务宕机）** | 持有锁的节点突然宕机，`DELETE` 没执行，记录永远存在 | 引入定时清理任务，删除 `create_time` 超时的记录。但这又带来"业务还没跑完锁就被清掉"的风险 |
| **非阻塞** | `INSERT` 失败直接返回异常，不会像 `synchronized` 那样排队等待 | 代码层面写 `while` 循环 + `Thread.sleep()` 自旋重试 |
| **不可重入** | 同一线程在未释放锁的情况下再次申请，会因为唯一键冲突而失败 | 增加 `reentrant_count` 字段，加锁前先查 `owner_info` 是否是自己，是则计数+1；释放时计数-1，减到 0 才真正 `DELETE` |

---

#### 方案二：基于悲观锁（FOR UPDATE）

这种方案利用了 InnoDB 引擎的**行级排他锁**。通过 `SELECT ... FOR UPDATE`，MySQL 会对命中的行加上 X 锁，其他事务访问同一行时会被**阻塞**，直到持锁事务提交或回滚。

**① 表结构设计**

```sql
CREATE TABLE `distributed_lock` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `resource_name` varchar(64) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uidx_resource` (`resource_name`) -- 必须有索引！
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

:::caution 重要前提
你需要提前在表里插入好对应的资源记录（或在代码中先做一次 `INSERT IGNORE`），因为 `FOR UPDATE` 锁的是已存在的行。
:::

**② 加锁与解锁**

```sql
-- 1. 开启事务
BEGIN;

-- 2. 加锁：如果该行已被其他事务锁定，当前语句会阻塞等待
SELECT * FROM distributed_lock 
WHERE resource_name = 'order_12345' FOR UPDATE;

-- 3. 执行业务逻辑...

-- 4. 释放锁：提交事务，MySQL 自动释放行锁
COMMIT;
```

在 Spring 中，可以通过 `@Transactional` 注解配合 MyBatis/JPA 来实现。

**③ 优势与踩坑**

**优势：**
*   **天然防死锁**：如果服务宕机，数据库连接断开，MySQL 会自动回滚事务并释放行锁。不需要像方案一那样搞定时清理。
*   **天然阻塞**：`FOR UPDATE` 本身就会排队等待，不需要在代码里写重试循环。

**踩坑：**
*   **索引失效 → 表锁**：InnoDB 的行锁是基于**索引**实现的。如果 `WHERE` 条件的字段没有命中索引，行锁会**退化为表锁**，锁住整张表，导致所有并发请求串行化，吞吐量骤降。这是最危险的坑。
*   **连接池耗尽**：整个业务执行期间，数据库连接一直被占用。如果业务逻辑耗时较长，连接池会被迅速耗尽。因此必须保证加锁后的逻辑**快进快出**，严禁在事务中做 RPC 调用或大量 IO 操作。

---

#### MySQL 方案对比

| 特性 | 基于唯一索引 (INSERT) | 基于悲观锁 (FOR UPDATE) |
| :--- | :--- | :--- |
| **实现难度** | 中等（需配合重试、超时清理） | 简单（利用事务特性） |
| **死锁风险** | 高（宕机需定时任务兜底） | 低（连接断开自动释放） |
| **等待方式** | 代码自旋（消耗 CPU） | 数据库阻塞（需配置锁等待超时 `innodb_lock_wait_timeout`） |
| **性能** | 较差（高并发下大量唯一键冲突） | 一般（长事务占连接） |

:::tip 选型建议
- 如果只是防止定时任务重复执行这类低并发场景，`FOR UPDATE` 方案更省心。
- 如果分布式锁在核心业务链路上，且并发量较高（如秒杀、支付），**请不要用 MySQL 做分布式锁**，它会成为系统瓶颈。此时应该转向 Redis (Redisson) 或 Zookeeper。
:::

### 2.2 基于 Redis 的基础实现

Redis 是内存数据库，性能极高，天然适合做分布式锁。我们先不谈 Redisson，来看看**用原生 Redis 命令手动实现分布式锁**的演进过程——理解这个过程，才能真正理解 Redisson 到底帮我们解决了什么。

#### 版本 1.0：SETNX + EXPIRE（有致命缺陷）

最朴素的想法：用 `SETNX`（SET if Not eXists）抢占一个 key，谁抢到谁就持有锁。

```java
if (redis.setnx("lock_key", "value") == 1) {
    redis.expire("lock_key", 30); // 设置30秒过期
    try {
        // 业务逻辑
    } finally {
        redis.del("lock_key");
    }
}
```

:::danger 致命问题：非原子操作
`SETNX` 和 `EXPIRE` 是**两条独立命令**。如果 `SETNX` 成功后、`EXPIRE` 执行前，服务器恰好宕机了，这把锁就**永远不会过期**——死锁。
:::

#### 版本 2.0：原子加锁（SET NX PX）

从 Redis 2.6.12 开始，`SET` 命令支持参数组合，一条命令搞定加锁 + 过期：

```bash
SET lock_key unique_value NX PX 30000
```

| 参数 | 含义 |
| :--- | :--- |
| `NX` | **N**ot e**X**ists，Key 不存在时才设置成功 |
| `PX 30000` | 设置 30000 毫秒（30秒）后自动过期 |
| `unique_value` | 设置为 UUID，用于标识谁持有这把锁 |

对应的 Java 代码（使用 Jedis）：

```java
String lockKey = "lock:order:12345";
String uniqueValue = UUID.randomUUID().toString();

// 原子加锁：SET key value NX PX 毫秒
String result = jedis.set(lockKey, uniqueValue, SetParams.setParams().nx().px(30000));
if ("OK".equals(result)) {
    // 加锁成功
}
```

到这一步，加锁的原子性问题解决了。但解锁呢？

#### 版本 2.1：安全解锁（Lua 脚本保证原子性）

很多人解锁时直接 `DEL lock_key`，这会造成一个严重问题——**误删别人的锁**。来看一个时间线：

```
时间轴：

  0s     A 加锁成功（过期时间 30s）
  |      A 开始执行业务...
  |
 30s     锁自动过期！A 的锁没了
 31s     B 加锁成功
  |      B 开始执行业务...
  |
 40s     A 业务终于跑完了，执行 DEL lock_key
         A 把 B 的锁删了！
 41s     C 加锁成功......
         此时 B 和 C 同时在执行，互斥性被打破
```

**解决方案**：Value 设成 UUID，删除前先比对是不是自己的锁，是才删除。但关键是：**判断 + 删除必须是原子操作**，否则在判断之后、删除之前锁过期了仍然会出问题。

所以必须用 **Lua 脚本**来保证原子性：

```lua
-- 解锁 Lua 脚本
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
```

Redis 执行 Lua 脚本是原子的（单线程模型），中间不会被其他命令打断。

```java
// Java 调用 Lua 脚本解锁
String luaScript = 
    "if redis.call('get', KEYS[1]) == ARGV[1] then " +
    "  return redis.call('del', KEYS[1]) " +
    "else " +
    "  return 0 " +
    "end";

Object result = jedis.eval(luaScript, 
    List.of(lockKey),    // KEYS[1]
    List.of(uniqueValue) // ARGV[1]
);
```

#### 还有什么问题？

到版本 2.1，我们已经解决了**原子加锁**和**安全解锁**两个问题。但还有几个靠手动编码很难完美解决的痛点：

**1. 锁过期时间不好设**

这是一个两难困境：
*   **设短了**：业务没执行完锁就过期了，互斥性被打破。
*   **设长了**：万一节点宕机，其他节点需要等待整个过期周期才能拿到锁，影响可用性。
*   **本质问题**：业务执行时间难以精确预估。网络抖动、Full GC 停顿、数据量突增，都可能导致实际执行时间远超预期。

**2. 不支持可重入**

如果同一个线程在持有锁的情况下需要再次加锁（比如嵌套调用），用 `SET NX` 会失败，因为 Key 已经存在了。

**3. 加锁失败没有等待机制**

`SET NX` 失败就直接返回了，想要阻塞等待只能自己写 `while` 循环轮询，既浪费 CPU 又不优雅。

:::info 小结
手动实现 Redis 分布式锁，写到最后你会发现：要处理原子性、要写 Lua 脚本、要考虑续期、要实现可重入、要处理等待队列...... 这些全都是 **Redisson** 帮你做好的事情。
:::

---

## 3. Redisson：工业级解决方案

Redisson 是一个在 Redis 基础上实现的 Java 驻内存数据网格（In-Memory Data Grid）。它提供的 `RLock` 几乎完美解决了我们手动实现时遇到的所有痛点：原子性、可重入、自动续期、阻塞等待。

### 3.1 基本用法

```java
RLock lock = redisson.getLock("lock:order:12345");
try {
    // 加锁（不指定 leaseTime，自动启用看门狗续期）
    lock.lock();
    // 执行业务逻辑...
} finally {
    // 必须在 finally 中解锁
    if (lock.isHeldByCurrentThread()) {
        lock.unlock();
    }
}
```

还有一个更常用的 `tryLock`，支持设置**等待时间**和**锁持有时间**：

```java
RLock lock = redisson.getLock("lock:order:12345");
try {
    // 最多等待 5 秒获取锁，获取成功后 30 秒自动释放
    // 注意：指定了 leaseTime 后，看门狗不会启动！
    boolean acquired = lock.tryLock(5, 30, TimeUnit.SECONDS);
    if (acquired) {
        // 执行业务逻辑...
    } else {
        // 5秒内没拿到锁，走降级或提示
    }
} finally {
    if (lock.isHeldByCurrentThread()) {
        lock.unlock();
    }
}
```

:::warning lock() vs tryLock() 的重要区别
- `lock()`：阻塞等待，不指定 leaseTime，**看门狗自动续期**，推荐用于业务执行时间不可预估的场景。
- `tryLock(waitTime, leaseTime, unit)`：指定了 leaseTime，**看门狗不会启动**，锁到期后直接释放。如果你的业务可能超过 leaseTime 但没有看门狗续期，互斥性就被打破了。
- 最佳实践：如果不确定业务耗时，用 `tryLock(waitTime, -1, unit)`（leaseTime 传 -1），这样既有超时等待，又有看门狗续期。
:::

### 3.2 核心原理揭秘

Redisson 的强大在于两个核心设计：**Lua 脚本保证原子性** + **Watchdog（看门狗）自动续期**。

#### (1) 加锁机制

Redisson 加锁时执行的 Lua 脚本（简化版）：

```lua
-- KEYS[1] = 锁的名称
-- ARGV[1] = 过期时间（默认 30000 ms）
-- ARGV[2] = 客户端唯一标识（UUID:threadId）

-- 1. 锁不存在 -> 直接加锁
if (redis.call('exists', KEYS[1]) == 0) then
    redis.call('hincrby', KEYS[1], ARGV[2], 1)    -- 设置持有者，重入次数=1
    redis.call('pexpire', KEYS[1], ARGV[1])        -- 设置过期时间
    return nil                                      -- 返回nil表示加锁成功
end

-- 2. 锁存在，且是自己持有 -> 重入
if (redis.call('hexists', KEYS[1], ARGV[2]) == 1) then
    redis.call('hincrby', KEYS[1], ARGV[2], 1)    -- 重入次数 +1
    redis.call('pexpire', KEYS[1], ARGV[1])        -- 重置过期时间
    return nil
end

-- 3. 锁被别人持有 -> 返回锁的剩余TTL（加锁失败）
return redis.call('pttl', KEYS[1])
```

注意到没有？Redisson 用的是 **Hash 结构**（`HINCRBY`），而不是简单的 String。Key 是锁名，Field 是 `UUID:threadId`，Value 是**重入次数**。这就是可重入锁的实现原理——同一个线程再次加锁时，只需要把计数 +1 就行。

在 Redis 中存储的数据长这样：

```
Key: "lock:order:12345" (Hash类型)
+-----------------------------------+-------+
| Field (UUID:threadId)             | Value |
+-----------------------------------+-------+
| 6f3e8a...:thread-1                |   2   |  <-- 重入了2次
+-----------------------------------+-------+
TTL: 30000ms
```

#### (2) Watchdog 看门狗（自动续期）

这是 Redisson 最精妙的设计，完美解决了「锁过期时间不好设」的难题。

**触发条件**：只有在**不指定 leaseTime** 时（即调用 `lock()` 或 `tryLock(waitTime, -1, unit)`），看门狗才会启动。

**运作机制**：

```
加锁成功
  |
  +-- 默认过期时间 = 30秒（lockWatchdogTimeout）
  |
  +-- 启动后台定时任务，每 10秒（30s / 3）触发一次
  |     |
  |     +-- 检查当前线程是否还持有锁？
  |     |     +-- 是 -> 续期至 30秒，继续定时
  |     |     +-- 否 -> 停止续期
  |     |
  |    ... (每10秒重复)
  |
  +-- [正常情况] 业务跑完 -> 手动 unlock() -> 取消看门狗任务
  |
  +-- [异常情况] 服务宕机 -> 看门狗随进程一起消失
                          -> 没人续期 -> 30秒后锁自动释放
```

**这个设计的巧妙之处**：
1.  **业务没跑完**：看门狗持续续期，锁不会意外过期。
2.  **业务跑完了**：手动 `unlock()`，看门狗任务被取消，锁被主动释放。
3.  **机器宕机了**：看门狗线程也没了，没人续期，30 秒后 Redis 自动删除 Key，锁释放。**完美兜底！**

#### (3) 解锁机制

解锁同样用 Lua 脚本保证原子性（简化版）：

```lua
-- KEYS[1] = 锁名称
-- KEYS[2] = 发布/订阅的 channel 名称
-- ARGV[1] = 解锁消息（固定值 0）
-- ARGV[2] = 过期时间
-- ARGV[3] = 客户端标识（UUID:threadId）

-- 1. 锁不是自己的 -> 返回nil（防止误删）
if (redis.call('hexists', KEYS[1], ARGV[3]) == 0) then
    return nil
end

-- 2. 重入次数 -1
local counter = redis.call('hincrby', KEYS[1], ARGV[3], -1)

-- 3. 还有重入层数 -> 不能真正释放，只重置过期时间
if (counter > 0) then
    redis.call('pexpire', KEYS[1], ARGV[2])
    return 0
end

-- 4. 重入次数归零 -> 真正释放锁，并发布通知
redis.call('del', KEYS[1])
redis.call('publish', KEYS[2], ARGV[1])  -- 通知等待的客户端
return 1
```

注意最后一步的 `PUBLISH`——Redisson 用 Redis 的**发布/订阅（Pub/Sub）**机制来通知其他等待锁的客户端。当锁被释放时，等待方会收到消息并尝试重新加锁，比傻轮询高效得多。

#### (4) 等待锁的过程

当 `tryLock` 加锁失败时，Redisson 并不是简单地 `while(true)` 轮询，而是：

1.  **订阅**锁释放的 Channel（`redisson_lock__channel:{锁名}`）。
2.  进入**阻塞等待**（基于 Semaphore），不消耗 CPU。
3.  收到锁释放的**通知**后，再次尝试加锁。
4.  如果超过 `waitTime` 仍未获取到，返回 `false`。

这种「订阅 + 信号量」的方式，比自旋轮询高效很多，大幅减少了无效的 Redis 请求。

### 3.3 Redisson 的注意事项

虽然 Redisson 已经足够强大，但仍有几个需要注意的地方：

#### ① 主从切换导致锁丢失

Redis 主从复制是**异步**的。考虑这个场景：

```
1. Client A 在 Master 上加锁成功
2. Master 还没把锁数据同步到 Slave
3. Master 宕机！
4. Slave 升级为 New Master（哨兵/集群自动故障转移）
5. Client B 在 New Master 上加锁成功
   -> 两个客户端同时持有锁！互斥性被打破
```

**解决方案**：Redisson 提供了 **RedLock** 算法（`getMultiLock()`），向多个独立的 Redis 实例同时请求锁，**过半成功**才算加锁成功。但实际生产中，RedLock 运维成本较高，且存在争议（Martin Kleppmann 与 Redis 作者 Antirez 的经典论战，感兴趣可搜索 *"How to do distributed locking"*）。大多数团队选择接受极小概率的锁丢失，或转向 Zookeeper 等 CP 模型的协调服务。

#### ② unlock() 必须加保护

如果当前线程没有持有锁就调用 `unlock()`，Redisson 会抛出 `IllegalMonitorStateException`。所以务必在 `finally` 中加上判断：

```java
finally {
    // 只有当前线程持有锁时才解锁
    if (lock.isHeldByCurrentThread()) {
        lock.unlock();
    }
}
```

#### ③ 不要在锁内做耗时 IO

即使有看门狗续期，也不要在持锁期间做 RPC 调用、大文件读写等耗时操作。持锁时间越长，系统的并发吞吐量越低。原则是**快进快出**。

---

## 4. Zookeeper 分布式锁

Zookeeper (ZK) 是 CP 模型（强一致性），天然适合做分布式协调。

*   **原理**：利用 ZK 的**临时顺序节点**。
    1.  客户端在 `/locks` 下创建一个临时顺序节点。
    2.  判断自己是不是序号最小的节点？
        *   是 -> 获得锁。
        *   否 -> 监听（Watch）前一个节点。
    3.  前一个节点删除（锁释放或对方挂了），触发 Watch 事件，自己再次判断是否是最小。

**对比 Redis vs Zookeeper**：

| 维度 | Redis (Redisson) | Zookeeper |
| :--- | :--- | :--- |
| **一致性** | 弱（AP模型，主从切换可能丢锁） | 强（CP模型，保证一致性） |
| **性能** | 极高（内存操作） | 中等（需要写磁盘日志，Leader同步） |
| **死锁风险** | 靠过期时间兜底 | 靠临时节点（Session断开自动删除） |
| **适用场景** | 高并发业务（秒杀、库存扣减） | 对一致性要求极高的场景 |

---

## 5. 总结

在大多数互联网业务场景下，**Redis (Redisson)** 是性价比最高的选择。

*   如果是**高并发的互联网业务**（秒杀、库存扣减），追求极致性能，能接受极端情况下（主从切换）极小概率的并发冲突 → **选 Redis (Redisson)**。
*   如果是**金融级场景**，涉及资金操作，绝不允许任何并发差错 → **选 Zookeeper** 或 **数据库悲观锁**（适用于并发量不大的场景）。

**最后建议**：不要自己造轮子去写 Redis 分布式锁（SETNX），坑太多了。直接用 Redisson，省心省力！
