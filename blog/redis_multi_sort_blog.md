# 🚀 实战解析：如何在 Redis 中优雅实现「距离 + 活跃度」的多维混合排序？

## 💡 业务背景与技术痛点

在社交、O2O 等业务中，**"查找附近的人"** 是一个高频场景。大部分开发者第一反应是使用 Redis 从 3.2 版本引入的 `GEO` 数据结构。

使用 `GEOADD` 写入坐标，使用 `GEOSEARCH`（或旧版的 `GEORADIUS`）按距离搜索，看起来一切都很完美。但当产品经理提出新需求时——

> **"不仅要离得近，还要优先展示最近活跃过的用户（距离 + 活跃度混合排序）"**

技术痛点就出现了。

### 为什么 Redis GEO 做不到？

Redis `GEO` 底层的本质是 `ZSET`（有序集合）。它利用 **GeoHash 算法**将二维经纬度转化为一维的 52 位整数，并**强行占用了 ZSET 唯一的 Score 字段**来存储这个整数。

```
┌─────────────────────────────────────────────────┐
│              Redis GEO 底层结构                   │
│                                                   │
│   ZSET Key: "nearby_users"                        │
│   ┌──────────┬──────────────────────────┐         │
│   │  Member  │   Score (GeoHash 值)      │         │
│   ├──────────┼──────────────────────────┤         │
│   │  user:1  │  4054421060663041        │  ← 经纬度编码后的整数 │
│   │  user:2  │  4054421060812801        │  ← 被 GeoHash 占了！ │
│   │  user:3  │  4054421061038081        │  ← 没位置放活跃度了   │
│   └──────────┴──────────────────────────┘         │
│                                                   │
│   ❌ Score 已被占用，无法再存第二个排序字段         │
└─────────────────────────────────────────────────┘
```

所以，Redis 的原生 GEO 命令**只能按距离排序**，根本无法传入第二个业务字段（如活跃度）进行联合排序。

面对这个限制，业界通常有两套架构演进方案。

---

## 方案一：经典架构 ——「粗排召回 + 内存精排」（应用层计算）

这是在不升级现有标准版 Redis 基础设施的情况下，**最成熟、落地最广**的架构方案。

核心思想是：**把 Redis 当作「召回引擎」，把 Java 业务服务当作「精排引擎」。**

### 1. 架构流程图

```
┌──────────┐      ①请求20条        ┌──────────────────┐
│          │ ──────────────────────▶ │   Java 应用服务   │
│  客户端   │                        │                    │
│          │ ◀────────────────────── │  ⑤ 返回Top20       │
└──────────┘      精排后的20条       └─────┬──────┬───────┘
                                         │      │
                            ②GEOSEARCH   │      │ ③HMGET
                            召回200条     │      │ 批量查活跃度
                                         ▼      ▼
                                   ┌──────────────────┐
                                   │      Redis        │
                                   │                    │
                                   │  GEO: 坐标数据     │
                                   │  HASH: 活跃度数据  │
                                   └──────────────────┘
                                         │
                            ④ Java 内存中进行
                            归一化 + 加权计算 + 排序
```

整个流程分为 5 步：

1. **扩大召回池 (Recall)**：客户端请求 20 条数据，后端向 Redis 请求 **200 条**（适度放大 10 倍的召回量）。
2. **批量获取活跃度 (Batch Fetch)**：拿到 200 个用户 ID 后，通过 `Pipeline` 批量从 Hash 中查出活跃度得分。
3. **归一化计算 (Normalize)**：将距离和活跃度分别映射到 `[0, 1]` 区间，消除量纲差异。
4. **加权打分 (Rerank)**：配合业务权重（如距离 60%，活跃度 40%）计算综合分。
5. **截断返回 (Truncate)**：按综合分降序排列，截取 Top 20 返回前端。

### 2. Mock 数据准备

假设当前用户"我"的坐标是 **北京天安门 (116.404, 39.915)**，我们先往 Redis 灌入一批模拟用户数据：

```bash
# ============ 第一步：写入用户坐标到 GEO ============
# GEOADD key longitude latitude member
GEOADD nearby:users 116.408 39.918 user:A
GEOADD nearby:users 116.398 39.910 user:B
GEOADD nearby:users 116.420 39.930 user:C
GEOADD nearby:users 116.450 39.950 user:D
GEOADD nearby:users 116.380 39.900 user:E
GEOADD nearby:users 116.410 39.916 user:F
GEOADD nearby:users 116.500 39.980 user:G
GEOADD nearby:users 116.390 39.905 user:H

# ============ 第二步：写入用户活跃度到 HASH ============
# 活跃度得分范围 [0, 100]，越高越活跃
HSET user:activity user:A 30
HSET user:activity user:B 95
HSET user:activity user:C 60
HSET user:activity user:D 85
HSET user:activity user:E 10
HSET user:activity user:F 50
HSET user:activity user:G 90
HSET user:activity user:H 75
```

用表格看一下这批数据：

| 用户 | 经度 | 纬度 | 与我的真实距离(km) | 活跃度 |
|:--|:--|:--|:--|:--|
| user:A | 116.408 | 39.918 | ≈ 0.5 | 30 |
| user:F | 116.410 | 39.916 | ≈ 0.5 | 50 |
| user:B | 116.398 | 39.910 | ≈ 0.7 | 95 |
| user:H | 116.390 | 39.905 | ≈ 1.5 | 75 |
| user:C | 116.420 | 39.930 | ≈ 2.1 | 60 |
| user:D | 116.450 | 39.950 | ≈ 5.3 | 85 |
| user:E | 116.380 | 39.900 | ≈ 2.7 | 10 |
| user:G | 116.500 | 39.980 | ≈ 11.0 | 90 |

> **注意观察**：如果纯按距离排，user:A 排第一（最近但活跃度只有 30）；如果纯按活跃度排，user:B 排第一（活跃度 95 但距离 0.7km）。**混合排序的目标就是在两者间找到平衡。**

### 3. 完整 Java 代码实现

#### 3.1 核心数据模型

```java
/**
 * 附近用户信息（含距离和活跃度）
 */
public record NearbyUser(
    String userId,
    double distanceKm,    // 与"我"的距离（公里）
    int activityScore,    // 活跃度得分 [0, 100]
    double finalScore     // 综合打分（归一化加权后）
) {
    /**
     * 构造时不传 finalScore，后续计算后赋值
     */
    public NearbyUser(String userId, double distanceKm, int activityScore) {
        this(userId, distanceKm, activityScore, 0.0);
    }

    public NearbyUser withFinalScore(double score) {
        return new NearbyUser(userId, distanceKm, activityScore, score);
    }
}
```

#### 3.2 召回 + 精排服务

```java
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.geo.*;
import org.springframework.data.redis.connection.RedisGeoCommands;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class NearbyUserService {

    private final StringRedisTemplate redisTemplate;

    /** GEO Key */
    private static final String GEO_KEY = "nearby:users";
    /** 活跃度 Hash Key */
    private static final String ACTIVITY_KEY = "user:activity";
    /** 召回倍率：请求 N 条 → 召回 N * RECALL_RATIO 条 */
    private static final int RECALL_RATIO = 10;
    /** 排序权重 */
    private static final double WEIGHT_DISTANCE = 0.6;
    private static final double WEIGHT_ACTIVITY = 0.4;

    /**
     * 查询附近的人（距离 + 活跃度混合排序）
     *
     * @param myLon       我的经度
     * @param myLat       我的纬度
     * @param radiusKm    搜索半径（公里）
     * @param pageSize    需要返回的条数
     * @return 混合排序后的用户列表
     */
    public List<NearbyUser> findNearbyUsers(double myLon, double myLat,
                                            double radiusKm, int pageSize) {
        // ============ Step 1: 扩大召回 ============
        int recallCount = pageSize * RECALL_RATIO;

        // 构造搜索参数：按距离升序，限制召回数量
        RedisGeoCommands.GeoSearchCommandArgs args = RedisGeoCommands
                .GeoSearchCommandArgs.newGeoSearchArgs()
                .includeDistance()     // 返回距离
                .sortAscending()      // 距离近的优先
                .limit(recallCount);  // 限制召回数量

        GeoResults<RedisGeoCommands.GeoLocation<String>> geoResults =
                redisTemplate.opsForGeo().search(
                        GEO_KEY,
                        GeoReference.fromCoordinate(myLon, myLat),
                        new Distance(radiusKm, Metrics.KILOMETERS),
                        args
                );

        if (geoResults == null || geoResults.getContent().isEmpty()) {
            log.info("召回阶段：半径 {}km 内未找到用户", radiusKm);
            return Collections.emptyList();
        }

        List<GeoResult<RedisGeoCommands.GeoLocation<String>>> results =
                geoResults.getContent();
        log.info("召回阶段：半径 {}km 内召回 {} 个用户", radiusKm, results.size());

        // ============ Step 2: 批量获取活跃度 ============
        List<String> userIds = results.stream()
                .map(r -> r.getContent().getName())
                .toList();

        // 使用 HMGET 一次网络往返拿到所有活跃度
        List<Object> activityScores = redisTemplate.opsForHash()
                .multiGet(ACTIVITY_KEY, Collections.unmodifiableList(userIds));

        // 组装 Map<userId, activityScore>
        Map<String, Integer> activityMap = new HashMap<>();
        for (int i = 0; i < userIds.size(); i++) {
            Object raw = activityScores.get(i);
            int score = (raw != null) ? Integer.parseInt(raw.toString()) : 0;
            activityMap.put(userIds.get(i), score);
        }

        // ============ Step 3: 构建候选列表 ============
        List<NearbyUser> candidates = results.stream()
                .map(r -> new NearbyUser(
                        r.getContent().getName(),
                        r.getDistance().getValue(),
                        activityMap.getOrDefault(r.getContent().getName(), 0)
                ))
                .toList();

        // ============ Step 4: 归一化 + 加权打分 ============
        return rerank(candidates, pageSize);
    }

    /**
     * 精排：归一化 + 加权 + 截断
     */
    private List<NearbyUser> rerank(List<NearbyUser> candidates, int pageSize) {
        if (candidates.isEmpty()) {
            return Collections.emptyList();
        }

        // --- 4.1 找出距离和活跃度的最大最小值 ---
        double maxDist = candidates.stream()
                .mapToDouble(NearbyUser::distanceKm).max().orElse(1.0);
        double minDist = candidates.stream()
                .mapToDouble(NearbyUser::distanceKm).min().orElse(0.0);
        int maxActivity = candidates.stream()
                .mapToInt(NearbyUser::activityScore).max().orElse(1);
        int minActivity = candidates.stream()
                .mapToInt(NearbyUser::activityScore).min().orElse(0);

        double distRange = (maxDist - minDist) == 0 ? 1.0 : (maxDist - minDist);
        double actRange = (maxActivity - minActivity) == 0 ? 1.0 : (maxActivity - minActivity);

        // --- 4.2 归一化 + 加权计算 ---
        // 距离：越近得分越高 → distScore = 1 - (dist - minDist) / distRange
        // 活跃度：越高得分越高 → actScore = (act - minActivity) / actRange
        List<NearbyUser> scored = candidates.stream()
                .map(u -> {
                    double distScore = 1.0 - (u.distanceKm() - minDist) / distRange;
                    double actScore = (u.activityScore() - minActivity) / actRange;
                    double finalScore = WEIGHT_DISTANCE * distScore
                                      + WEIGHT_ACTIVITY * actScore;
                    return u.withFinalScore(finalScore);
                })
                .toList();

        // --- 4.3 按 finalScore 降序排列，截断返回 ---
        return scored.stream()
                .sorted(Comparator.comparingDouble(NearbyUser::finalScore).reversed())
                .limit(pageSize)
                .collect(Collectors.toList());
    }
}
```

#### 3.3 Controller 层

```java
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/nearby")
@RequiredArgsConstructor
public class NearbyUserController {

    private final NearbyUserService nearbyUserService;

    /**
     * 查询附近的人
     *
     * @param lon      我的经度
     * @param lat      我的纬度
     * @param radiusKm 搜索半径，默认 10km
     * @param size     返回条数，默认 5
     */
    @GetMapping("/users")
    public List<NearbyUser> nearby(
            @RequestParam double lon,
            @RequestParam double lat,
            @RequestParam(defaultValue = "10") double radiusKm,
            @RequestParam(defaultValue = "5") int size) {
        return nearbyUserService.findNearbyUsers(lon, lat, radiusKm, size);
    }
}
```

### 4. Mock 数据走一遍全流程

假设客户端请求：`GET /api/nearby/users?lon=116.404&lat=39.915&radiusKm=10&size=3`

#### Step 1：召回阶段

Redis `GEOSEARCH` 在 10km 半径内按距离升序返回（`size=3`，`RECALL_RATIO=10`，所以召回 30 条，但我们只有 7 条在范围内）：

| 排序 | 用户 | 距离(km) |
|:--|:--|:--|
| 1 | user:A | 0.50 |
| 2 | user:F | 0.52 |
| 3 | user:B | 0.72 |
| 4 | user:H | 1.52 |
| 5 | user:C | 2.10 |
| 6 | user:E | 2.71 |
| 7 | user:D | 5.30 |

> user:G 距离 11km，超出 10km 半径，被过滤掉了。

#### Step 2：批量查活跃度

一次 `HMGET user:activity user:A user:F user:B user:H user:C user:E user:D`，得到：

| 用户 | 距离(km) | 活跃度 |
|:--|:--|:--|
| user:A | 0.50 | 30 |
| user:F | 0.52 | 50 |
| user:B | 0.72 | 95 |
| user:H | 1.52 | 75 |
| user:C | 2.10 | 60 |
| user:E | 2.71 | 10 |
| user:D | 5.30 | 85 |

#### Step 3：归一化计算

找出最值：
- 距离：min=0.50，max=5.30，range=4.80
- 活跃度：min=10，max=95，range=85

归一化公式：
- **距离得分** = `1 - (dist - 0.50) / 4.80`（越近越高）
- **活跃度得分** = `(activity - 10) / 85`（越活跃越高）

| 用户 | 距离(km) | 距离归一化 | 活跃度 | 活跃度归一化 |
|:--|:--|:--|:--|:--|
| user:A | 0.50 | **1.000** | 30 | 0.235 |
| user:F | 0.52 | **0.996** | 50 | 0.471 |
| user:B | 0.72 | **0.954** | 95 | **1.000** |
| user:H | 1.52 | 0.788 | 75 | 0.765 |
| user:C | 2.10 | 0.667 | 60 | 0.588 |
| user:E | 2.71 | 0.540 | 10 | 0.000 |
| user:D | 5.30 | 0.000 | 85 | 0.882 |

#### Step 4：加权打分（距离 60% + 活跃度 40%）

```
FinalScore = 0.6 × 距离归一化 + 0.4 × 活跃度归一化
```

| 用户 | 距离归一化 | 活跃度归一化 | **FinalScore** | **最终排名** |
|:--|:--|:--|:--|:--|
| user:B | 0.954 | 1.000 | **0.972** | 🥇 1 |
| user:F | 0.996 | 0.471 | **0.786** | 🥈 2 |
| user:H | 0.788 | 0.765 | **0.779** | 🥉 3 |
| user:A | 1.000 | 0.235 | 0.694 | 4 |
| user:C | 0.667 | 0.588 | 0.636 | 5 |
| user:D | 0.000 | 0.882 | 0.353 | 6 |
| user:E | 0.540 | 0.000 | 0.324 | 7 |

#### Step 5：截断 Top 3 返回

最终返回：**user:B → user:F → user:H**

> 🔍 **分析结果**：
> - user:A 虽然距离最近（0.50km），但活跃度太低（30），被挤到了第 4 名。
> - user:B 虽然距离稍远（0.72km），但活跃度拉满（95），综合分最高，排名第一。
> - user:D 虽然活跃度很高（85），但距离太远（5.3km），综合分被距离权重压低。
>
> 这就是**混合排序的魅力**——在"近"和"活跃"之间找到最佳平衡点。

### 5. 优缺点评估

**✅ 优点：**
- **兼容性极强**：适用于所有 3.2+ 版本的标准 Redis，不需要任何模块或升级。
- **业务极度灵活**：排序逻辑在 Java 代码中，你可以随时接入更多维度（VIP 等级、同城加分、性别偏好），甚至对接推荐算法模型。权重调整只需改配置，无需改任何数据结构。

**❌ 缺点：**
- **网络 I/O 放大**：为了拿 3 条数据，实际传输了 7 条 GEO 数据 + 7 次 HASH 查询。在百万级用户场景下，这个放大效应会很明显。
- **JVM 内存压力**：高并发场景下，每个请求都要在内存中创建候选列表、做排序，容易引发 GC 抖动。
- **极小概率的「漏斗效应」**：如果召回池的 200 人活跃度都很低，而第 201 个人虽然远一点但活跃度极高，他会被召回阶段直接淘汰，永远不会出现在结果中。

---

## 方案二：降维打击 ——「原生多维联合索引」（存储层计算）

### 0. 在讲方案之前：什么是 RediSearch？

很多开发者对 Redis 的认知还停留在"缓存 + 简单数据结构"的阶段。但 Redis 在近几年发生了重大进化：

```
Redis 版本进化路线（与搜索相关）：

Redis 3.2 (2016)  ── 引入 GEO 命令
       │
Redis Modules (2017) ── 支持加载第三方模块
       │
RediSearch 1.0 (2018) ── 独立模块，需手动安装
       │
Redis Stack (2022) ── 官方整合包，内置 RediSearch + RedisJSON 等
       │
Redis 8.0 (2025) ── RediSearch 不再是模块，成为 Redis 核心的一部分！
```

**RediSearch 做了一件什么事？**

简单来说，它让 Redis 从一个"只能按 Key 查、按 Score 排"的 KV 存储，进化成了一个**支持全文搜索、多条件过滤、多字段排序**的内存数据库。

你可以把它类比为：**给 Redis 装上了一个 Elasticsearch 级别的查询引擎**，但因为数据本身就在内存里，所以比 ES 快得多。

### 1. 核心概念：数据与索引分离

在传统 Redis 中，数据结构本身就是"索引"。比如 ZSET 的 Score 就是排序依据，GEO 的 GeoHash 也是排序依据。这种设计简单高效，但**一个数据结构只能支撑一种排序方式**。

RediSearch 引入了**数据与索引分离**的思想：

```
传统 Redis:
┌─────────────────────────────┐
│  ZSET（数据 = 索引）          │
│  Score 只能存一个值           │
│  只能按一个维度排序            │
└─────────────────────────────┘

RediSearch:
┌─────────────────────────────┐      ┌───────────────────────────┐
│  HASH / JSON（纯数据存储）    │      │  自动维护的多种索引         │
│                               │ ───▶ │                             │
│  user:1 {                     │      │  ☑ location → Quadtree     │
│    location: "116.4,39.9"     │      │  ☑ activity  → SkipList    │
│    activity: 85               │      │  ☑ nickname  → Trie 前缀树  │
│    vip_level: 3               │      │  ☑ bio       → 倒排索引     │
│  }                            │      │                             │
└─────────────────────────────┘      └───────────────────────────┘
         数据层                               索引层
      （你来写入）                       （RediSearch 自动维护）
```

你只需要把数据写入普通的 `HASH`，然后通过 `FT.CREATE` 命令告诉 Redis："请帮我对这些字段自动建立索引"。之后的写入、更新、删除操作，索引会**自动同步更新**，无需你手动维护。

### 2. 底层索引结构详解

RediSearch 为不同的字段类型选择了不同的最优索引结构：

| 字段类型 | 对应的索引结构 | 为什么选它 |
|:--|:--|:--|
| `GEO`（地理位置） | **Quadtree（四叉树）** | 高效地将二维空间递归分割为4个象限，范围查询时间复杂度 O(log n) |
| `NUMERIC`（数值） | **SkipList（跳表）** + 区间树 | 支持范围查询和排序，与 Redis ZSET 底层一致，性能有保障 |
| `TEXT`（全文本） | **Inverted Index（倒排索引）** | 与 Elasticsearch 原理相同，分词后建立 term → docId 的映射 |
| `TAG`（标签） | **Trie（前缀树）** + 倒排 | 精确匹配或前缀匹配，适合枚举类字段（性别、城市等） |

当我们执行一条联合查询时，RediSearch 在底层的工作流程如下：

```
查询命令:
FT.SEARCH users_idx "@location:[116.404 39.915 10 km]" SORTBY activity_score DESC

底层执行过程:

Step 1: Quadtree 范围查询
┌─────────────────────────────┐
│      四叉树空间索引            │
│                               │
│   以(116.404, 39.915)为圆心   │
│   10km 为半径                 │
│   快速剪枝，筛出候选集         │
│                               │
│   输出: {A, B, C, F, H, E, D} │  ← 7 个用户在范围内
└───────────┬─────────────────┘
            │
            ▼
Step 2: SkipList 排序
┌─────────────────────────────┐
│      跳表排序索引              │
│                               │
│   对候选集 {A,B,C,F,H,E,D}   │
│   按 activity_score 降序排列   │
│                               │
│   输出: B(95) → D(85) → H(75) │  ← 直接输出 Top 3
│         → C(60) → F(50) → ...│
└───────────┬─────────────────┘
            │
            ▼
Step 3: 回表取数据
┌─────────────────────────────┐
│   从 HASH 中取 B, D, H 的     │
│   完整数据返回给客户端         │
└─────────────────────────────┘
```

> 🔑 **关键理解**：整个过程全部在 Redis 的 C 语言引擎内完成，**没有网络往返、没有 Java 对象创建、没有 GC**。这就是所谓的"降维打击"。

### 3. 手把手实战：从建索引到查询

#### 3.1 准备数据（用普通 HASH 写入）

```bash
# 注意：这里使用普通的 HSET 写入数据
# location 字段格式为 "经度,纬度"（逗号分隔的字符串）
HSET user:A location "116.408,39.918" activity_score 30 nickname "张三" vip_level 0
HSET user:B location "116.398,39.910" activity_score 95 nickname "李四" vip_level 2
HSET user:C location "116.420,39.930" activity_score 60 nickname "王五" vip_level 1
HSET user:D location "116.450,39.950" activity_score 85 nickname "赵六" vip_level 3
HSET user:E location "116.380,39.900" activity_score 10 nickname "孙七" vip_level 0
HSET user:F location "116.410,39.916" activity_score 50 nickname "周八" vip_level 1
HSET user:G location "116.500,39.980" activity_score 90 nickname "吴九" vip_level 2
HSET user:H location "116.390,39.905" activity_score 75 nickname "郑十" vip_level 1
```

#### 3.2 创建索引

```bash
FT.CREATE users_idx                    # 索引名称
  ON HASH                              # 索引 HASH 类型的数据
  PREFIX 1 user:                       # 只索引 Key 前缀为 "user:" 的数据
  SCHEMA                               # 定义索引字段
    location GEO                       # 地理位置字段 → 自动建 Quadtree
    activity_score NUMERIC SORTABLE    # 数值字段 → 自动建 SkipList，支持排序
    nickname TEXT                      # 文本字段 → 自动建倒排索引
    vip_level NUMERIC SORTABLE         # 数值字段 → 自动建 SkipList
```

> 💡 **注意**：`FT.CREATE` 命令执行后，Redis 会**异步扫描已有数据**并自动建立索引。之后新写入的 `user:*` 数据也会被自动索引。

#### 3.3 执行联合查询

```bash
# 查询1：10km 内的用户，按活跃度降序，取前 3 条
FT.SEARCH users_idx
  "@location:[116.404 39.915 10 km]"
  SORTBY activity_score DESC
  LIMIT 0 3

# 返回结果：
# 1) (integer) 7                        ← 总共命中 7 条
# 2) "user:B"                           ← 第1条
# 3) 1) "activity_score" 2) "95" 3) "nickname" 4) "李四" ...
# 4) "user:D"                           ← 第2条
# 5) 1) "activity_score" 2) "85" 3) "nickname" 4) "赵六" ...
# 6) "user:H"                           ← 第3条
# 7) 1) "activity_score" 2) "75" 3) "nickname" 4) "郑十" ...
```

```bash
# 查询2：5km 内 + VIP 等级 ≥ 1 的用户，按活跃度降序
FT.SEARCH users_idx
  "@location:[116.404 39.915 5 km] @vip_level:[1 +inf]"
  SORTBY activity_score DESC
  LIMIT 0 3

# 返回：user:B(VIP2,活跃95) → user:H(VIP1,活跃75) → user:C(VIP1,活跃60)
```

```bash
# 查询3：10km 内 + 昵称包含"六"的用户
FT.SEARCH users_idx
  "@location:[116.404 39.915 10 km] @nickname:六"

# 返回：user:D（赵六）
```

> 🎯 一条命令搞定**地理过滤 + 数值过滤 + 文本搜索 + 排序 + 分页**，这就是 RediSearch 的威力。

### 4. Java 端优雅集成（Redis OM Spring）

手动拼 `FT.SEARCH` 命令太原始了。官方提供了 `redis-om-spring` 库，让你像写 Spring Data JPA 一样操作 RediSearch。

#### 4.1 引入依赖

```xml
<dependency>
    <groupId>com.redis.om</groupId>
    <artifactId>redis-om-spring</artifactId>
    <version>0.9.8</version>
</dependency>
```

#### 4.2 启用 Redis OM

```java
import com.redis.om.spring.annotations.EnableRedisDocumentRepositories;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
@EnableRedisDocumentRepositories(basePackages = "com.example.nearby")
public class NearbyApplication {
    public static void main(String[] args) {
        SpringApplication.run(NearbyApplication.class, args);
    }
}
```

#### 4.3 定义实体与索引

```java
import com.redis.om.spring.annotations.Document;
import com.redis.om.spring.annotations.Indexed;
import com.redis.om.spring.annotations.Searchable;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.geo.Point;

/**
 * 用户画像实体
 *
 * <p>注解说明：
 * - @Document：标记为 Redis 文档，底层存储为 JSON 格式
 * - @Indexed：为字段创建精确匹配/数值/地理索引
 * - @Searchable：为字段创建全文搜索索引（倒排索引）
 */
@Data
@NoArgsConstructor
@RequiredArgsConstructor(staticName = "of")
@Document(value = "user")  // Key 前缀为 "user:"，索引名自动生成
public class UserProfile {

    @Id
    @NonNull
    private String userId;

    /** 地理位置 → 自动建 GEO 索引（Quadtree） */
    @NonNull
    @Indexed
    private Point location;

    /** 活跃度得分 → 自动建 NUMERIC 索引（SkipList） */
    @NonNull
    @Indexed(sortable = true)
    private Double activityScore;

    /** 昵称 → 自动建全文搜索索引（倒排索引） */
    @Searchable
    private String nickname;

    /** VIP 等级 → 自动建 NUMERIC 索引 */
    @Indexed(sortable = true)
    private Integer vipLevel;
}
```

#### 4.4 定义 Repository 接口

```java
import com.redis.om.spring.repository.RedisDocumentRepository;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.geo.Distance;
import org.springframework.data.geo.Point;

/**
 * 用户画像 Repository
 *
 * <p>方法名约定会被 Redis OM 自动翻译为 FT.SEARCH 命令：
 * findByLocationNear → @location:[lon lat radius km]
 * OrderByActivityScoreDesc → SORTBY activity_score DESC
 */
public interface UserProfileRepository
        extends RedisDocumentRepository<UserProfile, String> {

    /**
     * 查询指定范围内的用户，按活跃度降序分页
     * 自动翻译为：FT.SEARCH @location:[...] SORTBY activity_score DESC LIMIT ...
     */
    Page<UserProfile> findByLocationNearOrderByActivityScoreDesc(
            Point point, Distance distance, Pageable pageable);

    /**
     * 查询指定范围内 + VIP 等级大于等于指定值的用户，按活跃度降序分页
     */
    Page<UserProfile> findByLocationNearAndVipLevelGreaterThanEqualOrderByActivityScoreDesc(
            Point point, Distance distance, Integer vipLevel, Pageable pageable);
}
```

#### 4.5 Service & Controller

```java
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.geo.Distance;
import org.springframework.data.geo.Metrics;
import org.springframework.data.geo.Point;
import org.springframework.stereotype.Service;

@Slf4j
@Service
@RequiredArgsConstructor
public class NearbyUserServiceV2 {

    private final UserProfileRepository userProfileRepository;

    /**
     * 使用 RediSearch 原生联合索引查询附近的人
     *
     * <p>对比方案一：
     * - 无需扩大召回
     * - 无需批量查活跃度
     * - 无需内存排序
     * - 一次调用直接拿到全局最优解
     */
    public Page<UserProfile> findNearbyUsers(double lon, double lat,
                                              double radiusKm, int page, int size) {
        Point myLocation = new Point(lon, lat);
        Distance searchRadius = new Distance(radiusKm, Metrics.KILOMETERS);

        return userProfileRepository
                .findByLocationNearOrderByActivityScoreDesc(
                        myLocation, searchRadius, PageRequest.of(page, size));
    }

    /**
     * 带 VIP 过滤的查询
     */
    public Page<UserProfile> findNearbyVipUsers(double lon, double lat,
                                                 double radiusKm, int minVipLevel,
                                                 int page, int size) {
        return userProfileRepository
                .findByLocationNearAndVipLevelGreaterThanEqualOrderByActivityScoreDesc(
                        new Point(lon, lat),
                        new Distance(radiusKm, Metrics.KILOMETERS),
                        minVipLevel,
                        PageRequest.of(page, size));
    }
}
```

```java
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v2/nearby")
@RequiredArgsConstructor
public class NearbyUserControllerV2 {

    private final NearbyUserServiceV2 nearbyUserService;

    @GetMapping("/users")
    public Page<UserProfile> nearby(
            @RequestParam double lon,
            @RequestParam double lat,
            @RequestParam(defaultValue = "10") double radiusKm,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "5") int size) {
        return nearbyUserService.findNearbyUsers(lon, lat, radiusKm, page, size);
    }

    @GetMapping("/vip-users")
    public Page<UserProfile> nearbyVip(
            @RequestParam double lon,
            @RequestParam double lat,
            @RequestParam(defaultValue = "10") double radiusKm,
            @RequestParam(defaultValue = "1") int minVipLevel,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "5") int size) {
        return nearbyUserService.findNearbyVipUsers(
                lon, lat, radiusKm, minVipLevel, page, size);
    }
}
```

### 5. 同样的数据，方案二的查询结果

使用方案二查询 `10km 内按活跃度降序 Top 3`：

| 排名 | 用户 | 距离(km) | 活跃度 | VIP |
|:--|:--|:--|:--|:--|
| 🥇 1 | user:B (李四) | 0.72 | **95** | 2 |
| 🥈 2 | user:D (赵六) | 5.30 | **85** | 3 |
| 🥉 3 | user:H (郑十) | 1.52 | **75** | 1 |

> 🔍 **对比方案一的结果**：
>
> 方案一（距离60% + 活跃度40%）：user:B → user:F → user:H
> 方案二（纯活跃度排序）：      user:B → user:D → user:H
>
> **区别在于**：方案二这里是纯按活跃度排序（`SORTBY activity_score DESC`），user:D 虽然距离远(5.3km)但活跃度高(85)，所以排第二。而方案一的加权公式把距离因素考虑进去了，user:D 被压到了第 6 名。
>
> 如果你也想在方案二中实现加权混合排序，可以在 `HSET` 时预计算一个 `weighted_score` 字段（定时任务更新），或使用 `FT.AGGREGATE` 命令在查询时动态计算（语法稍复杂，但能实现等效的加权打分）。

### 6. 优缺点评估

**✅ 优点：**
- **性能天花板**：全部计算在 Redis C 语言引擎内完成，无网络放大、无 Java GC 压力。
- **代码极其简洁**：从方案一的 100+ 行精排逻辑，缩减到 1 行方法名声明。
- **全局最优解**：不存在"漏斗效应"，所有在范围内的用户都会被考虑。
- **天然支持分页**：`LIMIT offset count` 直接分页，无需在内存中手动截断。

**❌ 缺点：**
- **基础设施门槛**：必须使用 Redis 8.0 或安装 RediSearch 模块的 Redis Stack。传统的云 Redis 实例通常不支持。
- **内存开销更大**：除了数据本身，还要额外存储 Quadtree、SkipList、倒排索引等索引结构，内存占用通常是纯数据的 **2~4 倍**。
- **复杂加权排序受限**：如果需要像方案一那样的多维加权公式，需要借助 `FT.AGGREGATE` + `APPLY` 函数，学习曲线陡峭。

---

## 📝 总结与选型建议

### 方案全维度对比

| 维度 | 方案一：内存精排 (Redis GEO + Java) | 方案二：原生联合索引 (RediSearch) |
|:--|:--|:--|
| **适用场景** | 历史遗留系统、中小并发、排序规则极其复杂多变 | 新项目、高并发、对延迟有极致要求 |
| **基础设施** | 标准 Redis ≥ 3.2 即可 | Redis 8.0 或 Redis Stack |
| **排序灵活度** | ⭐⭐⭐⭐⭐ 想怎么排就怎么排 | ⭐⭐⭐ 简单排序很方便，复杂加权需 FT.AGGREGATE |
| **网络开销** | ❌ 有放大（召回 N×10 倍） | ✅ 精准返回，无放大 |
| **JVM 压力** | ❌ 内存排序 + 对象创建 | ✅ 几乎为零 |
| **全局最优** | ❌ 存在漏斗效应 | ✅ 全量候选 |
| **代码复杂度** | 较高（~150 行核心逻辑） | 极低（~10 行接口声明） |
| **内存占用** | ✅ 只有 GEO + HASH | ❌ 多索引结构，2~4 倍 |

### 一句话总结

> 如果你的系统还是传统的 Redis，用**「扩大召回 + 内存重排」**足以应付 90% 的场景；如果你准备拥抱未来或正在主导架构升级，毫不犹豫地推行 **Redis 8.0 的原生联合索引**，享受底层 C 语言级别的降维打击吧！

### 延伸阅读

- [Redis 官方文档 - GEO 命令](https://redis.io/docs/latest/commands/?group=geo)
- [RediSearch 官方文档](https://redis.io/docs/latest/develop/interact/search-and-query/)
- [Redis OM Spring GitHub](https://github.com/redis/redis-om-spring)
- [Redis 8.0 Release Notes](https://redis.io/blog/redis-8-ga/)
