import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBookPdf } from '../src/book/pdf.js';

function utf16Hex(value: string): Buffer {
  const bytes: number[] = [0xfe, 0xff];
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0xfffd;
    if (code <= 0xffff) {
      bytes.push((code >> 8) & 0xff, code & 0xff);
    } else {
      const adjusted = code - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      bytes.push((high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff);
    }
  }
  return Buffer.from(`<${Buffer.from(bytes).toString('hex').toUpperCase()}>`, 'ascii');
}

function countOccurrences(value: string, needle: Buffer): number {
  const token = needle.toString('ascii');
  let count = 0;
  for (let offset = 0; (offset = value.indexOf(token, offset)) !== -1; offset += token.length) count += 1;
  return count;
}

test('renderBookPdf creates a deterministic CJK PDF with cover, directory, chapters, and back cover', () => {
  const first = renderBookPdf({
    bookId: 'pdf-book',
    title: '我的人生书',
    authorName: '周明',
    coverConfig: { style: 'sage' },
    chapters: [
      {
        storyId: 'story-1',
        storyTitle: '第一次独自远行',
        stageId: 'stage-1',
        stageTitle: '青年时期',
        stageSortOrder: 1,
        documentId: 'doc-1',
        documentVersionNumber: 2,
        content: '这是被选中的第二版正文，应该出现在 PDF 中。',
        sortOrder: 0,
      },
    ],
  });
  const second = renderBookPdf({
    bookId: 'pdf-book',
    title: '我的人生书',
    authorName: '周明',
    coverConfig: { style: 'sage' },
    chapters: [
      {
        storyId: 'story-1', storyTitle: '第一次独自远行', stageId: 'stage-1', stageTitle: '青年时期',
        stageSortOrder: 1, documentId: 'doc-1', documentVersionNumber: 2,
        content: '这是被选中的第二版正文，应该出现在 PDF 中。', sortOrder: 0,
      },
    ],
  });
  assert.deepEqual(first, second);
  assert.equal(first.subarray(0, 8).toString('ascii'), '%PDF-1.4');
  const text = first.toString('latin1');
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Type \/Pages/);
  assert.match(text, /\/Subtype \/Type0/);
  assert.match(text, /STSong-Light/);
  assert.ok((text.match(/\/Type \/Page\b/g) ?? []).length >= 4);
});

test('renderBookPdf keeps every included chapter in a directory that can span pages', () => {
  const chapters = Array.from({ length: 45 }, (_, index) => ({
    storyId: `story-${index + 1}`,
    storyTitle: `人生故事 ${index + 1}`,
    stageId: index < 23 ? 'stage-a' : 'stage-b',
    stageTitle: index < 23 ? '早年' : '后来',
    stageSortOrder: index < 23 ? 0 : 1,
    documentId: `document-${index + 1}`,
    documentVersionNumber: 1,
    content: `第 ${index + 1} 章的完整正文。`,
    sortOrder: index,
  }));

  const pdf = renderBookPdf({
    bookId: 'pdf-many-chapters',
    title: '多页目录测试书',
    authorName: '周明',
    coverConfig: { style: 'paper' },
    chapters,
  });
  const pageCount = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
  assert.ok(pageCount >= chapters.length + 4, `目录应至少增加一页，实际页数 ${pageCount}`);
  const pdfText = pdf.toString('ascii');
  const directoryChapterCount = chapters.filter((chapter, index) =>
    pdfText.includes(utf16Hex(`${index + 1}. ${chapter.storyTitle}`).toString('ascii'))).length;
  const bodyChapterCount = chapters.filter((chapter) => countOccurrences(pdfText, utf16Hex(chapter.storyTitle)) >= 1).length;
  assert.equal(directoryChapterCount, chapters.length, '目录章节数必须等于 included Story 数');
  assert.equal(bodyChapterCount, chapters.length, 'PDF 正文章节数必须等于 included Story 数');
  assert.equal(directoryChapterCount, bodyChapterCount);
});
