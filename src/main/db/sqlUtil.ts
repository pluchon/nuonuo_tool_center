import { getTableName, sql, type Column, type SQL } from 'drizzle-orm'

// 带表名的列引用："表"."列"。
// 只查一张表时 Drizzle 渲染列名不带表名；写进关联子查询后，外层的 "id" 会被子查询里同名的列抢走（比如 image_tag.id），
// 结果静默出错。凡是在 sql`` 子查询里引用外层的列，都用它。
export function col(column: Column): SQL {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`
}

// LIKE 里的通配符转义（反斜杠、百分号、下划线）
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}
