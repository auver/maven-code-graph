# maven-code-graph

Give your AI coding assistant eyes into your Maven dependencies.

[中文版](README_zh.md)

## The Problem

Your AI is writing code and needs to call an external library:

```java
// AI is writing OrderService.java
public List<OrderItemDTO> getOrderItems(Long orderId) {
    return paymentService.getOrderItems(orderId, ???);  // ← what's the second parameter?
}
```

`paymentService` comes from an external dependency `payment-api`, not in the project source. The AI can't see the method signature, so it either stops or guesses a type — and the build breaks.

If you're in an IDE, `Ctrl+Click` solves it instantly. But AI doesn't have an IDE. Its only option is:

```bash
grep -rn "PaymentService"   →  find the import
grep -A2 "payment-api" pom.xml  →  guess the artifact coordinate
find ~/.m2/.../payment-api  →  locate the JAR
unzip -p ...sources.jar ...PaymentService.java  →  extract source
# 30+ seconds later: Result<List<OrderItemDTO>> getOrderItems(Long, String)
# Parameter names lost, no Javadoc
```

Even that's the best case. Worse: **package names and artifact coordinates have no reliable mapping**. `com.example.payment.core` might come from `payment-api`, or `core-lib`, or anything else. The AI has to guess from dozens of pom.xml entries or scan 2000+ JARs in `~/.m2`.

**The AI coding bottleneck isn't the AI — it's that the AI can't see your dependencies.**

---

## What It Does

```bash
# Search for a class
$ maven-code-graph search PaymentService
com.example.payment.core.PaymentService  [interface]
  com.example:payment-api:2.3.1

# See full method signatures
$ maven-code-graph class com.example.payment.core.PaymentService

public interface PaymentService {
  Result<List<OrderItemDTO>> getOrderItems(Long orderId, String credential);
  Result<PaymentDTO> getPaymentById(Long paymentId, PaymentQueryParam param);
  ...
}

# Full source with Javadoc
$ maven-code-graph class com.example.payment.core.PaymentService --type source

# Find implementations
$ maven-code-graph implementations com.example.payment.core.PaymentService
```

The AI goes from import statement to complete method signatures in **0.2 seconds**.

---

## Prerequisites

- **Node.js >= 18** — required to run the CLI
- **Maven (`mvn`)** — required for dependency resolution; must be available on `PATH`
- **JDK 21+** — only needed for Fernflower decompilation, when a dependency JAR doesn't ship with `-sources.jar`. If you have IntelliJ IDEA installed, its bundled JDK is auto-detected

## Install

```bash
npm install -g maven-code-graph
```

Installs the `maven-code-graph` CLI and registers the AI skill automatically.

---

## How It Works

```
maven-code-graph init (first run)
  → reads pom.xml → mvn dependency:build-classpath → gets all JAR paths
  → Most JARs ship with -sources.jar → tree-sitter-java parses source → extracts classes/methods/inheritance
  → 5% have no source → Fernflower decompiles → tree-sitter-java parses
  → stores everything in SQLite (~/.maven-codegraph/artifacts.db)

Every AI lookup
  → checks .maven-codegraph/state.json for pom.xml changes
  → FTS5 full-text search → millisecond response
  → prefers sources.jar, then cached decompiled output, falls back to javap
```

The index is shared globally — the same JAR used by multiple projects is only parsed once.

---

## With vs. Without

```
Without maven-code-graph, the AI's actual path:
  → grep import → grep pom.xml guess artifact → find .m2 locate JAR → unzip -p extract
  → parameter names lost, no Javadoc
  → 30+ seconds, breaks coding flow, version may be wrong

With maven-code-graph:
  → import gives the fully qualified name → maven-code-graph class com.example.PaymentService --type source
  → 0.2 seconds, complete source: parameter names, Javadoc, return types
```

`maven-code-graph search` is for exploratory browsing. For coding, the import statement IS the exact class name — just like `Ctrl+Click` in an IDE.

---

## Decompilation (Fernflower)

Many Maven dependencies ship with `-sources.jar`, no decompilation needed. For those that don't, `maven-code-graph` uses Fernflower automatically.

Fernflower requires JDK 21+. `maven-code-graph` auto-detects in this order:

1. `FERNFLOWER_JAVA` env variable
2. IntelliJ IDEA's bundled JBR (if installed)
3. System `java` (if JDK 21+)

Most developers already have IDEA installed — it works out of the box.

---

## FAQ

**Q: Do I need IntelliJ IDEA?**
A: No. Most dependencies have `-sources.jar` already. Those that don't need Fernflower (JDK 21+), which auto-detects IDEA's bundled JDK if you have it.

**Q: How long does the first index take?**
A: ~2-3 minutes for a typical project. Subsequent runs skip unless pom.xml changes.

**Q: What if a dependency JAR has no source?**
A: The class is skipped during indexing. Lookups fall back to `javap` method signatures.
