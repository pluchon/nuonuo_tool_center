import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = resolve('.')
let work: string

// 新建一个内存库并按指定迁移目录迁移
async function migratedDb(folder: string): Promise<PGlite> {
  const pg = await PGlite.create({ extensions: { vector } })
  await pg.exec('CREATE EXTENSION IF NOT EXISTS vector;')
  await migrate(drizzle({ client: pg }), { migrationsFolder: folder })
  return pg
}

// 只保留前 n 个迁移的迁移目录副本
function migrationsUpTo(n: number): string {
  const dir = join(work, `migrations-${n}`)
  cpSync(join(ROOT, 'drizzle'), dir, { recursive: true })
  const journalFile = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'))
  journal.entries = journal.entries.slice(0, n)
  writeFileSync(journalFile, JSON.stringify(journal))
  return dir
}

// 库结构的可比较快照：列、索引、约束、枚举值（与列顺序无关）。
// NOT NULL 约束的名字由 PostgreSQL 自动起，重名时会加后缀，不参与比较；可空性已经在列里比过

async function structure(pg: PGlite): Promise<Record<string, string[]>> {
  const rows = async (sql: string): Promise<string[]> =>
    (await pg.query<{ v: string }>(sql)).rows.map((r) => r.v).sort()
  return {
    columns: await rows(`SELECT table_name || '.' || column_name || ' ' || udt_name || ' ' || is_nullable || ' ' ||
      coalesce(column_default, '') || ' ' || coalesce(is_identity, '') AS v
      FROM information_schema.columns WHERE table_schema = 'public'`),
    indexes: await rows(`SELECT indexdef AS v FROM pg_indexes WHERE schemaname = 'public'`),
    constraints: await rows(`SELECT conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS v
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype <> 'n'`),
    enums: await rows(`SELECT t.typname || ':' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS v
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname`)
  }
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'ltm-migration-'))
})

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('迁移 0001：按画布定稿调整结构', () => {
  it('从 0000 升级后的结构，与按当前 schema.ts 一次生成的结构完全一致', async () => {
    const fullOut = join(work, 'full')
    const config = join(work, 'drizzle.full.config.ts')
    // drizzle-kit 按 glob 找 schema：Windows 反斜杠路径找不到，用相对项目根目录的正斜杠路径
    writeFileSync(
      config,
      `export default { dialect: 'postgresql', schema: './src/main/db/schema.ts', out: ${JSON.stringify(fullOut.replace(/\\/g, '/'))} }\n`
    )
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['drizzle-kit', 'generate', '--config', config, '--name', 'full'], {
      cwd: ROOT,
      stdio: 'pipe',
      shell: process.platform === 'win32'
    })
    const upgraded = await migratedDb(join(ROOT, 'drizzle'))
    const fresh = await migratedDb(fullOut)
    const [a, b] = [await structure(upgraded), await structure(fresh)]
    await upgraded.close()
    await fresh.close()
    // drizzle 自己的迁移记录表在 drizzle schema 里，不在比较范围
    expect(a).toEqual(b)
  })

  it('已有数据按规则转换，不丢数据', async () => {
    const pg = await migratedDb(migrationsUpTo(1))
    await pg.exec(`
      INSERT INTO library_root (name, path, trash_dir) VALUES ('二次元', 'D:\\二次元', 'D:\\二次元\\.ltm-trash');
      INSERT INTO image (content_hash, format, byte_size) VALUES ('h1', 'jpg', 10);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime, status) VALUES (1, 1, 'a.jpg', now(), 'NORMAL'), (1, 1, 'b.jpg', now(), 'TRASHED');
      INSERT INTO tag (name, category) VALUES ('甘雨', 'CHARACTER'), ('原神', 'SERIES'), ('某画师', 'ARTIST'), ('表情包', 'GENERAL'), ('杂项', 'OTHER');
      INSERT INTO file_op_batch (origin, summary, status) VALUES ('USER', 'x', 'APPLIED');
      INSERT INTO file_op (batch_id, seq, op_type, from_path, to_path, content_hash) VALUES
        (1, 1, 'MOVE', 'a', 'b', 'h1'), (1, 2, 'TRASH', 'a', NULL, 'h1'), (1, 3, 'RESTORE', 'a', 'b', 'h1'), (1, 4, 'PURGE', 'a', NULL, 'h1');
    `)
    // 用同一个实例继续迁移到最新，模拟老库升级
    await migrate(drizzle({ client: pg }), { migrationsFolder: join(ROOT, 'drizzle') })

    const one = async <T>(sql: string): Promise<T[]> => (await pg.query<T>(sql)).rows
    expect(await one(`SELECT kind, name, path FROM library_root`)).toEqual([
      { kind: 'SOURCE', name: '二次元', path: 'D:\\二次元' }
    ])
    expect(await one(`SELECT rel_path, status FROM image_file ORDER BY rel_path`)).toEqual([
      { rel_path: 'a.jpg', status: 'NORMAL' },
      { rel_path: 'b.jpg', status: 'DELETED' }
    ])
    expect(await one(`SELECT t.name AS tag, c.name AS category FROM tag t JOIN tag_category c ON c.id = t.category_id ORDER BY t.id`)).toEqual([
      { tag: '甘雨', category: '角色' },
      { tag: '原神', category: '作品' },
      { tag: '某画师', category: '画师' },
      { tag: '表情包', category: '主题' },
      { tag: '杂项', category: '主题' }
    ])
    expect((await one<{ op_type: string }>(`SELECT op_type FROM file_op ORDER BY seq`)).map((r) => r.op_type)).toEqual([
      'MOVE',
      'DELETE',
      'MOVE',
      'DELETE'
    ])
    expect(await one(`SELECT rating, is_r18, taken_at, exif FROM image`)).toEqual([
      { rating: 'UNKNOWN', is_r18: false, taken_at: null, exif: null }
    ])
    expect((await one<{ name: string }>(`SELECT name FROM tag_category ORDER BY sort_order`)).map((r) => r.name)).toEqual([
      '角色',
      '作品',
      '画师',
      '主题',
      '地点',
      '人物',
      '器材',
      '风格'
    ])
    await pg.close()
  })

  it('标签名、别名、分类名按不区分大小写唯一；类目录只能有一条', async () => {
    const pg = await migratedDb(join(ROOT, 'drizzle'))
    await pg.exec(`INSERT INTO tag (name, category_id) VALUES ('Miku', 1)`)
    await expect(pg.exec(`INSERT INTO tag (name, category_id) VALUES ('miku', 1)`)).rejects.toThrow()
    await pg.exec(`INSERT INTO tag_alias (tag_id, name) VALUES (1, 'Hatsune')`)
    await expect(pg.exec(`INSERT INTO tag_alias (tag_id, name) VALUES (1, 'HATSUNE')`)).rejects.toThrow()
    await expect(pg.exec(`INSERT INTO tag_category (name, color_index) VALUES ('角色', 2)`)).rejects.toThrow()
    await pg.exec(`INSERT INTO library_root (kind, name, path) VALUES ('CATEGORY', '诺诺图床', 'D:\\诺诺图床')`)
    await expect(pg.exec(`INSERT INTO library_root (kind, name, path) VALUES ('CATEGORY', 'x', 'E:\\x')`)).rejects.toThrow()
    await expect(pg.exec(`INSERT INTO library_root (name, path) VALUES ('y', 'd:\\诺诺图床')`)).rejects.toThrow()
    await pg.close()
  })
})
