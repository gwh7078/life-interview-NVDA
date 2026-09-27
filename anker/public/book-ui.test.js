import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Book defaults to the newest Story Document and counts included chapters', async () => {
  const { countIncluded, defaultBookItems } = await import('./book-model.js');
  const available = [
    {
      story_id: 'story-a',
      stage_id: 'stage-a',
      documents: [
        { document_id: 'doc-a-v2', version_number: 2 },
        { document_id: 'doc-a-v1', version_number: 1 },
      ],
    },
    { story_id: 'story-b', stage_id: 'stage-b', documents: [{ document_id: 'doc-b-v1', version_number: 1 }] },
    { story_id: 'story-without-document', stage_id: 'stage-b', documents: [] },
  ];

  const items = defaultBookItems(available);
  assert.deepEqual(items.map((item) => [item.story_id, item.document_id, item.sort_order, item.included]), [
    ['story-a', 'doc-a-v2', 0, true],
    ['story-b', 'doc-b-v1', 1, true],
  ]);
  assert.equal(countIncluded(items), 2);
});

test('reopening an existing Book merges new Stories without changing prior selection or order', async () => {
  const { normalizeWorkspace } = await import('./book.js');
  const payload = normalizeWorkspace({
    book: { book_id: 'book-1' },
    items: [
      { story_id: 'story-b', document_id: 'doc-b-v1', included: false, sort_order: 1, stage_id: 'stage-a' },
      { story_id: 'story-a', document_id: 'doc-a-v1', included: true, sort_order: 0, stage_id: 'stage-a' },
    ],
    available_stories: [
      {
        story_id: 'story-a',
        stage_id: 'stage-a',
        documents: [{ document_id: 'doc-a-v2', version_number: 2 }, { document_id: 'doc-a-v1', version_number: 1 }],
      },
      {
        story_id: 'story-b',
        stage_id: 'stage-a',
        documents: [{ document_id: 'doc-b-v2', version_number: 2 }, { document_id: 'doc-b-v1', version_number: 1 }],
      },
      {
        story_id: 'story-c',
        stage_id: 'stage-b',
        documents: [{ document_id: 'doc-c-v2', version_number: 2 }, { document_id: 'doc-c-v1', version_number: 1 }],
      },
    ],
  });

  assert.deepEqual(payload.items.map((item) => [item.story_id, item.document_id, item.included, item.sort_order]), [
    ['story-a', 'doc-a-v1', true, 0],
    ['story-b', 'doc-b-v1', false, 1],
    ['story-c', 'doc-c-v2', true, 2],
  ]);
});

test('Book ordering can move within a Life Stage but never crosses a Life Stage boundary', async () => {
  const { moveBookItem } = await import('./book-model.js');
  const items = [
    { story_id: 'a1', stage_id: 'stage-a', sort_order: 0 },
    { story_id: 'a2', stage_id: 'stage-a', sort_order: 1 },
    { story_id: 'b1', stage_id: 'stage-b', sort_order: 2 },
    { story_id: 'b2', stage_id: 'stage-b', sort_order: 3 },
  ];

  const movedWithinStage = moveBookItem(items, 1, -1);
  assert.deepEqual(movedWithinStage.map((item) => item.story_id), ['a2', 'a1', 'b1', 'b2']);
  assert.deepEqual(movedWithinStage.map((item) => item.sort_order), [0, 1, 2, 3]);
  assert.deepEqual(moveBookItem(movedWithinStage, 1, 1).map((item) => item.story_id), ['a2', 'a1', 'b1', 'b2']);
});
