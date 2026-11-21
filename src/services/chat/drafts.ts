import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import {
  cancelUpload,
  isImage,
  resolveMimeType,
  uploadAttachment,
  validateFiles,
  type UploadTask,
} from '../attachments.js'
import type { FileAttachment } from './types.js'

export type DraftAttachment = {
  /** 本地标识，也是 IndexedDB 原件与上传任务的 key */
  id: string
  file: File
  isImage: boolean
}

type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/**
 * 新对话的待创建选择：会话要等首条消息才会创建，但用户希望在输入框里就先
 * 选好模型与人设。这里先记住选择，创建会话时再落到 Session 上。
 */
export const usePendingSelection = create<{
  personaId: string | null
  modelId: string | null
}>(
  () => ({ personaId: null, modelId: null })
)

export const setPendingPersona = (personaId: string | null) =>
  usePendingSelection.setState({ personaId })

export const setPendingModel = (modelId: string | null) =>
  usePendingSelection.setState({ modelId })

/** 草稿只保存在本次页面的内存中，独立于会话详情缓存；null 是新对话的草稿。 */
export const useDrafts = create<{ drafts: Map<string | null, Draft> }>(() => ({
  drafts: new Map(),
}))

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) =>
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    if (draft.text || draft.attachments.length > 0) {
      drafts.set(sessionId, draft)
    } else {
      drafts.delete(sessionId)
    }
    return { drafts }
  })

export const setDraftText = (sessionId: string | null, text: string) =>
  updateDraft(sessionId, (draft) => ({ ...draft, text }))

/**
 * 当前生效的模型接受哪些输入类型。
 *
 * store 已经 import 本模块，这里反向引用会形成循环依赖，因此由 store 在
 * 模块初始化时注册一个解析函数。未注册（例如纯单元测试）时不限制。
 */
type InputTypeResolver = (sessionId: string | null) => string[] | undefined
let resolveInputTypes: InputTypeResolver | null = null

export const registerInputTypeResolver = (resolver: InputTypeResolver) => {
  resolveInputTypes = resolver
}

const currentInputTypes = (sessionId: string | null): string[] | undefined =>
  resolveInputTypes?.(sessionId)

/**
 * 当前会话生效的模型 id。
 *
 * 上传必须带上它：服务端按模型定位端点，缺省会回落到「默认模型」——默认模型
 * 若是第三方端点而它没有 Files API，上传就 501，界面显示「服务器繁忙」，
 * 附件永远到不了完成态，连纯文字都发不出去。同样是循环依赖，由 store 注册。
 */
type ModelIdResolver = (sessionId: string | null) => string | undefined
let resolveModelId: ModelIdResolver | null = null

export const registerModelIdResolver = (resolver: ModelIdResolver) => {
  resolveModelId = resolver
}

const currentModelId = (sessionId: string | null): string | undefined =>
  resolveModelId?.(sessionId)

const upload = (sessionId: string | null, attachment: DraftAttachment) => {
  // 上传任务负责记录错误，输入框的附件卡片展示失败及重试入口。
  void uploadAttachment(
    attachment.id,
    attachment.file,
    attachment.file.name,
    attachment.isImage,
    currentModelId(sessionId)
  ).catch(() => {})
}

/** 整批校验通过后才加入草稿并开始上传。 */
export const addDraftFiles = (
  sessionId: string | null,
  files: File[]
): TranslationMessage | null => {
  if (files.length === 0) {
    return null
  }
  const error = validateFiles(
    files,
    getDraft(sessionId).attachments.length,
    currentInputTypes(sessionId)
  )
  if (error) {
    return error
  }
  const added = files.map(
    (file): DraftAttachment => ({
      id: createId(),
      file,
      isImage: isImage(resolveMimeType(file)),
    })
  )
  updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...added] }))
  added.forEach((attachment) => upload(sessionId, attachment))
  return null
}

export const retryDraftAttachment = (sessionId: string | null, attachmentId: string) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (attachment) {
    upload(sessionId, attachment)
  }
}

/** 发送按钮和实际提交共用规则：有内容，且全部附件已上传成功。 */
export const prepareDraftMessage = (draft: Draft, tasks: Record<string, UploadTask>) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const files: (FileAttachment & { serverId: string; blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    if (task?.status !== 'done' || !task.serverId) {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: task.serverId,
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      blob: attachment.file,
    })
  }
  return { text, files }
}

export const removeDraftAttachment = (sessionId: string | null, attachmentId: string) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (!attachment) {
    return
  }
  cancelUpload(attachment.id)
  updateDraft(sessionId, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== attachmentId),
  }))
}

/** 发送成功后原件与 serverId 已交给会话，保留上传完成态。 */
export const clearSentDraft = (sessionId: string | null) => {
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

/** 删除会话或替换历史成功后，释放尚未发送的草稿及上传任务。 */
export const clearDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => cancelUpload(attachment.id))
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

export const clearAllDrafts = () => {
  for (const draft of useDrafts.getState().drafts.values()) {
    draft.attachments.forEach((attachment) => cancelUpload(attachment.id))
  }
  useDrafts.setState({ drafts: new Map() })
}
