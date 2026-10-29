# dsh-db-manager 变更记录 v0.13.1（PG 表浏览 DATABASE→SCHEMA 语义修复）

**变更日期**: 2026-09-14
**前置版本**: v0.13
**本文定位**: 修复 PostgreSQL 连接「查看表」查不到表的问题——PG 的 `defaultDatabase`（数据库名）被误当作模式名查询。上一区间见 [CHANGELOG-v0.13-GUI查看表.md](./CHANGELOG-v0.13-GUI查看表.md)。

## 一句话总览

| 项 | 类型 | 主题 | 用户感知 |
|----|------|------|---------|
| 修复 | fix | PG 表浏览 schema 语义 | PostgreSQL 连接点开「查看表」能列出 public 模式下的表（此前为空），MySQL/SQLite 不受影响 |
| 新增测试 | test | `resolvePgSchemaValue` 4 例 | 覆盖空参数/当前库名/显式 schema 的解析 |

## 问题与根因

### 现象

用户报告：PostgreSQL 数据库查询数据表时查不到表；MySQL 正常。PG 能看到多个数据库，连接配置了 `defaultDatabase`（默认连接库），且库下一级还有一层 `public` 模式。

### 根因

PostgreSQL 的层级是 **数据库(database) → 模式(schema) → 表**，比 MySQL（**库 → 表**）多一层：

| MySQL | PostgreSQL |
|-------|-----------|
| `defaultDatabase` = 库名 = 表的直接容器 | `defaultDatabase` = **数据库名**（决定连接绑到哪个库）；表装在模式（缺省 `public`）下 |

原实现把 `defaultDatabase`（= 数据库名 `myapp`）直接作为 `information_schema.tables WHERE table_schema = ?` 的入参 → `WHERE table_schema = 'myapp'` 查不到任何表（表在 `public` 下）→ 空结果。影响 `db_list_tables` / `db_describe_table` 工具与 GUI `tables.list` / `tables.describe` 的 PG 路径。

## 修复方案

在方言收敛点 `src/db/metadata.ts` 的 PG 分支引入 schema 解析：

```ts
resolvePgSchemaValue(database, currentDatabase):
  参数为空 / 等于当前连接数据库名  → 'public'
  否则（显式 schema）             → 按参数查询（向后兼容 db_list_tables { database } 语义）
```

- 新增纯函数 `resolvePgSchemaValue`（可单测）+ `resolvePgSchema(driver, database)`（查 `current_database()`）；
- `listTables` / `describePgsql`（列 / 索引 / DDL 骨架）统一用解析后的 schema；
- MySQL（`TABLE_SCHEMA = ?`）、SQLite（忽略参数）分支不变。

效果：PG 连接 `defaultDatabase='myapp'` → 识别为数据库角色 → 查 `public` 下表；GUI 显示库名 `myapp` 下的表（符合用户"默认连接库看表"直觉）。

## 测试

`tests/pgsql-driver.spec.ts` 新增 `resolvePgSchemaValue` describe（4 例）：空参、当前库名→public、显式非当前 schema 保持原样、库名未知时空参→public。全套 143/143（原 139 + 4）。

## 文件变更清单

| 类型 | 路径 | 说明 |
|------|------|------|
| 代码 | `src/db/metadata.ts` | 新增 `resolvePgSchemaValue` / `resolvePgSchema`；PG `listTables` / `describePgsql` 用解析后的 schema（含 DDL 骨架 schema 名） |
| 测试 | `tests/pgsql-driver.spec.ts` | `resolvePgSchemaValue` 4 例 |
| 文档 | `docs/PROJECT.md` | 变更日志索引追加 v0.13.1 一行 |
| 文档 | `docs/CHANGELOG-v0.13.1-PG表浏览修复.md` | 本文件 |

## 运行验证

| 验证层 | 结果 |
|--------|------|
| `tsc --noEmit` | ✅ |
| vitest 全套 | ✅ 143/143（pgsql-driver 23 例含新增 4） |
| 沙箱构建 | ✅ host 含 `resolvePgSchemaValue` / `current_database` |
| 部署产物核验 | ✅ `lib/db/metadata.js` 哈希与工作区一致 |

## 已知边界

1. **显式 schema 语义保持**：`db_list_tables { database: 'some_schema' }` 仍按传入 schema 查询（不自动回落 public）——文档/工具协议不变。
2. **仅显示一个 schema 的表**：GUI「查看表」固定显示当前连接绑定库的 `public`（或解析出的 schema）下的表；不提供 schema 切换器（守住非目标边界，后续可加）。
3. **DDL 骨架带 schema 前缀**：PG DDL 为 best-effort 重建，现在输出 `CREATE TABLE "public"."t"` 形式。
