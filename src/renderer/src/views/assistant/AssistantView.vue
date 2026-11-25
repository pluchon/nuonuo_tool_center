<template>
  <div class="assistant" @dragover="overFiles" @drop="dropFiles">
    <section class="assistant__pane" aria-label="诺诺助手">
      <header class="assistant__head">
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" class="assistant__star">
          <defs>
            <linearGradient id="nnStarHead" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
              <stop offset="0" style="stop-color: var(--a-ink)" />
              <stop offset="0.55" style="stop-color: var(--a)" />
              <stop offset="1" style="stop-color: var(--a-mid)" />
            </linearGradient>
          </defs>
          <path :d="starPath" fill="url(#nnStarHead)" />
        </svg>
        <h2 class="assistant__title">{{ title }}</h2>
        <div v-if="store.ready || store.usingGalleryReferences" class="assistant__head-actions">
          <button class="assistant__round" type="button" aria-label="新对话" :disabled="store.waiting || store.changingTurn" @click="onNewChat">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
          </button>
          <button
            class="assistant__round"
            :class="{ 'assistant__round--on': menu === 'hist' }"
            type="button"
            aria-label="对话记录"
            :disabled="store.waiting || store.changingTurn"
            aria-haspopup="dialog"
            :aria-expanded="menu === 'hist'"
            data-ai-menu
            @click="toggleMenu('hist')"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" /></svg>
          </button>
        </div>
      </header>

      <!-- 对话记录：置顶的在前，其余按时间；右键重命名、置顶、删除 -->
      <Transition name="nn-pop">
        <div v-if="menu === 'hist'" class="assistant__hist" role="dialog" aria-label="对话记录" data-ai-menu>
          <span class="assistant__caret assistant__caret--up" aria-hidden="true" />
          <div ref="histList" class="assistant__hist-list nn-thin">
            <span v-if="store.conversations.length === 0" class="assistant__hist-empty">还没有对话</span>
            <template v-for="c in store.conversations" :key="c.id">
              <label v-if="renaming === c.id" class="assistant__rename">
                <span class="assistant__sr">对话名称</span>
                <input
                  ref="renameInput"
                  v-model="renameDraft"
                  class="assistant__rename-input"
                  :maxlength="titleMax"
                  @keydown.enter.prevent="saveRename(c.id)"
                  @keydown.esc.stop="renaming = null"
                  @blur="saveRename(c.id)"
                />
              </label>
              <button
                v-else
                class="assistant__hist-row"
                :class="{ 'assistant__hist-row--on': c.id === store.currentId, 'assistant__hist-row--pinned': c.pinned }"
                type="button"
                @click="openChat(c.id)"
                @contextmenu.prevent="openCtx(c.id, $event)"
              >
                <span class="assistant__hist-title">{{ c.title }}</span>
                <span v-if="c.pinned" class="assistant__pin" aria-label="已置顶">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 4 3v2H6v-2l4-3zM12 15v6" /></svg>
                </span>
                <span class="assistant__hist-when">{{ fmtDay(c.updatedAt) }}</span>
              </button>
            </template>
          </div>
          <Transition name="nn-pop">
            <div v-if="ctx" class="assistant__ctx" role="menu" aria-label="对话操作" :style="{ top: `${ctx.top}px` }">
              <button role="menuitem" class="assistant__mi" type="button" @click="startRename">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>重命名
              </button>
              <button role="menuitem" class="assistant__mi" type="button" @click="ctxPin">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 4 3v2H6v-2l4-3zM12 15v6" /></svg>{{ ctxPinned ? '取消置顶' : '置顶' }}
              </button>
              <span class="assistant__mi-rule" aria-hidden="true" />
              <button role="menuitem" class="assistant__mi assistant__mi--del" type="button" @click="ctxDelete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>删除
              </button>
            </div>
          </Transition>
        </div>
      </Transition>

      <!-- 没配云端凭证：整页只有诺诺出错插画、一句话和重试 -->
      <div v-if="store.ready === false && !store.usingGalleryReferences" class="assistant__nokey">
        <NonoArt pose="error" />
        <span class="assistant__nokey-text">诺诺还没连上云端</span>
        <button class="assistant__nokey-retry" type="button" @click="store.enter()">重试</button>
      </div>

      <template v-else-if="store.ready || store.usingGalleryReferences">
        <div ref="scroller" class="assistant__scroll nn-thin">
          <div class="assistant__thread">
            <!-- 新对话：诺诺插画、一句话、四个示例问题 -->
            <div v-if="isEmpty" class="assistant__welcome nn-appear">
              <NonoArt pose="welcome" size="small" />
              <span class="assistant__welcome-text">想聊什么？说给诺诺听</span>
              <div class="assistant__ideas">
                <button v-for="q in store.ideas" :key="q" class="assistant__idea" type="button" @click="store.send(q)">{{ q }}</button>
              </div>
            </div>

            <template v-for="m in store.messages" :key="m.id">
              <div v-if="m.role === 'user'" class="assistant__user">
                <ImageReferences v-if="m.references?.length" :items="m.references" :previews="previews" />
                <div v-if="m.attachments?.length" class="assistant__attachments">
                  <AttachmentCard v-for="file in m.attachments" :key="file.kind" :file="file" :message-id="m.id" />
                </div>
                <form v-if="editingId === m.id" class="assistant__edit" @submit.prevent="submitEdit(m.id)">
                  <BubbleEditor v-model="editedText" class="assistant__bubble" @keydown.esc.stop="editingId = null" @keydown.ctrl.enter.prevent="submitEdit(m.id, $event)" />
                  <div class="assistant__edit-actions">
                    <button type="button" @click="editingId = null">取消</button>
                    <button type="submit" :disabled="store.changingTurn || store.waiting || (!editedText.trim() && !m.attachments?.length && !m.references?.length)">重新发送</button>
                  </div>
                </form>
                <MarkdownBody v-else-if="m.text" class="assistant__bubble" :text="m.text" />
                <div v-if="m.id === lastQuestion && editingId === null && !store.waiting && !store.loadingMessages" class="assistant__question-tools">
                  <button class="assistant__tool" type="button" aria-label="编辑消息" :disabled="store.changingTurn" @click="editQuestion(m)">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 6.5l4 4M4 20l4.5-1 12-12a2.8 2.8 0 0 0-4-4l-12 12z" /></svg>
                  </button>
                  <button class="assistant__tool" type="button" aria-label="回撤到输入框" :disabled="store.changingTurn" @click="recallQuestion(m.id)">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5-6 6 6 6M3 11h11a6 6 0 0 1 6 6v2" /></svg>
                  </button>
                </div>
              </div>
              <article v-else class="assistant__reply">
                <div v-if="m.how" class="assistant__how">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5" /></svg>
                  <span>{{ m.how }}</span>
                </div>
                <MarkdownBody v-if="m.text && (!m.categoryProposalId || m.proposalNote)" class="assistant__text" :text="m.text" />
                <CategoryProposal v-if="m.categoryProposalId" :proposal-id="m.categoryProposalId" :message-id="m.id" :preview-revision="previewRevision" />
                <SearchResultPages v-if="m.images.length" v-slot="{ pageImages }" :images="m.images">
                  <div class="assistant__pics">
                    <button
                      v-for="p in pageImages"
                      :key="p.imageId"
                      class="assistant__pic"
                      :class="{ 'assistant__pic--on': picked === pickKey(m.id, p.imageId) }"
                      type="button"
                      :style="{ width: `${picWidth(p)}px` }"
                      :aria-label="p.isR18 ? `${p.name}，R-18，双击查看` : p.name"
                      :aria-pressed="picked === pickKey(m.id, p.imageId)"
                      draggable="true"
                      @click="pick(m.id, p.imageId)"
                      @dblclick="openViewer(m.images, p.imageId)"
                      @dragend="releaseReference"
                      @keydown.enter.prevent="openViewer(m.images, p.imageId)"
                      @dragstart="dragOut($event, m, p)"
                    >
                      <img
                        v-if="p.thumb === 'READY'"
                        class="assistant__thumbnail"
                        :class="{ 'assistant__thumbnail--masked': p.isR18 }"
                        :src="thumbUrl(p.hash)"
                        alt=""
                        draggable="false"
                        loading="lazy"
                        decoding="async"
                      />
                      <span v-if="p.isR18" class="assistant__pic-r18" aria-hidden="true">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path :d="lockIcon" /></svg>
                      </span>
                      <span class="assistant__pic-name">{{ p.name }}</span>
                      <span v-if="picked === pickKey(m.id, p.imageId)" class="assistant__pic-check" aria-hidden="true">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                      </span>
                    </button>
                  </div>
                </SearchResultPages>
                <div class="assistant__foot">
                  <button class="assistant__tool" :class="{ 'assistant__tool--ok': copied === m.id }" type="button" :aria-label="copied === m.id ? '已复制' : '复制'" @click="copyText(m)">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="copied === m.id ? checkPath : copyPath" /></svg>
                  </button>
                  <button class="assistant__tool" :class="{ 'assistant__tool--up': m.vote === 'UP' }" type="button" aria-label="有帮助" :aria-pressed="m.vote === 'UP'" @click="store.vote(m.id, 'UP')">
                    <svg width="15" height="15" viewBox="0 0 24 24" :fill="m.vote === 'UP' ? 'var(--a-soft)' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="upPath" /></svg>
                  </button>
                  <button class="assistant__tool" :class="{ 'assistant__tool--down': m.vote === 'DOWN' }" type="button" aria-label="没帮助" :aria-pressed="m.vote === 'DOWN'" @click="store.vote(m.id, 'DOWN')">
                    <svg width="15" height="15" viewBox="0 0 24 24" :fill="m.vote === 'DOWN' ? 'var(--assistant-down-fill)' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="downPath" /></svg>
                  </button>
                  <span class="assistant__cache">
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                      <ellipse cx="10" cy="4.5" rx="6.5" ry="2.5" />
                      <path d="M3.5 4.5v10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-10M3.5 9.5C3.5 10.9 6.4 12 10 12s6.5-1.1 6.5-2.5" />
                    </svg>
                    缓存命中率 {{ cacheRate(m.cacheUsage) }}
                  </span>
                  <time class="assistant__time" :datetime="m.createdAt">{{ fmtDay(m.createdAt) }}</time>
                </div>
              </article>
            </template>

            <!-- 流式输出中的回复 -->
            <article v-if="store.waiting && !store.compacting && store.streamingText" class="assistant__reply assistant__reply--streaming" aria-live="polite">
              <MarkdownBody class="assistant__text" :text="store.streamingText" />
              <span class="assistant__stream-dot" aria-hidden="true" />
            </article>

            <!-- 等待回复：转动的星星和带流光的一行字 -->
            <div v-if="store.waiting && !store.compacting && (!store.streamingText || store.streamingStatus)" class="assistant__busy" role="status">
              <svg class="nn-gem" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <defs>
                  <linearGradient id="nnStarBusy" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
                    <stop offset="0" style="stop-color: var(--a-ink)" />
                    <stop offset="0.55" style="stop-color: var(--a)" />
                    <stop offset="1" style="stop-color: var(--a-mid)" />
                  </linearGradient>
                </defs>
                <path :d="starPath" fill="url(#nnStarBusy)" />
              </svg>
              <span class="nn-shine assistant__busy-text">{{ store.streamingStatus || '诺诺在想…' }}</span>
            </div>

            <!-- 没回复成功：系统横幅，不当成诺诺说的话 -->
            <div v-if="store.failure && !store.waiting" class="assistant__banner" role="alert">
              <div class="assistant__banner-line">
                <span class="assistant__banner-rule" aria-hidden="true" />
                <span class="assistant__banner-text">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01M3 3l18 18" /></svg>{{ store.failure }}
                </span>
                <span class="assistant__banner-rule assistant__banner-rule--r" aria-hidden="true" />
              </div>
              <button class="assistant__retry" type="button" @click="store.fetchReply()">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>重试
              </button>
            </div>
          </div>
        </div>

        <!-- 输入框（参照 Gemini）：大圆角白底，下面一行是范围、R-18 开关和发送 -->
        <div class="assistant__dock">
          <button v-if="showCompact" class="assistant__compact" type="button" :disabled="store.compacting || store.waiting"
            aria-label="精简对话上下文" @mousedown.prevent @click="selectCompact">
            <span class="assistant__compact-ring" :class="{ spinning: store.compacting }" aria-hidden="true"></span>
            <strong>{{ store.compacting ? '正在精简…' : '精简' }}</strong>
            <span>对话上下文（已用 {{ usedPercent }}）</span>
          </button>
          <div class="assistant__composer" :class="{ 'assistant__composer--drop': draggingReference }" @dragover="overReference" @drop="dropReference">
            <Transition name="nn-pop">
              <div v-if="menu === 'dir'" class="assistant__dirs" role="listbox" aria-label="在哪里找" data-ai-menu>
                <span class="assistant__caret assistant__caret--down" aria-hidden="true" />
                <div class="assistant__dirs-list nn-thin">
                  <template v-for="o in dirOptions" :key="o.key">
                    <span v-if="o.head" class="assistant__dirs-head">{{ o.label }}</span>
                    <button
                      v-else
                      role="option"
                      class="assistant__mi"
                      :class="{ 'assistant__mi--on': o.on }"
                      type="button"
                      :aria-selected="o.on"
                      @click="pickScope(o.scope)"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" :stroke="o.ink" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="o.icon" /></svg>
                      <span class="assistant__mi-label">{{ o.label }}</span>
                      <span v-if="o.on" class="assistant__mi-check">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                      </span>
                    </button>
                  </template>
                </div>
              </div>
            </Transition>
            <!-- “+”：往上弹出带尖角的菜单 -->
            <Transition name="nn-pop">
              <div v-if="menu === 'plus'" class="assistant__plus-menu" role="menu" aria-label="添加" data-ai-menu>
                <span class="assistant__caret assistant__caret--down assistant__caret--plus" aria-hidden="true" />
                <button role="menuitem" class="assistant__mi" type="button" @click="pickFile">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l8-8" /></svg>
                  <span class="assistant__mi-label">图片或文件</span><kbd class="assistant__kbd">Ctrl + U</kbd>
                </button>
                <button role="menuitem" class="assistant__mi" type="button" @click="pasteFromClipboard">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6v3H9zM8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /></svg>
                  <span class="assistant__mi-label">粘贴图片</span><kbd class="assistant__kbd">Ctrl + V</kbd>
                </button>
              </div>
            </Transition>
            <input ref="fileRef" class="assistant__file" type="file" accept="image/*,.md,.markdown,text/markdown" multiple @change="onFilePicked" />
            <ImageReferences v-if="store.references.length" :items="store.references" :previews="previews" removable @remove="store.removeReference" />
            <div v-if="store.attachments.length" class="assistant__attachments">
              <AttachmentCard v-for="file in store.attachments" :key="file.kind" class="assistant__attach" :file="file" removable @remove="removeAttachment(file.kind)" />
            </div>
            <MarkdownBody v-if="previewDraft && formattedDraft" class="assistant__draft-preview nn-thin" :text="store.draft" />
            <label v-show="!previewDraft || !formattedDraft" class="assistant__input-wrap">
              <span class="assistant__sr">问诺诺</span>
              <textarea
                ref="inputRef"
                v-model="store.draft"
                class="assistant__input"
                :class="{ 'assistant__input--command': commandSelected }"
                rows="1"
                :placeholder="prediction ? '' : '问问诺诺…'"
                :aria-description="showCompact ? '按 Enter 选择精简命令' : commandSelected ? '按 Enter 执行精简命令' : prediction ? prediction + '，按 Tab 键生效' : undefined"
                :maxlength="textMax"
                @keydown="onInputKey"
                @compositionstart="composing = true"
                @compositionend="composing = false"
                @paste="onPaste"
              />
              <span v-if="prediction" class="assistant__prediction" aria-hidden="true">
                {{ prediction }} <span class="assistant__prediction-key">按 Tab 键生效</span>
              </span>
            </label>
            <div class="assistant__controls">
              <button
                class="assistant__plus"
                :class="{ 'assistant__plus--on': menu === 'plus' }"
                type="button"
                aria-label="添加附件"
                aria-haspopup="menu"
                :aria-expanded="menu === 'plus'"
                data-ai-menu
                @click="toggleMenu('plus')"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              <span class="assistant__vr" aria-hidden="true" />
              <button
                class="assistant__dir"
                :class="{ 'assistant__dir--on': menu === 'dir' }"
                type="button"
                aria-haspopup="listbox"
                :aria-expanded="menu === 'dir'"
                data-ai-menu
                @click="toggleMenu('dir')"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="folderIcon" /></svg>
                <span class="assistant__dir-label">{{ scopeLabel }}</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
              </button>
              <span class="assistant__vr" aria-hidden="true" />
              <button
                class="assistant__r18"
                :class="{ 'assistant__r18--on': store.includeR18 }"
                type="button"
                role="switch"
                :aria-checked="store.includeR18"
                aria-label="包含 R-18"
                @click="store.includeR18 = !store.includeR18"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="lockIcon" /></svg>R-18
                <span class="assistant__switch" aria-hidden="true"><span class="assistant__knob" /></span>
              </button>
              <span class="assistant__vr" aria-hidden="true" />
              <ContextMeter :messages="store.messages" />
              <button v-if="formattedDraft" type="button" class="assistant__md-toggle" :aria-pressed="previewDraft"
                :aria-label="previewDraft ? '继续编辑' : '预览 Markdown'" @click="toggleDraftPreview">MD</button>
              <button class="assistant__send" :class="{ 'assistant__send--on': store.canSend && !reading }" type="button" aria-label="发送" :disabled="!store.canSend || reading" @click="submitComposer">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </button>
            </div>
          </div>
        </div>
      </template>
    </section>
    <ConfirmDialog :open="pendingRecall !== null" title="替换输入框中的草稿？" ok-label="替换" no-label="取消" tone="normal" @cancel="pendingRecall = null" @ok="pendingRecall !== null && recallQuestion(pendingRecall, true)" />
  </div>
</template>

<script lang="ts" src="./AssistantView.ts"></script>
<style lang="scss" scoped src="./AssistantView.scss"></style>
