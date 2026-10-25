import { describe, expect, test } from 'bun:test';
import { extractInitialState, parseNote } from '@/platforms/xhs/parse';
import { AppError } from '@/core/errors';
import type { MatchResult, RawPayload } from '@/types/platform';

const videoHtml = await Bun.file('tests/fixtures/xhs/note-video.html').text();
const albumHtml = await Bun.file('tests/fixtures/xhs/note-album.html').text();

const input = (id = ''): MatchResult => ({
  platform: 'xhs',
  id,
  kind: 'unknown',
  needsResolve: false,
});
const payload = (body: unknown): RawPayload => ({
  via: 'browser-intercept',
  fetchedAt: 1_700_000_000,
  body,
});

describe('xhs parseNote（真实 HTML fixture 回归）', () => {
  test('视频笔记：h264 masterUrl + 元数据', () => {
    const r = parseNote(payload(videoHtml), input('6aa0343c00000000270173b7'));
    expect(r.platform).toBe('xhs');
    expect(r.id).toBe('6aa0343c00000000270173b7');
    expect(r.kind).toBe('video');
    expect(r.title).toBe('阔直板满阔的，和我满配的！');
    expect(r.author.name).toBe('华为终端');
    expect(r.author.id).toStartWith('59ed510b');
    expect(r.tags).toContain('华为PuraXView');
    expect(r.via).toBe('browser');

    const asset = r.assets[0]!;
    expect(asset.type).toBe('video');
    // masterUrl 原样直链（空 Referer 可下，调研 §1.5）
    expect(asset.url).toContain('sns-video');
    expect(asset.url).toContain('xhscdn.com');
    expect(asset.durationMs).toBe(123008);
    expect(asset.width).toBe(1280);
    expect(asset.height).toBe(720);
    expect(asset.size).toBe(17762548);
    expect(asset.backups).toHaveLength(2);
    expect(asset.coverUrl).toBeTruthy();
  });

  test('图文笔记：全部图片走 WB_DFT 原样直链', () => {
    const r = parseNote(payload(albumHtml), input('6ac016680000000002029db8'));
    expect(r.kind).toBe('album');
    expect(r.title).toBe('好朋友有个随身携带二十多年的阿贝贝');
    expect(r.assets).toHaveLength(2);
    for (const a of r.assets) {
      expect(a.type).toBe('image');
      expect(a.url).toContain('xhscdn.com');
    }
    expect(r.assets[0]!.width).toBe(3024);
    expect(r.assets[0]!.height).toBe(4032);
  });

  test('短链场景：noteId 从 state.currentNoteId 兜底', () => {
    const r = parseNote(payload(videoHtml), input(''));
    expect(r.id).toBe('6aa0343c00000000270173b7');
  });
});

describe('xhs __INITIAL_STATE__ 提取（非法 JSON 处理）', () => {
  test('结构位置裸 undefined → null，字符串内部不替换', () => {
    const html =
      '<script>window.__INITIAL_STATE__ = {"a":undefined,"b":[1,undefined,{"c":undefined}],"s":"value is undefined here"};</script>';
    const state = extractInitialState(html) as {
      a: unknown;
      b: unknown[];
      s: string;
    };
    expect(state.a).toBeNull();
    expect(state.b[0]).toBe(1);
    expect(state.b[1]).toBeNull();
    expect((state.b[2] as { c: unknown }).c).toBeNull();
    expect(state.s).toBe('value is undefined here');
  });

  test('页面无 state：UPSTREAM_CHANGED（空壳页/改版）', () => {
    try {
      parseNote(payload('<html><body>hello</body></html>'), input('x'));
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_CHANGED');
    }
  });

  test('noteDetailMap 无目标笔记 + 安全页特征：RISK_CONTROL', () => {
    const riskHtml =
      '<script>window.__INITIAL_STATE__ = {"note":{"noteDetailMap":undefined,"currentNoteId":"x"}}</script>' +
      '<a href="/website-login/error?error_code=300012">IP at risk</a>';
    try {
      parseNote(payload(riskHtml), input('6aa0343c00000000270173b7'));
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('RISK_CONTROL');
    }
  });

  test('noteDetailMap 无目标笔记 + 干净页面：CONTENT_NOT_FOUND', () => {
    const html =
      '<script>window.__INITIAL_STATE__ = {"note":{"noteDetailMap":undefined,"currentNoteId":"y"}}</script>';
    try {
      parseNote(payload(html), input('6aa0343c00000000270173b7'));
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('CONTENT_NOT_FOUND');
    }
  });

  test('笔记数据为空：CONTENT_NOT_FOUND', () => {
    const html =
      '<script>window.__INITIAL_STATE__ = {"note":{"noteDetailMap":{"6aa0343c00000000270173b7":{"note":undefined}}}}</script>';
    try {
      parseNote(payload(html), input('6aa0343c00000000270173b7'));
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('CONTENT_NOT_FOUND');
    }
  });

  test('视频笔记 stream 全空：UPSTREAM_CHANGED（不许静默返回空数组）', () => {
    const html =
      '<script>window.__INITIAL_STATE__ = {"note":{"noteDetailMap":{"id1":{"note":{"noteId":"id1","type":"video","video":{"media":{"stream":{"h264":[]}}},"imageList":[]}}}}}</script>';
    try {
      parseNote(payload(html), input('id1'));
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_CHANGED');
    }
  });
});
