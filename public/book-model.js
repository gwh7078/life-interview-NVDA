export function defaultBookItems(availableStories) {
  return (Array.isArray(availableStories) ? availableStories : [])
    .filter((story) => Array.isArray(story.documents) && story.documents.length > 0)
    .map((story, index) => ({
      story_id: story.story_id,
      document_id: story.documents[0].document_id,
      included: true,
      sort_order: index,
    }));
}

export function mergeBookItems(persistedItems, availableStories) {
  const persisted = Array.isArray(persistedItems) && persistedItems.length
    ? persistedItems
      .map((item, index) => ({ item: { ...item }, index }))
      .sort((a, b) => Number(a.item.sort_order) - Number(b.item.sort_order) || a.index - b.index)
      .map(({ item }) => item)
    : [];
  if (!persisted.length) return defaultBookItems(availableStories);

  const storyById = new Map((Array.isArray(availableStories) ? availableStories : [])
    .map((story) => [story?.story_id ?? story?.storyId, story]));
  const stageSortOrderForItem = (item) => {
    const story = storyById.get(item?.story_id);
    const value = story?.stage_sort_order ?? story?.stageSortOrder;
    return Number.isFinite(Number(value)) ? Number(value) : Number.POSITIVE_INFINITY;
  };
  const knownStoryIds = new Set(persisted.map((item) => item.story_id));
  for (const item of defaultBookItems(availableStories)) {
    if (knownStoryIds.has(item.story_id)) continue;
    const candidateStageSortOrder = stageSortOrderForItem(item);
    const insertAt = persisted.findIndex((existing) => stageSortOrderForItem(existing) > candidateStageSortOrder);
    if (insertAt === -1) persisted.push({ ...item });
    else persisted.splice(insertAt, 0, { ...item });
    knownStoryIds.add(item.story_id);
  }
  return persisted.map((item, index) => ({ ...item, sort_order: index }));
}

export function countIncluded(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item.included).length;
}

function stageIdForItem(item, availableStories) {
  const directStageId = item?.stage_id ?? item?.stageId;
  if (typeof directStageId === 'string' && directStageId) return directStageId;
  const story = (Array.isArray(availableStories) ? availableStories : [])
    .find((candidate) => candidate?.story_id === item?.story_id || candidate?.storyId === item?.story_id);
  const stageId = story?.stage_id ?? story?.stageId;
  return typeof stageId === 'string' && stageId ? stageId : null;
}

export function canMoveBookItem(items, index, delta, availableStories = []) {
  if (!Array.isArray(items) || !Number.isInteger(index) || !Number.isInteger(delta) || delta === 0) return false;
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return false;
  const currentStageId = stageIdForItem(items[index], availableStories);
  const targetStageId = stageIdForItem(items[target], availableStories);
  return !currentStageId || !targetStageId || currentStageId === targetStageId;
}

export function moveBookItem(items, index, delta, availableStories = []) {
  const next = Array.isArray(items) ? items.map((item) => ({ ...item })) : [];
  if (!canMoveBookItem(next, index, delta, availableStories)) return next;
  const target = index + delta;
  [next[index], next[target]] = [next[target], next[index]];
  return next.map((item, itemIndex) => ({ ...item, sort_order: itemIndex }));
}
