import { AppError } from '@/core/errors';
import type { MediaAsset, MatchResult, ParsedAuthor, ParseResult } from '@/types/platform';
import type { RawPayload } from '@/types/platform';

/* ---------- __INITIAL_STATE__ 的最小类型视图（字段路径见 docs/research/02 §1.3） ---------- */

interface InfoListItem {
  imageScene?: string;
  url?: string;
}

interface NoteImage {
  width?: number;
  height?: number;
  infoList?: InfoListItem[];
  livePhoto?: boolean;
}

interface VideoStreamItem {
  masterUrl?: string;
  backupUrls?: string[];
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
  videoBitrate?: number;
  streamType?: string;
  qualityType?: string;
}

interface NoteVideo {
  media?: {
    stream?: {
      h264?: VideoStreamItem[];
      h265?: VideoStreamItem[];
      av1?: VideoStreamItem[];
    };
    video?: { duration?: number };
  };
}

interface NoteDetail {
  noteId?: string;
  type?: string;
  title?: string;
  desc?: string;
  time?: number;
  xsecToken?: string;
  user?: { userId?: string; nickname?: string; avatar?: string };
  tagList?: Array<{ name?: string; type?: string }>;
  imageList?: NoteImage[];
  video?: NoteVideo;
  interactInfo?: { likedCount?: string; collectedCount?: string };
}

interface NoteState {
  note?: {
    noteDetailMap?: Record<string, { note?: NoteDetail } | undefined>;
    currentNoteId?: string;
  };
}

/* ---------- __INITIAL_STATE__ 提取 ---------- */

const STATE_RE = /window\.__INITIAL_STATE__\s*=\s*/;

/** 页面里没有 __INITIAL_STATE__ 的信号（内部流转用；由 parseNote 转成业务错误） */
const NO_INITIAL_STATE = Symbol('NO_INITIAL_STATE');

/**
 * 从主文档 HTML 抠出 state 并转成合法 JSON。
 * state 里混有裸 `undefined`（非法 JSON，调研 §1.8 坑 4）；字符串字面量里可能出现
 * "undefined" 字样，所以按 JSON 结构逐段替换，只动结构位置的裸值。
 */
export function extractInitialState(html: string): NoteState {
  const m = html.match(STATE_RE);
  if (!m || m.index === undefined) {
    // 没有 state ≠ 一定是改版：IP 风控/登录墙错误页同样没有（300012），由 parseNote 结合页面特征归类
    throw NO_INITIAL_STATE;
  }
  const start = m.index + m[0].length;
  // 从第一个 `{` 起做字符串感知的括号配对，到配对收尾为止——后面的 `;` 等尾随字符一并剪掉
  const open = html.indexOf('{', start);
  if (open === -1) {
    throw new AppError('UPSTREAM_CHANGED', '__INITIAL_STATE__ 不是对象字面量');
  }
  const slice = braceMatchedSlice(html, open);
  const json = replaceBareUndefined(slice);
  let state: NoteState;
  try {
    state = JSON.parse(json) as NoteState;
  } catch (e) {
    throw new AppError('UPSTREAM_CHANGED', '__INITIAL_STATE__ 不是合法 JSON', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
  return state;
}

/** 从 open 位置的 `{` 起做字符串感知的括号配对，返回含首尾的切片；配对不上抛 UPSTREAM_CHANGED */
function braceMatchedSlice(html: string, open: number): string {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i]!;
    if (inStr) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return html.slice(open, i + 1);
    }
  }
  throw new AppError('UPSTREAM_CHANGED', '__INITIAL_STATE__ 括号不配对（脚本被截断）');
}

/** 只替换 JSON 结构位置的裸 undefined；跳过字符串字面量内部 */
function isUndefinedAt(chars: string[], i: number): boolean {
  if (i + 9 > chars.length) return false;
  return (
    chars[i] === 'u' &&
    chars[i + 1] === 'n' &&
    chars[i + 2] === 'd' &&
    chars[i + 3] === 'e' &&
    chars[i + 4] === 'f' &&
    chars[i + 5] === 'i' &&
    chars[i + 6] === 'n' &&
    chars[i + 7] === 'e' &&
    chars[i + 8] === 'd'
  );
}

function replaceBareUndefined(src: string): string {
  const chars = src.split('');
  let inStr = false;
  let escape = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (inStr) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (isUndefinedAt(chars, i)) {
      chars[i] = 'n';
      chars[i + 1] = 'u';
      chars[i + 2] = 'l';
      chars[i + 3] = 'l';
      for (let k = 4; k < 9; k++) chars[i + k] = '';
    }
  }
  return chars.join('');
}

/* ---------- 纯函数 parse ---------- */

/** WB_DFT = 最佳画质原样直链（调研 §1.4：style 后缀是签名一部分，一个字符不能改） */
function bestImageUrl(img: NoteImage): string | undefined {
  const list = img.infoList ?? [];
  return (list.find((i) => i.imageScene === 'WB_DFT') ?? list[0])?.url;
}

function videoAsset(note: NoteDetail): MediaAsset | null {
  const streams = note.video?.media?.stream;
  const h264 = streams?.h264 ?? [];
  const candidates = h264.length > 0 ? h264 : (streams?.h265 ?? []);
  const best = candidates.find((s) => s.masterUrl);
  if (!best) return null;
  const backups = (best.backupUrls ?? []).filter((u): u is string => !!u);
  return {
    type: 'video',
    url: best.masterUrl!,
    size: best.size,
    width: best.width,
    height: best.height,
    durationMs: best.duration ?? note.video?.media?.video?.duration,
    // 图像列表在视频笔记里是封面/首帧
    coverUrl: note.imageList?.[0] ? bestImageUrl(note.imageList[0]!) : undefined,
    backups: backups.length > 0 ? backups : undefined,
  };
}

function imageAssets(note: NoteDetail): MediaAsset[] {
  return (note.imageList ?? []).map((img) => ({
    type: 'image',
    url: bestImageUrl(img) ?? '',
    width: img.width,
    height: img.height,
  }));
}

function authorOf(note: NoteDetail): ParsedAuthor {
  return {
    name: note.user?.nickname ?? '',
    id: note.user?.userId,
    avatar: note.user?.avatar,
  };
}

function tagsOf(note: NoteDetail): string[] {
  return (note.tagList ?? []).map((t) => t.name).filter((n): n is string => !!n);
}

export function parseNote(raw: RawPayload, input: MatchResult): ParseResult {
  if (raw.via !== 'browser-intercept') {
    throw new AppError('UPSTREAM_CHANGED', `小红书解析收到未知载荷类型: ${raw.via}`);
  }
  const html = raw.body;
  if (typeof html !== 'string') {
    throw new AppError('UPSTREAM_CHANGED', '小红书载荷不是 HTML 文本');
  }
  let state: NoteState;
  try {
    state = extractInitialState(html);
  } catch (err) {
    if (err !== NO_INITIAL_STATE) throw err;
    // IP 风控（error_code=300012 "IP at risk"）/登录墙错误页没有 state，归 RISK_CONTROL 不落 UPSTREAM_CHANGED
    if (isRiskPage(html)) {
      throw new AppError('RISK_CONTROL', '小红书风控拦截（出口 IP 被平台限制或未登录，换网络后重试）', {
        noteId: input.id || undefined,
      });
    }
    throw new AppError('UPSTREAM_CHANGED', '页面里没有 window.__INITIAL_STATE__（可能被改版或落到安全页）');
  }
  const detailMap = state.note?.noteDetailMap ?? {};

  // noteId 优先取 match 结果；短链场景 match 拿不到，由 state.currentNoteId 兜底
  const id = input.id || state.note?.currentNoteId || '';
  const entry = id !== '' ? detailMap[id] : undefined;
  if (!entry) {
    // 登录墙/风控页同样没有 noteDetailMap，先于「笔记不存在」判断
    if (isRiskPage(html)) {
      throw new AppError('RISK_CONTROL', '小红书命中登录墙/风控页', {
        noteId: id || undefined,
      });
    }
    throw new AppError('CONTENT_NOT_FOUND', '笔记不在返回数据中（不存在/已删除/无权查看）', {
      noteId: id || undefined,
    });
  }

  const note = entry.note;
  if (!note) {
    throw new AppError('CONTENT_NOT_FOUND', '笔记数据为空（不存在或已删除）', {
      noteId: id,
    });
  }

  const isVideo = note.type === 'video' && !!note.video?.media?.stream;
  const assets = isVideo ? [videoAsset(note)].filter((a): a is MediaAsset => a !== null) : imageAssets(note);

  if (assets.length === 0 || assets.every((a) => !a.url)) {
    throw new AppError('UPSTREAM_CHANGED', '小红书返回数据中无可下载资源', {
      noteId: id,
      type: note.type,
    });
  }

  const desc = note.desc ?? '';
  return {
    platform: 'xhs',
    id: note.noteId ?? id,
    kind: isVideo ? 'video' : 'album',
    title: (note.title || desc.split('\n')[0] || '').trim(),
    description: desc,
    tags: tagsOf(note),
    author: authorOf(note),
    assets,
    parsedAt: raw.fetchedAt,
    // via 字段如实反映实际通道（HTTP 主通道或浏览器兜底）
    via: raw.channel === 'http' ? 'http' : 'browser',
  };
}

function isRiskPage(html: string): boolean {
  return (
    html.includes('/website-login') ||
    html.includes('error_code=300012') ||
    html.includes('error_code=300031') ||
    html.includes('IP at risk')
  );
}
