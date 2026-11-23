import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { configureFolderOps } from '../../src/main/services/fileOps/folderOpsService'
import { answer, ask, editMessage } from '../../src/main/services/ai/assistantService'
import { chatCall } from '../../src/main/services/ai/bailianClient'
import { decideCategoryProposal, getCategoryProposal, listCategoryPaths, prepareCategoryAction } from '../../src/main/services/ai/categoryProposalService'
import { categoryDirectory } from '../../src/main/services/fileOps/categoryPaths'
import { parseCategoryRequest } from '../../src/main/services/ai/categoryRequest'
import { insertBatch, updateBatchStatus } from '../../src/main/repositories/fileOpRepository'
import { recoverFileOps } from '../../src/main/services/fileOps/fileOpsService'
import { configureTransfer } from '../../src/main/services/fileOps/transferService'
import { insertOrganizeResults } from '../../src/main/repositories/aiResultRepository'
import { listSuggestions, decideSuggestion } from '../../src/main/services/ai/suggestionService'
import { reuseOrganizePaths, sanitizePlan } from '../../src/main/services/ai/organizeService'

vi.mock('electron', () => ({ clipboard: {}, nativeImage: {}, shell: {} }))
vi.mock('../../src/main/services/ai/bailianClient', () => ({ chatCall: vi.fn(() => { throw new Error('目录测试不使用云端') }) }))

const temp = mkdtempSync(join(tmpdir(), 'nono-category-'))
const home = join(temp, 'archive')
const boot = () => openDatabase(join(temp, 'db'), resolve('drizzle'))
async function propose(text: string, scope?: string) {
  const q = await ask({ conversationId: null, text, scope: scope ? { kind: 'category', name: scope } : null, includeR18: false })
  const m = await answer(q.conversation.id)
  expect(m.categoryProposalId).toBeTypeOf('number')
  return { id: m.categoryProposalId!, message: m.id, read: () => getCategoryProposal(m.categoryProposalId!, m.id),
    decide: (apply: boolean) => decideCategoryProposal(m.categoryProposalId!, m.id, apply) }
}

beforeAll(async () => {
  configureFolderOps(home)
  configureTransfer(home)
  await boot()
  mkdirSync(join(home,'A','B','子树'), { recursive: true })
  mkdirSync(join(home,'C','D'), { recursive: true })
  mkdirSync(join(home,'既有','归档标签'), { recursive: true })
  const { pg } = getDatabase()
  await pg.query("insert into library_root(kind,name,path) values ('CATEGORY','类目录',$1)", [home])
  await pg.exec(`
    insert into tag(name,category_id) select '标签'||n, 4 from generate_series(1,100) n;
    insert into tag(name,category_id) values('归档标签',1), ('另一作品',2);
    insert into image(content_hash,format,byte_size) select 'h'||n,'PNG',1 from generate_series(1,103) n;
    insert into image_file(image_id,root_id,rel_path,mtime) select id,1, 'A'||chr(92)||'B'||chr(92)||'子树'||chr(92)||id||'.png', now() from image;
    insert into image_tag(image_id,tag_id,source,status) select n,n,'MANUAL','ACCEPTED' from generate_series(1,101) n;
    insert into image_tag(image_id,tag_id,source,status) values(102,102,'MANUAL','ACCEPTED');
    update image set is_r18=true where id=102;
    insert into image_tag(image_id,tag_id,source,status) values(103,102,'MANUAL','SUGGESTED');
  `)
})
afterAll(async () => { await closeDatabase(); rmSync(temp, { recursive: true, force: true }) })

it('提案保存后、回答显示前退出，重试恢复同一份提案，编辑消息后按新要求处理', async () => {
  const q = await ask({ conversationId: null, text: '请在刚才的位置留个目录', scope: null, includeR18: false })
  const prepared = await prepareCategoryAction({ kind: 'create', path: 'A/草案' }, undefined, q.message.id)
  await closeDatabase()
  await boot()
  expect(await answer(q.conversation.id)).toMatchObject(prepared)
  await editMessage(q.conversation.id, q.message.id, '创建类目录「A/新草案」')
  const replacement = await answer(q.conversation.id)
  expect(replacement.categoryProposalId).not.toBe(prepared.categoryProposalId)
  expect(replacement.text).toContain('新草案')
})

it('模型读取目录后生成提案，确认状态可用于后续追问', async () => {
  vi.stubEnv('DASHSCOPE_API_KEY', 'fixture')
  const call = vi.mocked(chatCall)
  const usage = { inputTokens: 20, outputTokens: 4, cachedTokens: 0, cacheWriteTokens: 0, imageTokens: 0, searchCount: 0 }
  const tool = (name: string, args: object) => call.mockResolvedValueOnce({
    usage, finishReason: 'tool_calls', message: { role: 'assistant', refusal: null, content: null,
      tool_calls: [{ type: 'function', id: name, function: { name, arguments: JSON.stringify(args) } }] }
  })
  try {
    tool('list_category_paths', { prefix: 'C' })
    tool('propose_category_change', { kind: 'create', path: 'C/D/配色' })
    const dto = { conversationId: null, scope: null, includeR18: false }
    const q = await ask({ ...dto, text: '在刚才说的位置给配色留个地方' })
    const reply = await answer(q.conversation.id)
    expect(JSON.stringify(call.mock.calls.at(-1)?.[0].messages.at(-1)?.content)).toContain('D')
    expect(await categoryDirectory(home, 'C/D/配色')).toBeNull()
    await decideCategoryProposal(reply.categoryProposalId!, reply.id, true)
    await ask({ ...dto, conversationId: q.conversation.id, text: '刚才那项已经完成了吗' })
    call.mockResolvedValueOnce({ usage, finishReason: 'stop', message: { role: 'assistant', content: '已经完成。', refusal: null } })
    const receipt = await answer(q.conversation.id)
    expect(call.mock.calls.at(-1)?.[0].requiredTool).toBe('propose_category_change')
    expect(receipt.text).toContain('尚未复制图片')
    expect(JSON.stringify(call.mock.calls.at(-1)?.[0].messages)).toContain('未执行图片归档')
  } finally {
    vi.unstubAllEnvs()
  }
})

it('仅分析新增的已复核图片，跨批复用未确认方案且顶层数有界', async () => {
  const first = await propose('根据已有图片标签规划类目录')
  const plan = await first.read()
  expect(plan.analysisCount).toBe(101)
  expect(plan.entries.find((e) => e.tag === '归档标签')).toMatchObject({ kind: 'existing', path: '既有\\归档标签' })
  expect(new Set(plan.entries.filter((e) => e.kind === 'create').map((e) => e.path.split('\\')[0]))).toEqual(new Set(['主题']))
  expect(await categoryDirectory(home,'主题')).toBeNull()
  expect(await prepareCategoryAction({ kind:'analyze' })).toMatchObject({ categoryProposalId: first.id, text: '没有新增的已标注图片。' })
  await closeDatabase()
  await boot()
  await getDatabase().pg.exec(`
    insert into image(content_hash,format,byte_size) values('new','PNG',1);
    insert into image_file(image_id,root_id,rel_path,mtime) values(104,1,'A/new.png',now());
    insert into image_tag(image_id,tag_id,source,status) values(104,1,'MANUAL','ACCEPTED'),(104,102,'MANUAL','ACCEPTED');
  `)
  const second = await propose('分析新增图片标签创建类目录')
  expect(await second.read()).toMatchObject({ analysisCount: 1, entries:[{ path:'主题\\标签1', tag:'标签1', count:1 }] })
  expect(await second.decide(true)).toMatchObject({ status:'applied' })
  expect(await second.decide(true)).toMatchObject({ status:'applied' })
  expect(await listCategoryPaths('主题')).toContain('主题\\标签1')
  await first.decide(false)
})

it('嵌套子树确认后一次迁移，磁盘文件、档案记录与重启后的提案一致', async () => {
  writeFileSync(join(home,'A','B','子树','1.png'),'fixture')
  const move = await propose('把类目录 A 下的子类目录 B 迁移到类目录 C 的子类目录 D')
  expect((await move.read()).entries).toEqual([{ kind:'move', from:'A\\B', path:'C\\D\\B' }])
  await Promise.all([move.decide(true), move.decide(true)])
  expect(readFileSync(join(home,'C','D','B','子树','1.png'),'utf8')).toBe('fixture')
  expect(await categoryDirectory(home,'A\\B')).toBeNull()
  expect((await getDatabase().pg.query<{ rel_path: string }>('select rel_path from image_file where image_id=1')).rows[0].rel_path).toBe('C\\D\\B\\子树\\1.png')
  await closeDatabase()
  await boot()
  expect(await move.read()).toMatchObject({ status:'applied' })
})

it('拒绝路径越界、自身子树、同名目标、目录联接及已撤回的消息', async () => {
  for (const path of ['../越界', 'D:\\外部', 'a/CON']) await expect(prepareCategoryAction({ kind:'create',path })).rejects.toThrow()
  await expect(prepareCategoryAction({ kind:'move',path:'C',targetParent:'C/D' })).rejects.toThrow()
  mkdirSync(join(home,'A','B'))
  await expect(prepareCategoryAction({ kind:'move',path:'C/D/B',targetParent:'A' })).rejects.toThrow()
  const outside = join(temp,'outside')
  mkdirSync(outside)
  symlinkSync(outside,join(home,'联接'),'junction')
  await expect(prepareCategoryAction({kind:'create',path:'联接/新建'})).rejects.toThrow()
  const proposal = await propose('创建类目录「新建分类」')
  await getDatabase().pg.query('update ai_message set delete_state=1 where id=$1',[proposal.message])
  await expect(proposal.decide(true)).rejects.toThrow('撤回')
  expect(await categoryDirectory(home,'新建分类')).toBeNull()
})

it('磁盘子树移动后进程异常退出，依文件操作日志恢复数据库位置', async () => {
  const from = 'C\\D\\B'
  const to = 'A\\恢复'
  const dir = (await categoryDirectory(home,from))!
  const { db } = getDatabase()
  const batch = await insertBatch(db,'中断测试',[{ opType:'RENAME', imageFileId:null, fromPath:dir.abs,toPath:join(home,to),contentHash:dir.identity }])
  await updateBatchStatus(db,batch,'APPLYING')
  renameSync(dir.abs, join(home,to))
  await closeDatabase()
  await boot()
  await recoverFileOps()
  expect((await getDatabase().pg.query<{rel_path:string}>('select rel_path from image_file where image_id=1')).rows[0].rel_path).toBe('A\\恢复\\子树\\1.png')
})

it('文字限定的子树只分析本目录，选中范围不能扩大，未识别的指令不默认分析全库', async () => {
  const { pg } = getDatabase()
  await pg.exec(`
    insert into image(content_hash,format,byte_size) values('scope-a','PNG',1),('scope-b','PNG',1),('scope-pending','PNG',1);
    insert into image_file(image_id,root_id,rel_path,mtime)
      select id,1,(case when content_hash='scope-b' then 'A/' else 'C/D/' end)||id||'.png',now()
      from image where content_hash like 'scope-%';
    insert into image_tag(image_id,tag_id,source,status)
      select id,102,'MANUAL','ACCEPTED' from image where content_hash like 'scope-%';
    insert into image_ai_result(image_id,kind,model,result,field_status)
      select id,'ORGANIZE','fixture','{}','{"name":"PENDING"}' from image where content_hash='scope-pending';
  `)
  const scoped = await propose('只按 C/D 下图片的标签规划类目录','C')
  expect(await scoped.read()).toMatchObject({scope:'C\\D',analysisCount:1,entries:[{path:'C\\D\\作品\\另一作品',count:1}]})
  await expect(prepareCategoryAction({kind:'analyze',scope:'A'},'C')).rejects.toThrow('超出')
  expect(parseCategoryRequest('只按 A、B 的标签规划类目录')).toBeNull()
  expect(parseCategoryRequest('按风景相册的标签规划类目录')).toBeNull()
  const remaining = await propose('按全部图片标签规划类目录')
  expect(await remaining.read()).toMatchObject({analysisCount:1})
})

it('一键整理优先复用同名嵌套类目录，迁移后采用待审建议复制到新位置', async () => {
  const { pg } = getDatabase()
  const source = join(temp,'源图')
  mkdirSync(source)
  writeFileSync(join(source,'source.png'),'source')
  const root = (await pg.query<{id:number}>("insert into library_root(kind,name,path) values ('SOURCE','原图',$1) returning id",[source])).rows[0].id
  const image = (await pg.query<{id:number}>("insert into image(content_hash,format,byte_size) values($1,'PNG',6) returning id",
    [createHash('sha256').update('source').digest('hex')])).rows[0].id
  await pg.query("insert into image_file(image_id,root_id,rel_path,mtime) values($1,$2,'source.png',now())",[image,root])
  const paths = await listCategoryPaths()
  const plan = sanitizePlan({folders:[{name:'题材',tags:['归档标签']}]},new Set(['归档标签']),paths)
  expect(reuseOrganizePaths(plan,{characters:[],works:[],tags:[['归档标签',1]]},paths))
    .toEqual([{name:'既有\\归档标签',isNew:false,characters:[],works:[],tags:['归档标签']}])
  expect(sanitizePlan({folders:[{name:'既有/归档标签',tags:['归档标签']}]},new Set(['归档标签']),paths)[0].name).toBe('既有\\归档标签')
  await insertOrganizeResults([{imageId:image,dir:'既有\\归档标签',existing:true}],'fixture')
  const move = await propose('把类目录既有下的子目录归档标签迁移到类目录C的子目录D')
  await move.decide(true)
  expect(await listSuggestions(image)).toMatchObject([{kind:'dir',value:'C\\D\\归档标签',isNew:false}])
  await decideSuggestion(image,'dir',true)
  expect(readFileSync(join(home,'C','D','归档标签','source.png'),'utf8')).toBe('source')
  expect(await categoryDirectory(home,'归档标签')).toBeNull()
  expect(await categoryDirectory(home,'既有\\归档标签')).toBeNull()
})

it('追问归档时按上一轮引用的编号和已确认标签复制，检查目标文件和索引后才完成', async () => {
  const { pg } = getDatabase()
  const bytes = Buffer.from('category filing test')
  const hash = createHash('sha256').update(bytes).digest('hex')
  mkdirSync(join(home, '待整理'), {recursive:true})
  mkdirSync(join(home, '标签1'), {recursive:true})
  writeFileSync(join(home, '待整理', '测试.png'), bytes)
  const imageId = Number((await pg.query<{id:number}>("insert into image(content_hash,format,byte_size) values($1,'PNG',$2) returning id",[hash,bytes.length])).rows[0].id)
  await pg.query("insert into image_file(image_id,root_id,rel_path,mtime) values($1,1,$2,now())",[imageId,'待整理\\测试.png'])
  await pg.query("insert into image_tag(image_id,tag_id,source,status) values($1,1,'MANUAL','ACCEPTED')",[imageId])
  // 同标签的其它图片不能进入该次引用。指定既有的唯一目标以覆盖重名标签目录。
  const base = {scope:null,includeR18:false}
  const q = await ask({...base, conversationId:null,text:'这张图有哪些标签', references:[
    {imageId,position:1,name:'',groupId:'gallery:test'}]})
  expect((await answer(q.conversation.id)).text).toContain('标签1')
  const plan = await ask({...base,conversationId:q.conversation.id,text:'创建类目录「归档位置」'})
  const proposal = await answer(plan.conversation.id)
  await decideCategoryProposal(proposal.categoryProposalId!,proposal.id,true)
  vi.stubEnv('DASHSCOPE_API_KEY','fixture')
  try {
    await ask({...base,conversationId:q.conversation.id,text:'把刚刚那个图放进归档位置'})
    vi.mocked(chatCall).mockResolvedValueOnce({
      usage: {inputTokens:20,outputTokens:4,cachedTokens:0,cacheWriteTokens:0,imageTokens:0,searchCount:0},
      finishReason:'tool_calls',message:{role:'assistant',content:null,refusal:null,tool_calls:[
        {type:'function',id:'file',function:{name:'propose_category_change',arguments:JSON.stringify({kind:'file',path:'归档位置'})}}]}
    })
    const reply = await answer(q.conversation.id)
    const id = reply.categoryProposalId!
    expect(await getCategoryProposal(id,reply.id)).toMatchObject({status:'pending',entries:[{kind:'copy',path:'归档位置',count:1}]})
    await pg.query('update image set thumb_ready=1 where id=$1',[imageId])
    expect((await getCategoryProposal(id,reply.id)).filingPreview).toEqual({total:1, hashes:[hash]})
    await pg.query('update image set is_r18=true where id=$1',[imageId])
    expect((await getCategoryProposal(id,reply.id)).filingPreview).toEqual({total:1, hashes:[null]})
    await expect(decideCategoryProposal(id,reply.id,true)).rejects.toThrow('普通图片')
    await pg.query('update image set is_r18=false where id=$1',[imageId])
    await Promise.all([decideCategoryProposal(id,reply.id,true),decideCategoryProposal(id,reply.id,true)])
    expect((await getCategoryProposal(id,reply.id)).filingPreview).toBeUndefined()
    expect(readFileSync(join(home,'归档位置','测试.png'))).toEqual(bytes)
    expect(readFileSync(join(home,'待整理','测试.png'))).toEqual(bytes)
    expect((await pg.query('select id from image_file where image_id=$1 and rel_path=$2',[imageId,'归档位置\\测试.png'])).rows).toHaveLength(1)
  } finally { vi.unstubAllEnvs() }
})
