# maven-code-graph

给你的 AI 编程助手一双看穿 Maven 依赖的眼睛。

## 问题是这样的

AI 帮你在写代码，写到一半需要调一个外部库：

```java
// AI 正在写 OrderService.java
public List<OrderItemDTO> getOrderItems(Long orderId) {
    return paymentService.getOrderItems(orderId, ???);  // ← 第二个参数是什么？
}
```

`paymentService` 来自外部依赖 `payment-api`，不在项目源码里。AI 看不到方法签名，要么停下来，要么猜一个类型——编译炸了再返工。

在 IDE 里 `Ctrl+Click` 一秒解决。但 AI 没有 IDE，它只能：

```bash
grep -rn "PaymentService"   →  找到 import 语句
grep -A2 "payment-api" pom.xml  →  猜 artifact 坐标
find ~/.m2/.../payment-api  →  定位 JAR
unzip -p ...sources.jar ...PaymentService.java  →  提取源码
# 耗时 30 秒+，参数名丢失，没有 Javadoc
```

这已经是最优情况了。更糟的是：**包名和 artifact 坐标之间没有可靠的映射关系**。`com.example.payment.core` 对应的 artifact 可能叫 `payment-api`，也可能叫 `core-lib`。AI 要么在 pom.xml 几十个依赖里盲猜，要么扫 `~/.m2` 下 2000+ 个 JAR，时间膨胀到几分钟。

**AI 编程的效率瓶颈，往往不在 AI 本身，而在它看不到你的依赖。**

---

## 它能做什么

```bash
# 搜一个类
$ maven-code-graph search PaymentService
com.example.payment.core.PaymentService  [interface]
  com.example:payment-api:2.3.1

# 看完整方法签名
$ maven-code-graph class com.example.payment.core.PaymentService

public interface PaymentService {
  Result<List<OrderItemDTO>> getOrderItems(Long orderId, String credential);
  Result<PaymentDTO> getPaymentById(Long paymentId, PaymentQueryParam param);
  ...
}

# 完整源码（含 Javadoc）
$ maven-code-graph class com.example.payment.core.PaymentService --type source

# 查找实现类
$ maven-code-graph implementations com.example.payment.core.PaymentService
```

AI 从 import 到拿到完整方法签名，只需 **0.2 秒**。

---

## 前置依赖

- **Node.js >= 18** — 运行 CLI 所需
- **Maven (`mvn`)** — 依赖解析所需，需要在 `PATH` 中可用
- **JDK 21+** — 仅在 JAR 没有 `-sources.jar` 时需要 Fernflower 反编译。如果已安装 IntelliJ IDEA，其自带 JDK 会被自动检测

## 安装

```bash
npm install -g maven-code-graph
npx skills add auver/maven-code-graph
```

第一步安装 CLI，第二步注册 AI Skill。

---

## 原理

```
maven-code-graph init（首次运行）
  → 读 pom.xml → mvn dependency:build-classpath → 拿到所有 JAR 路径
  → 大多 JAR 自带 -sources.jar → tree-sitter-java 解析源码 → 提取类/方法/继承关系
  → 5% 没有源码 → Fernflower 反编译 → tree-sitter-java 解析
  → 全部存入 SQLite（~/.maven-codegraph/artifacts.db）

每次 AI 查一个类
  → 读 .maven-codegraph/state.json 检查 pom.xml 是否变化
  → FTS5 全文搜索 → 毫秒级返回
  → 优先 sources.jar，其次缓存的反编译结果，最后 javap
```

索引是全局共享的——同一个 JAR 被多个项目依赖时只解析一次。

---

## 对比：AI 有无 maven-code-graph 的区别

```
没有 maven-code-graph，AI 的实际路径：
  → grep import → grep pom.xml 推 artifact → find .m2 定位 JAR → unzip -p 解压
  → 参数名丢失，没有 Javadoc
  → 30 秒起步，打断编码流，版本可能对不上

有 maven-code-graph：
  → import 已经给了全限定名 → maven-code-graph class com.example.PaymentService --type source
  → 0.2 秒，完整源码：参数名、Javadoc、返回值类型全在
```

`maven-code-graph search` 用于探索性场景——不知道类名、想按关键词浏览依赖中有什么。编码时 import 语句就是精确的全限定名，不需要 search。跟 IDE 一个逻辑：你不会先全局搜索再跳转，而是 `Ctrl+Click` 直接到位。

---

## 对 AI 编码意味着什么

maven-code-graph 不是给"人"用的工具——IDE 已经解决了人的问题。它是给 **AI 编码助手**用的基础设施，补上 AI 做后端开发时缺失的关键一环：**不是 AI 不够聪明，是它看不到依赖的代码。**

把它想象成 codegraph 的镜像——codegraph 让 AI 读懂你的项目源码，maven-code-graph 让 AI 读懂你的项目依赖。

---

## 反编译（Fernflower）

很多 Maven 依赖自带 `-sources.jar`，不需要反编译。对于没有源码的 JAR，`maven-code-graph` 使用 Fernflower 自动反编译。

Fernflower 需要 JDK 21+。`maven-code-graph` 按以下顺序自动查找：

1. `FERNFLOWER_JAVA` 环境变量
2. IntelliJ IDEA 自带的 JBR（如果已安装）
3. 系统 `java`（如果是 JDK 21+）

大多数开发者已安装 IDEA，开箱即用。

---

## 常见问题

**Q: 需要装 IDEA 吗？**
A: 不需要。大多依赖自带 `-sources.jar`。没有的需要 Fernflower（JDK 21+），如果装了 IDEA 则自动检测使用其自带的 JDK。

**Q: 首次索引要多久？**
A: 约 2-3 分钟（500+ 依赖）。之后 pom.xml 不变时自动跳过。

**Q: 依赖的 JAR 没源码怎么办？**
A: 索引时跳过该类。查看时降级为 javap 输出方法签名。
