---
name: maven-code-graph
description: Query Maven dependency JARs — search for classes, get method signatures, find implementations. Like codegraph for your project's external dependencies. Use when you need to know method signatures or class details from compiled Maven libraries.
metadata:
  category: code-intelligence
  triggers:
    - method signature in external dependency
    - what does this interface look like
    - find class in dependency JAR
    - jar 包里有什么方法
    - 看依赖的源码
    - 查外部类的签名
---

# maven-code-graph — Maven 依赖代码图谱

像 codegraph 索引项目源码一样，maven-code-graph 索引当前项目的 Maven 依赖 JAR。

## 前置检查 — CLI 安装

**每次激活本 skill 时，必须先执行以下检测：**

```bash
which maven-code-graph 2>/dev/null || echo "NOT_INSTALLED"
```

如果输出 `NOT_INSTALLED`，自动执行：

```bash
npm install -g maven-code-graph
```

如果已安装，直接跳过。

## 何时使用

- 编码时想知道某个外部依赖类的方法签名
- 想查看接口/抽象类有哪些实现类
- 想确认依赖 JAR 中某个类是否存在
- 想看 `-sources.jar` 中的源码（或 Fernflower 反编译结果）

## 命令

### 首次使用 — 初始化

```bash
maven-code-graph init
```

解析当前项目 pom.xml，索引所有依赖的 JAR。后续 pom.xml 未变化时自动跳过。

### 搜索类

```bash
maven-code-graph search <类名或关键词>
```

返回匹配的类全限定名、类型（class/interface/enum）以及来自哪个 artifact 的哪个版本。

### 查看类详情

```bash
# 方法签名（默认，javap 输出）
maven-code-graph class <全限定类名>

# 完整源码（优先 sources.jar，否则 CFR 反编译）
maven-code-graph class <全限定类名> --type source

# Javadoc
maven-code-graph class <全限定类名> --type docs

# 指定精确 artifact 版本
maven-code-graph class <全限定类名> --coordinate groupId:artifactId:version
```

### 查找实现类

```bash
maven-code-graph implementations <全限定接口/抽象类名>
```

### 查看索引状态

```bash
maven-code-graph status
```

## 注意事项

- 必须在 Maven 项目目录下运行
- 首次 `init` 需要 `mvn` 命令可用
- 索引数据存储在 `~/.maven-codegraph/artifacts.db`（全局共享）+ `.maven-codegraph/state.json`（每项目）
- 项目 pom.xml 变化后，下次命令会自动增量索引

## 反编译（Fernflower）

不少 Maven 依赖自带 `-sources.jar`，不需要反编译。对于没有源码的 JAR，`maven-code-graph` 使用 Fernflower 自动反编译。

Fernflower 需要 JDK 21+。`maven-code-graph` 按以下顺序自动查找：

1. `FERNFLOWER_JAVA` 环境变量（如果有指定路径）
2. IDEA 自带的 JBR（如果已安装 IntelliJ IDEA）
3. 系统 `java`（如果是 JDK 21+）

大多数开发者已安装 IDEA，开箱即用。没有 IDEA 也没有 JDK 21 的用户，可以设置 `FERNFLOWER_JAVA` 指向一个 JDK 21+ 的安装路径：

```bash
export FERNFLOWER_JAVA=/path/to/jdk21/bin/java
```

无源码的 JAR 无法反编译时（约 5% 的依赖），该类的方法索引会缺失，`--type source` 会降级为 javap 签名。
