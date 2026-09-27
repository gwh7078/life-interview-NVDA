import type { BookRenderModel } from '../repositories/book-repository.js';

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN_X = 64;
const BODY_SIZE = 12;
const BODY_LEADING = 22;

type PdfObject = string | { dictionary: string; stream: Buffer };

const COVER_COLORS: Record<string, { fill: [number, number, number]; ink: [number, number, number] }> = {
  paper: { fill: [0.96, 0.94, 0.88], ink: [0.15, 0.16, 0.13] },
  sage: { fill: [0.25, 0.36, 0.29], ink: [1, 1, 1] },
  rose: { fill: [0.54, 0.31, 0.27], ink: [1, 1, 1] },
};

function utf16Hex(value: string): string {
  const bytes: number[] = [0xfe, 0xff];
  for (const codePoint of value) {
    const code = codePoint.codePointAt(0) ?? 0xfffd;
    if (code <= 0xffff) {
      bytes.push((code >> 8) & 0xff, code & 0xff);
    } else {
      const adjusted = code - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      bytes.push((high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff);
    }
  }
  return `<${Buffer.from(bytes).toString('hex').toUpperCase()}>`;
}

function textWidthUnits(value: string): number {
  let width = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    width += code <= 0x7f ? 1 : 2;
  }
  return width;
}

function wrapParagraph(value: string, maxUnits: number): string[] {
  const paragraphs = String(value || '（暂无正文）').replace(/\r\n?/g, '\n').split('\n');
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let line = '';
    let width = 0;
    for (const character of paragraph) {
      const characterWidth = textWidthUnits(character);
      if (line && width + characterWidth > maxUnits) {
        lines.push(line);
        line = '';
        width = 0;
      }
      line += character;
      width += characterWidth;
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [''];
}

function rgb(values: [number, number, number]): string {
  return `${values[0]} ${values[1]} ${values[2]}`;
}

function textCommand(text: string, x: number, y: number, size: number, color: [number, number, number]): string {
  return `${rgb(color)} rg BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm ${utf16Hex(text)} Tj ET`;
}

function rectangleCommand(color: [number, number, number], x = 0, y = 0, width = PAGE_WIDTH, height = PAGE_HEIGHT): string {
  return `${rgb(color)} rg ${x} ${y} ${width} ${height} re f`;
}

function coverPage(model: BookRenderModel): string[] {
  const colors = COVER_COLORS[model.coverConfig?.style ?? 'paper'] ?? COVER_COLORS.paper!;
  return [
    'q',
    rectangleCommand(colors.fill),
    rectangleCommand(colors.ink, 48, 48, 4, PAGE_HEIGHT - 96),
    textCommand('人生采访局 · 成书', 84, 666, 11, colors.ink),
    textCommand(model.title, 84, 500, 31, colors.ink),
    textCommand(model.authorName, 84, 438, 15, colors.ink),
    textCommand('把人生讲出来，慢慢写下来', 84, 104, 10, colors.ink),
    'Q',
  ];
}

function titlePage(model: BookRenderModel): string[] {
  return [
    textCommand(model.title, MARGIN_X, 600, 29, [0.15, 0.16, 0.13]),
    textCommand(`作者：${model.authorName}`, MARGIN_X, 555, 14, [0.35, 0.39, 0.35]),
    textCommand('这本书由已经完成的故事成稿编排而成。', MARGIN_X, 120, 11, [0.48, 0.5, 0.47]),
  ];
}

function contentsPages(model: BookRenderModel): string[][] {
  const pages: string[][] = [];
  let commands = [textCommand('目录', MARGIN_X, 748, 23, [0.15, 0.16, 0.13])];
  let y = 700;
  let chapterNumber = 1;
  let previousStage = '';
  for (const chapter of model.chapters) {
    const stageChanged = chapter.stageId !== previousStage;
    const requiredHeight = stageChanged ? 25 + 22 : 22;
    if (commands.length > 1 && y - requiredHeight < 78) {
      pages.push(commands);
      commands = [textCommand('目录（续）', MARGIN_X, 748, 23, [0.15, 0.16, 0.13])];
      y = 700;
      previousStage = '';
    }
    if (chapter.stageId !== previousStage) {
      commands.push(textCommand(chapter.stageTitle, MARGIN_X, y, 12, [0.31, 0.39, 0.33]));
      y -= 25;
      previousStage = chapter.stageId;
    }
    commands.push(textCommand(`${chapterNumber}. ${chapter.storyTitle}`, MARGIN_X + 16, y, 11, [0.32, 0.34, 0.31]));
    y -= 22;
    chapterNumber += 1;
  }
  if (model.chapters.length === 0) commands.push(textCommand('暂未收录故事', MARGIN_X, y, 11, [0.5, 0.5, 0.47]));
  pages.push(commands);
  return pages;
}

function chapterPages(model: BookRenderModel): string[][] {
  const pages: string[][] = [];
  for (const chapter of model.chapters) {
    const lines = wrapParagraph(chapter.content, 42);
    let page: string[] = [];
    let y = 748;
    const startChapterPage = () => {
      page = [
        textCommand(chapter.stageTitle, MARGIN_X, 782, 10, [0.43, 0.49, 0.44]),
        textCommand(chapter.storyTitle, MARGIN_X, 742, 22, [0.15, 0.16, 0.13]),
        textCommand(`成稿版本 ${chapter.documentVersionNumber}`, MARGIN_X, 710, 9, [0.55, 0.56, 0.52]),
      ];
      y = 670;
    };
    startChapterPage();
    for (const line of lines) {
      if (y < 70) {
        pages.push(page);
        startChapterPage();
      }
      page.push(textCommand(line || ' ', MARGIN_X, y, BODY_SIZE, [0.24, 0.27, 0.24]));
      y -= BODY_LEADING;
    }
    pages.push(page);
  }
  if (pages.length === 0) pages.push([textCommand('这本书暂未收录故事。', MARGIN_X, 680, BODY_SIZE, [0.35, 0.37, 0.34])]);
  return pages;
}

function backCover(model: BookRenderModel): string[] {
  return [
    rectangleCommand([0.94, 0.93, 0.88]),
    textCommand(model.title, MARGIN_X, 170, 17, [0.25, 0.29, 0.26]),
    textCommand('每一段被记住的人生，都值得好好保存。', MARGIN_X, 132, 11, [0.45, 0.48, 0.44]),
  ];
}

function buildPdf(objects: PdfObject[], rootId: number): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n', 'binary')];
  const offsets: number[] = [0];
  let offset = chunks[0]!.byteLength;
  objects.forEach((object, index) => {
    const body = typeof object === 'string'
      ? Buffer.from(object, 'binary')
      : Buffer.concat([
        Buffer.from(`${object.dictionary}\nstream\n`, 'binary'),
        object.stream,
        Buffer.from('\nendstream', 'binary'),
      ]);
    const wrapped = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'binary'),
      body,
      Buffer.from('\nendobj\n', 'binary'),
    ]);
    offsets.push(offset);
    chunks.push(wrapped);
    offset += wrapped.byteLength;
  });
  const xrefOffset = offset;
  const xref = [`xref`, `0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (let index = 1; index <= objects.length; index += 1) {
    xref.push(`${String(offsets[index]).padStart(10, '0')} 00000 n `);
  }
  xref.push(
    'trailer',
    `<< /Size ${objects.length + 1} /Root ${rootId} 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
  );
  chunks.push(Buffer.from(`${xref.join('\n')}\n`, 'binary'));
  return Buffer.concat(chunks);
}

export function renderBookPdf(model: BookRenderModel): Buffer {
  const pages = [coverPage(model), titlePage(model), ...contentsPages(model), ...chapterPages(model), backCover(model)];
  const objects: PdfObject[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>',
  ];
  const pageIds: number[] = [];
  for (const commands of pages) {
    const stream = Buffer.from(commands.join('\n'), 'binary');
    const contentId = objects.length + 1;
    objects.push({ dictionary: `<< /Length ${stream.byteLength} >>`, stream });
    const pageId = objects.length + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  return buildPdf(objects, 1);
}
